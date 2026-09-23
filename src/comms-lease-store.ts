/** Private cleanup authority. Never read this state from a run or an exported bundle. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { ReceivingIdentity, ReceivingLease } from "./comms-receiving-types.js";

const SCHEMA = "humanish.comms-lease-journal.v1";
const MAX_BYTES = 1_048_576;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const CONNECTION = /^[a-z][a-z0-9-]{0,47}$/;
const KEY_ENV = /^[A-Z][A-Z0-9_]{0,99}$/;
type PhysicalIdentity = { path: string; dev: number; ino: number };
type Owner = { pid: number; host: string; token: string; active: boolean };
export type CommsLeaseState = "planned" | "intent" | "active" | "closing" | "not-created" | "absent" | "deleting" | "unresolved";
export interface CommsLeaseRecord {
  participantId: string;
  leaseId: string;
  clientId: string;
  ownership: "fresh";
  state: CommsLeaseState;
  lease?: ReceivingLease;
}
export interface CommsLeaseJournal {
  schema: typeof SCHEMA;
  project: PhysicalIdentity;
  runId: string;
  incarnation: string;
  connectionName: string;
  apiKeyEnv: string;
  identity: ReceivingIdentity;
  owner: Owner;
  state: "active" | "closed" | "unresolved";
  createdAt: string;
  updatedAt: string;
  leases: CommsLeaseRecord[];
}
export interface CommsRecoveryEntry {
  id: string;
  runId: string;
  connectionName: string;
  status: "active" | "closed" | "unresolved";
  participantCount: number;
  unresolvedCount: number;
  activeOwner: boolean | null;
}
export class CommsAuthorityError extends Error {
  constructor(readonly code: "authority_unavailable" | "authority_changed" | "owner_active" | "owner_unknown" | "binding_mismatch") {
    super(code === "owner_active" ? "Communications cleanup is owned by a live process."
      : code === "owner_unknown" ? "Communications cleanup ownership cannot be established."
        : code === "binding_mismatch" ? "Communications recovery does not match the recorded project, connection or account."
          : "Communications authority is unavailable or changed. Inspect private local state before retrying.");
    this.name = "CommsAuthorityError";
  }
}
function fail(code: CommsAuthorityError["code"] = "authority_unavailable"): never { throw new CommsAuthorityError(code); }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeString = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const owned = (uid: number): boolean => !process.getuid || uid === process.getuid();
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const samePhysical = (a: PhysicalIdentity, b: PhysicalIdentity): boolean => a.path === b.path && a.dev === b.dev && a.ino === b.ino;

export function sameReceivingIdentity(a: ReceivingIdentity, b: ReceivingIdentity): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.scopeType === b.scopeType && a.scopeId === b.scopeId;
}
export function validReceivingIdentity(value: unknown): value is ReceivingIdentity {
  return plain(value) && value.provider === "agentmail" && safeString(value.accountId)
    && ["organization", "pod", "inbox"].includes(String(value.scopeType)) && safeString(value.scopeId);
}
export function validReceivingLease(value: unknown, clientId: string): value is ReceivingLease {
  return plain(value) && value.clientId === clientId && safeString(value.resourceId)
    && safeString(value.address, 320) && /^[^\s@]+@[^\s@]+$/.test(value.address);
}

async function physicalProject(cwd: string): Promise<PhysicalIdentity> {
  const resolved = await realpath(path.resolve(cwd));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
  return { path: resolved, dev: info.dev, ino: info.ino };
}
function ownerLiveness(owner: Owner): boolean | null {
  if (!owner.active) return false;
  if (owner.host !== hostname()) return null;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
}
function validateOwner(value: unknown): value is Owner {
  return plain(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
    && safeString(value.host) && typeof value.token === "string" && UUID.test(value.token) && typeof value.active === "boolean";
}
function parseJournal(text: string): CommsLeaseJournal {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(); }
  if (!plain(value) || value.schema !== SCHEMA || !plain(value.project) || !safeString(value.project.path, 4096)
    || !path.isAbsolute(value.project.path) || !Number.isSafeInteger(value.project.dev) || !Number.isSafeInteger(value.project.ino)
    || typeof value.runId !== "string" || !LOCAL_ID.test(value.runId)
    || typeof value.incarnation !== "string" || !UUID.test(value.incarnation)
    || typeof value.connectionName !== "string" || !CONNECTION.test(value.connectionName)
    || typeof value.apiKeyEnv !== "string" || !KEY_ENV.test(value.apiKeyEnv)
    || !validReceivingIdentity(value.identity) || !validateOwner(value.owner)
    || !["active", "closed", "unresolved"].includes(String(value.state))
    || !safeString(value.createdAt) || !safeString(value.updatedAt)
    || !Array.isArray(value.leases) || value.leases.length < 1 || value.leases.length > 64) fail();
  const participants = new Set<string>();
  const leaseIds = new Set<string>();
  const resources = new Set<string>();
  for (const item of value.leases) {
    if (!plain(item) || typeof item.participantId !== "string" || !LOCAL_ID.test(item.participantId)
      || participants.has(item.participantId) || typeof item.leaseId !== "string" || !UUID.test(item.leaseId)
      || leaseIds.has(item.leaseId) || item.ownership !== "fresh"
      || item.clientId !== `humanish-${value.incarnation}-${item.leaseId}`
      || !["planned", "intent", "active", "closing", "not-created", "absent", "deleting", "unresolved"].includes(String(item.state))) fail();
    if (item.lease !== undefined) {
      if (!validReceivingLease(item.lease, item.clientId as string) || resources.has(item.lease.resourceId)
        || item.state === "planned" || item.state === "not-created") fail();
      resources.add(item.lease.resourceId);
    } else if (["active", "deleting", "absent"].includes(String(item.state))) fail();
    participants.add(item.participantId);
    leaseIds.add(item.leaseId);
  }
  return value as unknown as CommsLeaseJournal;
}

/** Pin every existing path component; never follow a symlink into operator authority. */
async function bindStateDirectory(directory: string, create: boolean): Promise<PhysicalIdentity[] | null> {
  const target = path.resolve(directory);
  const components = target.slice(path.parse(target).root.length).split(path.sep).filter(Boolean);
  let cursor = path.parse(target).root;
  const identities: PhysicalIdentity[] = [];
  for (const component of components) {
    cursor = path.join(cursor, component);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return null;
      await mkdir(cursor, { mode: 0o700 });
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    identities.push({ path: cursor, dev: info.dev, ino: info.ino });
  }
  const last = await lstat(target);
  if (!owned(last.uid) || (last.mode & 0o077) !== 0) fail();
  return identities;
}
function defaultStateDir(): string {
  const env = process.env.XDG_STATE_HOME?.trim();
  return path.join(env && path.isAbsolute(env) ? env : path.join(homedir(), ".local", "state"), "humanish", "comms");
}
class AuthorityDirectory {
  constructor(readonly project: PhysicalIdentity, readonly root: string, private readonly components: PhysicalIdentity[]) {}
  async assert(): Promise<void> {
    if (!samePhysical(this.project, await physicalProject(this.project.path))) fail("authority_changed");
    for (const bound of this.components) {
      const info = await lstat(bound.path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== bound.dev || info.ino !== bound.ino) fail("authority_changed");
    }
    const info = await lstat(this.root);
    if (!owned(info.uid) || (info.mode & 0o077) !== 0) fail("authority_changed");
  }
  name(runId: string): string { return `run-${digest(`${this.project.path}\n${this.project.dev}:${this.project.ino}\n${runId}`)}.json`; }
  async read(name: string): Promise<string | null> {
    await this.assert();
    let handle;
    try { handle = await open(path.join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || !owned(info.uid) || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) fail();
      const bytes = await handle.readFile();
      const current = await lstat(path.join(this.root, name));
      if (current.dev !== info.dev || current.ino !== info.ino || bytes.length > MAX_BYTES) fail("authority_changed");
      await this.assert();
      return bytes.toString("utf8");
    } finally { await handle.close(); }
  }
  async sync(): Promise<void> {
    const dir = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  }
}
async function authority(cwd: string, stateDir: string | undefined, create: boolean): Promise<AuthorityDirectory | null> {
  const project = await physicalProject(cwd);
  const root = path.resolve(stateDir ?? defaultStateDir());
  // An explicit test/operator override still cannot turn project artifacts into authority.
  const relative = path.relative(project.path, root);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) fail();
  const components = await bindStateDirectory(root, create);
  return components ? new AuthorityDirectory(project, root, components) : null;
}

type Lock = { owner: Owner; dev: number; ino: number; name: string };
async function takeLock(dir: AuthorityDirectory, name: string, takeover: boolean): Promise<Lock> {
  if (takeover) {
    // Serialize stale-lock replacement. An interrupted takeover guard is intentionally not
    // guessed away: unlike a live run lock, it can be between unlink and exclusive creation.
    const guardName = `${name}.takeover`;
    await dir.assert();
    let guard;
    try { guard = await open(path.join(dir.root, guardName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { return fail("owner_unknown"); }
    const identity = await guard.stat();
    try { return await takeLockInner(dir, name, true); }
    finally {
      await guard.close();
      await dir.assert();
      const current = await lstat(path.join(dir.root, guardName));
      if (current.dev !== identity.dev || current.ino !== identity.ino) fail("authority_changed");
      await unlink(path.join(dir.root, guardName));
    }
  }
  return takeLockInner(dir, name, false);
}
async function takeLockInner(dir: AuthorityDirectory, name: string, takeover: boolean): Promise<Lock> {
  const lockName = `${name}.lock`;
  await dir.assert();
  const previous = await dir.read(lockName);
  if (previous !== null) {
    let owner: unknown;
    try { owner = JSON.parse(previous); } catch { return fail("owner_unknown"); }
    if (!validateOwner(owner)) fail("owner_unknown");
    const live = ownerLiveness(owner);
    if (live === true) fail("owner_active");
    if (live === null || !takeover) fail("owner_unknown");
    // Compare exact bytes immediately before removing a dead owner's lock.
    if (await dir.read(lockName) !== previous) fail("authority_changed");
    await unlink(path.join(dir.root, lockName));
  }
  const owner: Owner = { pid: process.pid, host: hostname(), token: randomUUID(), active: true };
  const file = await open(path.join(dir.root, lockName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(owner));
    await file.sync();
    const info = await file.stat();
    await dir.sync();
    return { owner, dev: info.dev, ino: info.ino, name: lockName };
  } finally { await file.close(); }
}

export class CommsLeaseStore {
  private serial: Promise<unknown> = Promise.resolve();
  private released = false;
  private constructor(private readonly dir: AuthorityDirectory, private readonly name: string, private readonly lock: Lock,
    private journal: CommsLeaseJournal, private text: string) {}
  snapshot(): CommsLeaseJournal { return clone(this.journal); }
  assertOwnership(): Promise<void> {
    // Reads must share the write queue: our own atomic rename is not lost authority.
    const operation = this.serial.then(() => this.checkOwnership());
    this.serial = operation.catch(() => undefined);
    return operation;
  }
  private async checkOwnership(): Promise<void> {
    if (this.released) fail("authority_changed");
    await this.dir.assert();
    const info = await lstat(path.join(this.dir.root, this.lock.name));
    if (info.dev !== this.lock.dev || info.ino !== this.lock.ino || await this.dir.read(this.lock.name) !== JSON.stringify(this.lock.owner)) fail("authority_changed");
    if (await this.dir.read(this.name) !== this.text) fail("authority_changed");
  }
  private update(change: (journal: CommsLeaseJournal) => void): Promise<void> {
    const operation = this.serial.then(async () => {
      await this.checkOwnership();
      const next = clone(this.journal);
      change(next);
      next.updatedAt = new Date().toISOString();
      const text = JSON.stringify(next);
      parseJournal(text);
      if (Buffer.byteLength(text) > MAX_BYTES) fail();
      const temporary = `${this.name}.${randomUUID()}.tmp`;
      const file = await open(path.join(this.dir.root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
        await this.checkOwnership();
        await rename(path.join(this.dir.root, temporary), path.join(this.dir.root, this.name));
        // Update memory after rename, even if the following directory flush fails.
        this.journal = next;
        this.text = text;
        await this.dir.sync();
      } finally {
        await file.close();
        try { await unlink(path.join(this.dir.root, temporary)); } catch (error) { if (!missing(error)) throw error; }
      }
    });
    this.serial = operation.catch(() => undefined);
    return operation;
  }
  async bind(participantId: string, lease: ReceivingLease): Promise<void> {
    await this.update(journal => {
      const entry = journal.leases.find(item => item.participantId === participantId);
      if (!entry || !validReceivingLease(lease, entry.clientId)
        || entry.state === "planned" || entry.state === "absent" || entry.state === "not-created"
        || (entry.lease && (entry.lease.resourceId !== lease.resourceId || entry.lease.address !== lease.address))
        || journal.leases.some(item => item !== entry && item.lease?.resourceId === lease.resourceId)) fail("binding_mismatch");
      entry.lease = clone(lease);
      entry.state = "active";
    });
  }
  async setState(participantId: string, state: CommsLeaseState): Promise<void> {
    await this.update(journal => {
      const entry = journal.leases.find(item => item.participantId === participantId);
      if (!entry) fail();
      if ((entry.state === "absent" || entry.state === "not-created") && state !== entry.state) fail("binding_mismatch");
      if (state === "not-created" && entry.state !== "planned" && entry.state !== "not-created") fail("binding_mismatch");
      entry.state = state;
    });
  }
  async close(): Promise<void> {
    if (this.released) return;
    try {
      await this.update(journal => {
        journal.owner.active = false;
        journal.state = journal.leases.every(item => item.state === "absent" || item.state === "not-created") ? "closed" : "unresolved";
      });
    } finally { await this.releaseLock(); }
  }
  async releaseLock(): Promise<void> {
    if (this.released) return;
    await this.serial;
    await this.dir.assert();
    const info = await lstat(path.join(this.dir.root, this.lock.name));
    if (info.dev !== this.lock.dev || info.ino !== this.lock.ino || await this.dir.read(this.lock.name) !== JSON.stringify(this.lock.owner)) fail("authority_changed");
    await unlink(path.join(this.dir.root, this.lock.name));
    this.released = true;
    await this.dir.sync();
  }
  static async create(options: { cwd: string; runId: string; connectionName: string; apiKeyEnv: string; identity: ReceivingIdentity; participants: string[]; stateDir?: string }): Promise<CommsLeaseStore> {
    if (!LOCAL_ID.test(options.runId) || !CONNECTION.test(options.connectionName) || !KEY_ENV.test(options.apiKeyEnv)
      || !validReceivingIdentity(options.identity) || options.participants.length < 1 || options.participants.length > 64
      || new Set(options.participants).size !== options.participants.length || options.participants.some(id => !LOCAL_ID.test(id))) fail();
    const dir = await authority(options.cwd, options.stateDir, true);
    if (!dir) return fail();
    const name = dir.name(options.runId);
    if (await dir.read(name) !== null) fail("binding_mismatch");
    const lock = await takeLock(dir, name, false);
    const incarnation = randomUUID();
    const now = new Date().toISOString();
    const journal: CommsLeaseJournal = { schema: SCHEMA, project: dir.project, runId: options.runId, incarnation,
      connectionName: options.connectionName, apiKeyEnv: options.apiKeyEnv, identity: clone(options.identity), owner: lock.owner,
      state: "active", createdAt: now, updatedAt: now,
      leases: options.participants.map(participantId => { const leaseId = randomUUID(); return { participantId, leaseId,
        clientId: `humanish-${incarnation}-${leaseId}`, ownership: "fresh", state: "planned" }; }) };
    const text = JSON.stringify(journal);
    const store = new CommsLeaseStore(dir, name, lock, journal, text);
    try {
      await dir.assert();
      const file = await open(path.join(dir.root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await dir.sync();
      return store;
    } catch (error) { await store.releaseLock(); throw error; }
  }
  static async recover(options: { cwd: string; runId: string; connectionName: string; apiKeyEnv: string; stateDir?: string }): Promise<CommsLeaseStore> {
    if (!LOCAL_ID.test(options.runId)) fail();
    const dir = await authority(options.cwd, options.stateDir, false);
    if (!dir) return fail("binding_mismatch");
    const name = dir.name(options.runId);
    const text = await dir.read(name);
    if (text === null) return fail("binding_mismatch");
    const journal = parseJournal(text);
    if (!samePhysical(journal.project, dir.project) || journal.runId !== options.runId
      || journal.connectionName !== options.connectionName || journal.apiKeyEnv !== options.apiKeyEnv) fail("binding_mismatch");
    const live = ownerLiveness(journal.owner);
    if (live === true) fail("owner_active");
    if (live === null) fail("owner_unknown");
    const lock = await takeLock(dir, name, true);
    const store = new CommsLeaseStore(dir, name, lock, journal, text);
    try {
      await store.update(next => { next.owner = lock.owner; next.state = "active"; });
      return store;
    } catch (error) { await store.releaseLock(); throw error; }
  }
}

export async function inspectCommsLeaseStore(options: { cwd: string; stateDir?: string }): Promise<CommsRecoveryEntry[]> {
  try {
    const dir = await authority(options.cwd, options.stateDir, false);
    if (!dir) return [];
    const names = (await readdir(dir.root)).filter(name => /^run-[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 10_000) fail();
    const result: CommsRecoveryEntry[] = [];
    for (const name of names.sort()) {
      const text = await dir.read(name);
      if (text === null) continue;
      const journal = parseJournal(text);
      if (!samePhysical(journal.project, dir.project)) continue;
      if (name !== dir.name(journal.runId)) fail("binding_mismatch");
      result.push({ id: name.slice(4, -5), runId: journal.runId, connectionName: journal.connectionName,
        status: journal.state, participantCount: journal.leases.length,
        unresolvedCount: journal.leases.filter(item => item.state !== "absent" && item.state !== "not-created").length, activeOwner: ownerLiveness(journal.owner) });
    }
    return result;
  } catch (error) { if (error instanceof CommsAuthorityError) throw error; return fail(); }
}
