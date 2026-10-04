// The sandboxes this process is creating for each run directory, and the E2B tags that name the
// directory. A receipt reaches sandbox-receipts.ndjson only after `Sandbox.create` resolves, and
// on @e2b/desktop that is after desktop startup, seconds after E2B has created the sandbox. The
// CLI's signal handler (src/cli/commands/run-signals.ts) uses this registry to cover that window:
// it stops new creates, kills every id a create has reported, and kills each in-flight create's
// sandbox as soon as its id arrives. The tags let `humanish reclaim` find a sandbox whose id
// never reached this process at all.
import { createHash } from "node:crypto";
import path from "node:path";

import type { PreparedOutputRoot } from "./contained-output.js";
import type { SandboxOwnerTags } from "./sandbox-receipts.js";

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
  /** The participant or subject label the receipt also records. */
  participantId: string;
  /** True once the route's own release confirmed the sandbox gone. */
  released: boolean;
}

interface DirectoryCreates {
  stopping: boolean;
  /** The one write of this directory's owner line; every create awaits the same promise. */
  ownerLine?: Promise<void>;
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

/**
 * The E2B metadata that ties a sandbox to the directory that journals it. `runId` is the
 * directory's name: the run id, or a preflight probe's id. `runKey` is a digest of the directory's
 * inode and creation time, so two projects that both use `--run-id smoke` never match each other's
 * sandboxes, and a renamed project directory still matches its own. `tool` is the owner tag every
 * route already sets.
 */
export function sandboxOwnerTags(root: PreparedOutputRoot): SandboxOwnerTags {
  const { where, identity } = identityOf(root);
  const runKey = createHash("sha256")
    .update(`${identity.ino}:${identity.birthtimeNs}`)
    .digest("hex")
    .slice(0, 16);
  return { tool: "humanish", runId: path.basename(where), runKey };
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
): SandboxCreateTicket {
  const directory = directoryFor(root);
  if (directory.stopping) throw new SandboxCreateRefusedError();
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  directory.inFlight.add(done);
  return {
    stopping: () => directory.stopping,
    created(sandboxId) {
      if (directory.created.has(sandboxId)) return;
      const sandbox = { sandboxId, participantId, released: false };
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
 * Run `write` once per directory and return its promise to every caller. Creates that start
 * together then resume in the order they called, so the order they reach the provider does not
 * depend on which file append finishes first. A write that reports failure is forgotten, so the
 * next create tries again.
 */
export function recordSandboxOwnerOnce(
  root: PreparedOutputRoot,
  write: () => Promise<boolean>,
): Promise<void> {
  const directory = directoryFor(root);
  const pending = (directory.ownerLine ??= write().then((written) => {
    if (!written && directory.ownerLine === pending) delete directory.ownerLine;
  }));
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
  };
}
