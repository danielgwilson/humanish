// Sandbox receipts for `humanish lab preflight`. A probe has no run directory, so it journals its
// sandbox under .humanish/preflight/<probe-id>/ before any work runs in it. A confirmed kill
// removes the journal. A journal that stays means the probe's sandbox may still be running, and
// `humanish reclaim --preflight` kills it by the recorded id.
import { randomBytes } from "node:crypto";
import { readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile,
  type PreparedSelectedOutputDirectory,
} from "./selected-output-paths.js";

const PREFLIGHT_DIR = "preflight";
// Written when the probe finished without confirming its kill: the owner no longer holds the
// sandbox, so reclaim may act even while the owning process lives on.
const ABANDONED_MARKER = "abandoned";
// The owning process id is part of the name, so reclaim can leave a probe that is still running.
const JOURNAL_NAME = /^preflight-(\d+)-[a-z0-9-]+$/;

export interface PreflightJournal {
  id: string;
  /** The process that ran the probe. */
  pid: number;
  root: PreparedSelectedOutputDirectory;
}

/** Create this process's journal directory for one probe. */
export async function openPreflightJournal(cwd: string): Promise<PreflightJournal> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  const id = `preflight-${process.pid}-${stamp}-${randomBytes(4).toString("hex")}`;
  const root = await prepareManagedHumanishOutputDirectory(cwd, PREFLIGHT_DIR, id);
  return { id, pid: process.pid, root };
}

/** Every probe journal left under .humanish/preflight, oldest first. */
export async function listPreflightJournals(cwd: string): Promise<PreflightJournal[]> {
  const parent = await bindExistingManagedHumanishOutputDirectory(cwd, PREFLIGHT_DIR);
  if (!parent) return [];
  const journals: PreflightJournal[] = [];
  const entries = await readdir(parent.physicalPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const match = JOURNAL_NAME.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const root = await bindExistingManagedHumanishOutputDirectory(cwd, PREFLIGHT_DIR, entry.name);
    if (root) journals.push({ id: entry.name, pid: Number(match[1]), root });
  }
  return journals;
}

/** Hand a journal over to reclaim: its probe finished without confirming the kill. */
export async function abandonPreflightJournal(journal: PreflightJournal): Promise<void> {
  await writeContainedOutputFile(journal.root, ABANDONED_MARKER, "", "utf8");
}

/**
 * Whether a probe may still be using its sandbox: the journal is not marked abandoned and the
 * process that opened it is alive on this machine.
 */
export async function preflightInUse(journal: PreflightJournal): Promise<boolean> {
  if ((await readContainedRegularFile(journal.root, ABANDONED_MARKER)) !== null) return false;
  if (journal.pid === process.pid) return true;
  try {
    process.kill(journal.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove a journal whose sandbox is confirmed gone. Only the receipts file and the named files
 * are removed; a directory holding anything else stays, so nothing humanish did not write there
 * is deleted.
 */
export async function discardPreflightJournal(
  journal: PreflightJournal,
  alsoRemove: readonly string[] = [],
): Promise<void> {
  await assertPreparedSelectedOutputDirectory(journal.root);
  for (const name of [SANDBOX_RECEIPTS_ARTIFACT, ABANDONED_MARKER, ...alsoRemove]) {
    await unlink(path.join(journal.root.physicalPath, name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  await rmdir(journal.root.physicalPath);
}
