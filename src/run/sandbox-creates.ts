// The sandboxes this process is creating for each run directory, and the E2B tags that name the
// directory. E2B creates a sandbox before its id reaches this process: on @e2b/desktop the startup
// guard reports the id, and its receipt is written, only once the SDK has the handle, and a
// create from an SDK without the guard reports it when `Sandbox.create` resolves, after desktop
// startup. The CLI's signal handler (src/cli/commands/run-signals.ts) uses this registry to cover
// the window before a receipt lands:
// it stops new creates, kills every id a create has reported, and kills each in-flight create's
// sandbox as soon as its id arrives. The tags let `humanish reclaim` find a sandbox whose id
// never reached this process at all.
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readSync } from "node:fs";
import path from "node:path";

import { createContainedOutputFile, type PreparedOutputRoot } from "./contained-output.js";
import type { SandboxOwnerTags, SandboxProviderId } from "./sandbox-receipts.js";

/** Refuses a sandbox create for a run directory whose process is stopping. */
export class SandboxCreateRefusedError extends Error {
  constructor() {
    super("The run is stopping, so no further sandbox is created.");
    this.name = "SandboxCreateRefusedError";
  }
}

/** One sandbox a create in this process reported, and what its route did with it. */
export interface CreatedSandbox {
  sandboxId: string;
  provider: SandboxProviderId;
  /** The participant or subject label the receipt also records. */
  participantId: string;
  /** True once the route's own release confirmed the sandbox gone. */
  released: boolean;
}

interface DirectoryCreates {
  stopping: boolean;
  /** The one write of this directory's owner line per provider; creates await the same promise. */
  ownerLines: Map<SandboxProviderId, Promise<void>>;
  /** Every provider a create began on, recorded before any id exists. */
  providers: Set<SandboxProviderId>;
  created: Map<string, CreatedSandbox>;
  inFlight: Set<Promise<void>>;
  listeners: Set<(sandbox: CreatedSandbox) => void>;
}

const directories = new Map<string, DirectoryCreates>();
// A process runs one study at a time; the cap only bounds a long-lived library caller, and only
// idle entries count against it.
const MAX_REMEMBERED_DIRECTORIES = 64;

function identityOf(root: PreparedOutputRoot) {
  return "physicalRunRoot" in root
    ? { where: root.physicalRunRoot, identity: root.runRootIdentity }
    : { where: root.physicalPath, identity: root.identity };
}

function directoryKey(root: PreparedOutputRoot): string {
  const { where, identity } = identityOf(root);
  return `${where}\0${identity.dev}:${identity.ino}:${identity.birthtimeNs}`;
}

function directoryFor(root: PreparedOutputRoot): DirectoryCreates {
  const key = directoryKey(root);
  const existing = directories.get(key);
  if (existing !== undefined) return existing;
  const created: DirectoryCreates = {
    stopping: false,
    ownerLines: new Map(),
    providers: new Set(),
    created: new Map(),
    inFlight: new Set(),
    listeners: new Set(),
  };
  directories.set(key, created);
  // Only an idle entry is forgotten: a stopping one keeps refusing creates, and one with a create
  // in flight or a sandbox its route has not released is still needed by the signal handler.
  for (const [oldest, entry] of directories) {
    if (directories.size <= MAX_REMEMBERED_DIRECTORIES) break;
    if (entry === created || !idle(entry)) continue;
    directories.delete(oldest);
  }
  return created;
}

function idle(entry: DirectoryCreates): boolean {
  return (
    !entry.stopping &&
    entry.inFlight.size === 0 &&
    [...entry.created.values()].every((sandbox) => sandbox.released)
  );
}

/** The file in a run directory that holds a run key its launcher chose. */
const OWNER_KEY_FILE = "owner-key";
const OWNER_KEY = /^[0-9a-f]{16}$/;

/**
 * The E2B metadata that ties a sandbox to the directory that journals it. `runId` is the
 * directory's name: the run id, or a preflight probe's id. `runKey` is a digest of the directory's
 * inode and creation time, so two projects that both use `--run-id smoke` never match each other's
 * sandboxes, and a renamed project directory still matches its own. A directory whose run was given
 * a key (pinRunOwnerKey) uses that key instead, so two directories on different machines, a remote
 * run's and its launcher's, name the same sandboxes. `tool` is the owner tag every route already
 * sets.
 */
export function sandboxOwnerTags(root: PreparedOutputRoot): SandboxOwnerTags {
  const { where, identity } = identityOf(root);
  const runKey =
    pinnedOwnerKey(where) ??
    createHash("sha256")
      .update(`${identity.ino}:${identity.birthtimeNs}`)
      .digest("hex")
      .slice(0, 16);
  return { tool: "humanish", runId: path.basename(where), runKey };
}

/**
 * The key pinned in the run directory at `where`, if any. The file is opened without following a
 * link, as every other file in a run directory is; a missing or malformed file pins nothing.
 */
function pinnedOwnerKey(where: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path.join(where, OWNER_KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(64);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const key = buffer.subarray(0, length).toString("utf8").trim();
    return OWNER_KEY.test(key) ? key : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Give a new run directory the run key `key` (16 lowercase hex characters) before it creates any
 * sandbox. The file is created once and never replaced.
 */
export async function pinRunOwnerKey(root: PreparedOutputRoot, key: string): Promise<void> {
  if (!OWNER_KEY.test(key))
    throw new Error("A run's owner key is 16 lowercase hexadecimal characters.");
  await createContainedOutputFile(root, OWNER_KEY_FILE, `${key}\n`);
}

/** A create in progress; the acquire step in src/substrates/e2b/sandbox.ts holds one per create. */
export interface SandboxCreateTicket {
  /** Whether the directory's process has started stopping; checked before each attempt. */
  stopping(): boolean;
  /** The provider reported a sandbox id for this create. Safe to call twice with one id. */
  created(sandboxId: string): void;
  /** The route's release confirmed this sandbox gone. */
  released(sandboxId: string): void;
  /** The create resolved or threw, and its receipt write, if any, has finished. */
  settled(): void;
}

/** Register a create for `root`. Throws SandboxCreateRefusedError once the directory is stopping. */
export function beginSandboxCreate(
  root: PreparedOutputRoot,
  participantId: string,
  provider: SandboxProviderId,
): SandboxCreateTicket {
  const directory = directoryFor(root);
  if (directory.stopping) throw new SandboxCreateRefusedError();
  directory.providers.add(provider);
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  directory.inFlight.add(done);
  return {
    stopping: () => directory.stopping,
    created(sandboxId) {
      if (directory.created.has(sandboxId)) return;
      const sandbox = { sandboxId, provider, participantId, released: false };
      directory.created.set(sandboxId, sandbox);
      for (const listener of directory.listeners) listener(sandbox);
    },
    released(sandboxId) {
      const sandbox = directory.created.get(sandboxId);
      if (sandbox !== undefined) sandbox.released = true;
    },
    settled() {
      directory.inFlight.delete(done);
      settle();
    },
  };
}

/**
 * Run `write` once per directory and provider and return its promise to every caller. Creates that start
 * together then resume in the order they called, so the order they reach the provider does not
 * depend on which file append finishes first. A write that reports failure is forgotten, so the
 * next create tries again.
 */
export function recordSandboxOwnerOnce(
  root: PreparedOutputRoot,
  provider: SandboxProviderId,
  write: () => Promise<boolean>,
): Promise<void> {
  const { ownerLines } = directoryFor(root);
  const existing = ownerLines.get(provider);
  if (existing !== undefined) return existing;
  const pending = write().then((written) => {
    if (!written && ownerLines.get(provider) === pending) ownerLines.delete(provider);
  });
  ownerLines.set(provider, pending);
  return pending;
}

/** What the signal handler holds after stopping a directory's creates. */
export interface StoppedSandboxCreates {
  /**
   * Calls `listener` at once for every sandbox a create has reported so far, then for each one an
   * in-flight create reports later, until the returned function is called.
   */
  watch(listener: (sandbox: CreatedSandbox) => void): () => void;
  /** Resolves once every create that was in flight at the stop has settled. */
  settled: Promise<void>;
  /** How many of those creates have not settled yet. */
  inFlight(): number;
  /** The providers creates began on, including those whose id has not arrived. */
  providers(): ReadonlySet<SandboxProviderId>;
}

/**
 * Stop `root`'s creates: any create that starts from now on is refused. Called synchronously when
 * the signal arrives, before anything is awaited, so no create can slip in after it.
 */
export function stopSandboxCreates(root: PreparedOutputRoot): StoppedSandboxCreates {
  const directory = directoryFor(root);
  directory.stopping = true;
  const pending = [...directory.inFlight];
  return {
    watch(listener) {
      for (const sandbox of directory.created.values()) listener(sandbox);
      directory.listeners.add(listener);
      return () => {
        directory.listeners.delete(listener);
      };
    },
    settled: Promise.all(pending).then(() => undefined),
    inFlight: () => pending.filter((create) => directory.inFlight.has(create)).length,
    providers: () => directory.providers,
  };
}
