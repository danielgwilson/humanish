import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommsLeaseStore, inspectCommsLeaseStore } from "../src/comms-lease-store.js";
import { recoverCommsReceiving } from "../src/comms-receiving.js";
import type { ReceivingAdapter, ReceivingIdentity, ReceivingLease } from "../src/comms-receiving-types.js";

describe("private communications cleanup authority", () => {
  let base: string;
  let cwd: string;
  let stateDir: string;
  const identity: ReceivingIdentity = { provider: "agentmail", accountId: "fixture-account", scopeType: "organization", scopeId: "fixture-scope" };
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "humanish-comms-authority-"));
    cwd = path.join(base, "project");
    stateDir = path.join(base, "state");
    await mkdir(cwd);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });
  const options = () => ({ cwd, stateDir, runId: "fixture-run", connectionName: "mail", apiKeyEnv: "AGENTMAIL_API_KEY", identity, participants: ["participant-a"] });
  async function journalFile(): Promise<string> { return path.join(stateDir, (await readdir(stateDir)).find(name => name.endsWith(".json"))!); }
  function adapter() {
    const authenticate = vi.fn(async () => identity);
    const acquire = vi.fn(async (clientId: string) => ({ resourceId: "fixture-provider-resource", address: "participant@example.test", clientId }));
    const release = vi.fn(async (_lease: ReceivingLease) => ({ status: "absent" as const }));
    const value: ReceivingAdapter = { provider: "agentmail", authenticate, acquire, release,
      read: async () => ({ messages: [], complete: true, limitations: [] }) };
    return { value, authenticate, acquire, release };
  }
  async function unresolved(): Promise<CommsLeaseStore> {
    const store = await CommsLeaseStore.create(options());
    await store.setState("participant-a", "intent");
    await store.close();
    return store;
  }

  it("keeps random immutable acquisition identity in private 0700/0600 state outside the project", async () => {
    const store = await CommsLeaseStore.create(options());
    const before = store.snapshot();
    const lease = before.leases[0]!;
    const originalClientId = lease.clientId;
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(await journalFile())).mode & 0o777).toBe(0o600);
    expect(await readdir(cwd)).toEqual([]);
    expect(lease.state).toBe("planned");
    await store.setState("participant-a", "intent");
    await store.bind("participant-a", { resourceId: "fixture-resource", address: "participant@example.test", clientId: lease.clientId });
    expect(store.snapshot().leases[0]?.clientId).toBe(originalClientId);
    // Snapshot callers cannot edit the private authority object in memory.
    before.leases[0]!.clientId = "edited";
    expect(store.snapshot().leases[0]?.clientId).toBe(originalClientId);
    await store.setState("participant-a", "absent");
    await store.close();
    expect((await readdir(stateDir)).filter(name => name.endsWith(".lock"))).toEqual([]);
    const inspected = await inspectCommsLeaseStore({ cwd, stateDir });
    expect(inspected).toMatchObject([{ runId: "fixture-run", connectionName: "mail", status: "closed", unresolvedCount: 0, activeOwner: false }]);
    expect(JSON.stringify(inspected)).not.toContain("fixture-account");
    expect(JSON.stringify(inspected)).not.toContain("participant@example.test");
    expect(JSON.stringify(inspected)).not.toContain("fixture-resource");
  });

  it("rejects project-local authority, symlinked state ancestors and non-private directory permissions", async () => {
    await expect(CommsLeaseStore.create({ ...options(), stateDir: path.join(cwd, ".humanish/local/authority") })).rejects.toThrow();
    await mkdir(path.join(base, "outside"), { mode: 0o700 });
    await symlink(path.join(base, "outside"), stateDir);
    await expect(CommsLeaseStore.create(options())).rejects.toThrow();
    expect(await readdir(path.join(base, "outside"))).toEqual([]);
    await rm(stateDir);
    await mkdir(stateDir, { mode: 0o755 });
    await expect(CommsLeaseStore.create(options())).rejects.toThrow();
  });

  it("rejects a symlink or hard link substituted for a trusted journal", async () => {
    await unresolved();
    const file = await journalFile();
    const target = path.join(base, "journal-copy");
    await rename(file, target);
    await symlink(target, file);
    await expect(inspectCommsLeaseStore({ cwd, stateDir })).rejects.toThrow();
    await rm(file);
    await link(target, file);
    await expect(inspectCommsLeaseStore({ cwd, stateDir })).rejects.toThrow();
  });

  it("refuses live owners, including a missing lock whose journal still names a live process", async () => {
    const store = await CommsLeaseStore.create(options());
    const provider = adapter();
    const recover = () => recoverCommsReceiving({ ...options(), adapter: provider.value });
    expect(await recover()).toMatchObject({ ok: false, message: expect.stringContaining("live process") });
    const lock = (await readdir(stateDir)).find(name => name.endsWith(".lock"))!;
    await rm(path.join(stateDir, lock));
    expect(await recover()).toMatchObject({ ok: false, message: expect.stringContaining("live process") });
    expect(provider.authenticate).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
    await expect(store.assertOwnership()).rejects.toThrow();
  });

  it("refuses changed project identity, connection, credential reference and account/scope", async () => {
    await unresolved();
    const provider = adapter();
    const args = { ...options(), adapter: provider.value };
    expect(await recoverCommsReceiving({ ...args, connectionName: "other" })).toMatchObject({ ok: false });
    expect(await recoverCommsReceiving({ ...args, apiKeyEnv: "OTHER_MAIL_KEY" })).toMatchObject({ ok: false });
    expect(provider.authenticate).not.toHaveBeenCalled();
    provider.authenticate.mockResolvedValue({ ...identity, scopeId: "wrong-scope" });
    expect(await recoverCommsReceiving(args)).toMatchObject({ ok: false, unresolved: 1 });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
    await rename(cwd, path.join(base, "old-project"));
    await mkdir(cwd);
    expect(await recoverCommsReceiving(args)).toMatchObject({ ok: false });
    expect(await inspectCommsLeaseStore({ cwd, stateDir })).toEqual([]);
  });

  it("invalidates a running owner's writes and deletes when its lock or physical state directory changes", async () => {
    const store = await CommsLeaseStore.create(options());
    const lock = path.join(stateDir, (await readdir(stateDir)).find(name => name.endsWith(".lock"))!);
    const original = await readFile(lock, "utf8");
    await writeFile(lock, JSON.stringify({ ...JSON.parse(original), token: "replaced" }));
    await expect(store.setState("participant-a", "intent")).rejects.toThrow();
    await writeFile(lock, original);
    await rename(stateDir, path.join(base, "old-state"));
    await mkdir(stateDir, { mode: 0o700 });
    await expect(store.assertOwnership()).rejects.toThrow();
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("recovers a dead owner's exact uncertain intent after a simulated process crash", async () => {
    const store = await CommsLeaseStore.create(options());
    await store.setState("participant-a", "intent");
    const originalClientId = store.snapshot().leases[0]!.clientId;
    const file = await journalFile();
    const journal = JSON.parse(await readFile(file, "utf8"));
    // Simulated durable crash state; this is our internal journal format, not a provider fixture.
    journal.owner.pid = 2_147_483_647;
    await writeFile(file, JSON.stringify(journal));
    const lockFile = path.join(stateDir, (await readdir(stateDir)).find(name => name.endsWith(".lock"))!);
    await writeFile(lockFile, JSON.stringify(journal.owner));
    const provider = adapter();
    expect(await recoverCommsReceiving({ ...options(), adapter: provider.value })).toMatchObject({ ok: true, recovered: 1, unresolved: 0 });
    expect(provider.acquire).toHaveBeenCalledWith(originalClientId, expect.any(Object));
    expect(provider.release).toHaveBeenCalledWith(expect.objectContaining({ clientId: originalClientId }), expect.any(Object));
    expect(await inspectCommsLeaseStore({ cwd, stateDir })).toMatchObject([{ status: "closed" }]);
  });

  it("does not guess away foreign-host owners or interrupted takeover guards", async () => {
    await unresolved();
    const file = await journalFile();
    const journal = JSON.parse(await readFile(file, "utf8"));
    journal.owner = { ...journal.owner, active: true, host: "another-host.example.test" };
    await writeFile(file, JSON.stringify(journal));
    const provider = adapter();
    expect(await recoverCommsReceiving({ ...options(), adapter: provider.value })).toMatchObject({ ok: false, message: expect.stringContaining("cannot be established") });
    journal.owner.active = false;
    await writeFile(file, JSON.stringify(journal));
    await writeFile(`${file}.takeover`, "", { mode: 0o600 });
    expect(await recoverCommsReceiving({ ...options(), adapter: provider.value })).toMatchObject({ ok: false, message: expect.stringContaining("cannot be established") });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
  });

  it("serializes competing explicit recovery so only one process may mutate the provider", async () => {
    await unresolved();
    const provider = adapter();
    const args = { ...options(), adapter: provider.value };
    const results = await Promise.all([recoverCommsReceiving(args), recoverCommsReceiving(args)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(provider.acquire).toHaveBeenCalledOnce();
    expect(provider.release).toHaveBeenCalledOnce();
  });

  it("rejects borrowed ownership or mutated client identity from a private record", async () => {
    await unresolved();
    const file = await journalFile();
    const journal = JSON.parse(await readFile(file, "utf8"));
    journal.leases[0].ownership = "borrowed";
    await writeFile(file, JSON.stringify(journal));
    const provider = adapter();
    expect(await recoverCommsReceiving({ ...options(), adapter: provider.value })).toMatchObject({ ok: false });
    journal.leases[0].ownership = "fresh";
    journal.leases[0].clientId = "different-creation-intent";
    await writeFile(file, JSON.stringify(journal));
    expect(await recoverCommsReceiving({ ...options(), adapter: provider.value })).toMatchObject({ ok: false });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
  });

  it.each(["intent", "bound"])("recovers a %s journal after an actual owner process is killed", async stage => {
    const source = `
      import { CommsLeaseStore } from ${JSON.stringify(new URL("../src/comms-lease-store.ts", import.meta.url).href)};
      const store = await CommsLeaseStore.create(JSON.parse(process.argv[1]));
      await store.setState("participant-a", "intent");
      if (process.argv[2] === "bound") {
        await store.bind("participant-a", { resourceId: "fixture-provider-resource", address: "participant@example.test", clientId: store.snapshot().leases[0].clientId });
      }
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, JSON.stringify(options()), stage], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Crash fixture did not become ready.")), 10_000);
        child.stdout.once("data", chunk => { clearTimeout(timer); String(chunk).includes("ready") ? resolve() : reject(new Error("Unexpected crash fixture output.")); });
        child.once("error", () => { clearTimeout(timer); reject(new Error("Crash fixture failed to start.")); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Crash fixture ended before readiness.")); });
      });
      child.kill("SIGKILL");
      await exited;
      const provider = adapter();
      const before = JSON.parse(await readFile(await journalFile(), "utf8"));
      expect(await inspectCommsLeaseStore({ cwd, stateDir })).toMatchObject([{ status: "active", activeOwner: false, unresolvedCount: 1 }]);
      expect(await recoverCommsReceiving({ ...options(), adapter: provider.value })).toMatchObject({ ok: true, recovered: 1, unresolved: 0 });
      if (stage === "intent") expect(provider.acquire).toHaveBeenCalledWith(before.leases[0].clientId, expect.any(Object));
      else expect(provider.acquire).not.toHaveBeenCalled();
      expect(provider.release).toHaveBeenCalledOnce();
      expect(await inspectCommsLeaseStore({ cwd, stateDir })).toMatchObject([{ status: "closed", unresolvedCount: 0 }]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
});
