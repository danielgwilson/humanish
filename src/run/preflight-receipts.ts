// Sandbox receipts for `humanish study check`. A probe has no run directory, so it journals its
// sandbox under .humanish/preflight/<probe-id>/ before any work runs in it. A confirmed kill
// removes the journal. A journal that stays means the probe's sandbox may still be running, and
// `humanish reclaim --preflight` kills it by the recorded id once it is safe to.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  readContainedRegularFile,
  RUN_ARTIFACT_MAX_BYTES,
  writeContainedOutputFile,
  type ContainedRead,
  type PreparedSelectedOutputDirectory,
} from "./contained-output.js";

const PREFLIGHT_DIR = "preflight";
// Written when the probe finished without confirming its kill: the owner no longer holds the
// sandbox, so reclaim may act even while the owning process lives on.
const ABANDONED_MARKER = "abandoned";
const OWNER_FILE = "owner.json";
const JOURNAL_NAME = /^preflight-\d+-[a-z0-9-]+$/;

/**
 * Who opened a journal. A pid means nothing outside its host and pid namespace (a probe in a
 * container writing to a bind-mounted checkout has a pid the host cannot see), so reclaim trusts
 * a dead pid only when both match its own.
 */
interface PreflightOwner {
  hostname: string;
  /** `pid:[inode]` from /proc/self/ns/pid, where the platform has one. */
  pidNamespace?: string;
  pid: number;
  /** Start time in clock ticks since boot (/proc/<pid>/stat), which tells a reused pid apart. */
  startTicks?: string;
  createdAt: string;
  /** The probe's server-side timeout. */
  leaseMs: number;
}

export interface PreflightJournal {
  id: string;
  root: PreparedSelectedOutputDirectory;
  /** Absent when the owner record is missing or unreadable. */
  owner?: PreflightOwner;
}

function ownerContext(): Pick<PreflightOwner, "hostname" | "pidNamespace"> {
  let pidNamespace: string | undefined;
  try {
    pidNamespace = readlinkSync("/proc/self/ns/pid");
  } catch {
    // No procfs: this platform has no pid namespaces to tell apart.
  }
  return { hostname: hostname(), ...(pidNamespace === undefined ? {} : { pidNamespace }) };
}

/** The process's start ticks; null when procfs says it is gone; undefined without procfs. */
function startTicks(pid: number): string | null | undefined {
  if (!existsSync("/proc/self/stat")) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22; the command name before it is parenthesized and may contain spaces.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Create this process's journal directory for one probe with the given lease. */
export async function openPreflightJournal(
  cwd: string,
  leaseMs: number,
): Promise<PreflightJournal> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  const id = `preflight-${process.pid}-${stamp}-${randomBytes(4).toString("hex")}`;
  const root = await prepareManagedHumanishOutputDirectory(cwd, PREFLIGHT_DIR, id);
  const ticks = startTicks(process.pid);
  const owner: PreflightOwner = {
    ...ownerContext(),
    pid: process.pid,
    ...(typeof ticks === "string" ? { startTicks: ticks } : {}),
    createdAt: new Date().toISOString(),
    leaseMs,
  };
  await writeContainedOutputFile(root, OWNER_FILE, `${JSON.stringify(owner)}\n`, "utf8");
  return { id, root, owner };
}

/** The owner record, or undefined when it is missing, refused or malformed: "missing or unreadable". */
function parseOwner(read: ContainedRead): PreflightOwner | undefined {
  if (read.status !== "read") return undefined;
  try {
    const value = JSON.parse(read.bytes.toString("utf8")) as Partial<PreflightOwner>;
    if (
      typeof value.hostname !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.createdAt !== "string" ||
      typeof value.leaseMs !== "number"
    )
      return undefined;
    return {
      hostname: value.hostname,
      ...(typeof value.pidNamespace === "string" ? { pidNamespace: value.pidNamespace } : {}),
      pid: value.pid,
      ...(typeof value.startTicks === "string" ? { startTicks: value.startTicks } : {}),
      createdAt: value.createdAt,
      leaseMs: value.leaseMs,
    };
  } catch {
    return undefined;
  }
}

/** Every probe journal left under .humanish/preflight, oldest first. */
export async function listPreflightJournals(cwd: string): Promise<PreflightJournal[]> {
  const parent = await bindExistingManagedHumanishOutputDirectory(cwd, PREFLIGHT_DIR);
  if (!parent) return [];
  const journals: PreflightJournal[] = [];
  const entries = await readdir(parent.physicalPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !JOURNAL_NAME.test(entry.name)) continue;
    const root = await bindExistingManagedHumanishOutputDirectory(cwd, PREFLIGHT_DIR, entry.name);
    if (!root) continue;
    const owner = parseOwner(
      await readContainedRegularFile(root, OWNER_FILE, RUN_ARTIFACT_MAX_BYTES),
    );
    journals.push({ id: entry.name, root, ...(owner === undefined ? {} : { owner }) });
  }
  return journals;
}

/** Hand a journal over to reclaim: its probe finished without confirming the kill. */
export async function abandonPreflightJournal(journal: PreflightJournal): Promise<void> {
  await writeContainedOutputFile(journal.root, ABANDONED_MARKER, "", "utf8");
}

/** When the journal's sandboxes are gone by their own timeout, if that can be known. */
function leaseEndsAt(journal: PreflightJournal, receipts: string | null): number | undefined {
  const parsed = receipts === null ? [] : parseSandboxReceipts(receipts);
  if (parsed.length > 0) {
    const ends = parsed.map((receipt) =>
      receipt.timeoutMs === undefined ? Number.NaN : Date.parse(receipt.at) + receipt.timeoutMs,
    );
    if (ends.every(Number.isFinite)) return Math.max(...ends);
  }
  if (journal.owner === undefined) return undefined;
  const created = Date.parse(journal.owner.createdAt);
  return Number.isFinite(created) ? created + journal.owner.leaseMs : undefined;
}

/**
 * Whether reclaim may kill a journal's sandboxes: the journal was abandoned, its lease has fully
 * elapsed, or its owner ran in this host and pid namespace and is gone (or its pid now belongs to
 * another process). Anything else may be a live probe, and the reason says why it was left.
 */
export async function preflightReclaimDecision(
  journal: PreflightJournal,
  nowMs: number,
): Promise<{ reclaim: true } | { reclaim: false; reason: string }> {
  // Only a marker that reads hands the journal over: one refused (a link, say) keeps it.
  const marker = await readContainedRegularFile(
    journal.root,
    ABANDONED_MARKER,
    RUN_ARTIFACT_MAX_BYTES,
  );
  if (marker.status === "read") return { reclaim: true };
  // Refused receipts give no lease, as missing ones do; the owner's lease still decides, and
  // reclaim refuses the unreadable journal before it kills anything.
  const receipts = await readContainedRegularFile(
    journal.root,
    SANDBOX_RECEIPTS_ARTIFACT,
    RUN_ARTIFACT_MAX_BYTES,
  );
  const endsAt = leaseEndsAt(
    journal,
    receipts.status === "read" ? receipts.bytes.toString("utf8") : null,
  );
  if (endsAt !== undefined && nowMs > endsAt) return { reclaim: true };
  const until = endsAt === undefined ? "" : `; its lease ends at ${new Date(endsAt).toISOString()}`;
  const owner = journal.owner;
  if (owner === undefined)
    return { reclaim: false, reason: `its owner record is missing or unreadable${until}` };
  const here = ownerContext();
  if (owner.hostname !== here.hostname || owner.pidNamespace !== here.pidNamespace)
    return {
      reclaim: false,
      reason: `it was opened on host ${owner.hostname} in another host or pid namespace, where this process cannot see whether it is still running${until}`,
    };
  const running = `process ${owner.pid} is still running${until}`;
  if (owner.pid === process.pid) return { reclaim: false, reason: running };
  const ticks = startTicks(owner.pid);
  if (ticks === null) return { reclaim: true };
  if (typeof ticks === "string") {
    // The pid now belongs to a different process: the owner is gone.
    return owner.startTicks !== undefined && ticks !== owner.startTicks
      ? { reclaim: true }
      : { reclaim: false, reason: running };
  }
  try {
    process.kill(owner.pid, 0);
    return { reclaim: false, reason: running };
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
      ? { reclaim: false, reason: running }
      : { reclaim: true };
  }
}

/**
 * Remove a journal whose sandbox is confirmed gone. Only the files humanish writes there and the
 * named files are removed; a directory holding anything else stays.
 */
export async function discardPreflightJournal(
  journal: PreflightJournal,
  alsoRemove: readonly string[] = [],
): Promise<void> {
  await assertPreparedSelectedOutputDirectory(journal.root);
  for (const name of [SANDBOX_RECEIPTS_ARTIFACT, ABANDONED_MARKER, OWNER_FILE, ...alsoRemove]) {
    await unlink(path.join(journal.root.physicalPath, name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  await rmdir(journal.root.physicalPath);
}
