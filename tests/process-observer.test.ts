import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_IO,
  observeProcesses,
  parseInetTable,
  parseUnixPeers,
  parseUnixTable,
  type ObserverIo,
} from "../scripts/lib/process-observer.js";

const linux = process.platform === "linux";
const closed = (child: ReturnType<typeof spawn>) =>
  new Promise((resolve) => child.on("close", resolve));
const denied = (): never => {
  throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
};

// A synthetic /proc with one root process (pid 100) holding one socket.
function fakeProc(overrides: Partial<ObserverIo> = {}, state = "S"): ObserverIo {
  const files: Record<string, string> = {
    "/p/100/stat": `100 (codex) ${state} 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 555 0`,
    "/p/net/unix": "Num RefCount Protocol Flags Type St Inode Path\n",
    "/p/net/tcp": "  sl local rem st\n",
    "/p/net/udp": "  sl local rem st\n",
  };
  return {
    readFile: (file) => {
      if (file in files) return files[file]!;
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
    },
    readdir: (dir) => (dir === "/p" ? ["100", "net"] : dir === "/p/100/fd" ? ["3"] : []),
    readlink: (file) => (file === "/p/100/fd/3" ? "socket:[42]" : "/usr/bin/codex"),
    unixSocketTable: () => "Netid State Recv-Q Send-Q Local Port Peer Port\n",
    ...overrides,
  };
}
const observe = async (io: ObserverIo) =>
  observeProcesses({ rootPid: 100, proc: "/p", io, intervalMs: 5 }).stop();

describe("process observer tables", () => {
  it("reads named unix sockets, unix peers and TCP and UDP remotes", () => {
    const unix = parseUnixTable(
      "Num       RefCount Protocol Flags    Type St Inode Path\n" +
        "0000000000000000: 00000002 00000000 00010000 0001 01 1234 /tmp/codex-daemon-1000/abc\n" +
        "0000000000000000: 00000003 00000000 00000000 0001 03 5678\n",
    );
    expect([...unix]).toEqual([["1234", "/tmp/codex-daemon-1000/abc"]]);
    const peers = parseUnixPeers(
      "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port\n" +
        "u_str ESTAB 0 0 /run/daemon.sock 700 * 701\n" +
        "u_str ESTAB 0 0 * 701 * 700\n",
    );
    expect(peers.get("701")).toEqual({ path: "*", peer: "700" });
    expect(peers.get("700")?.path).toBe("/run/daemon.sock");
    const table =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
      "   0: 0100007F:9C40 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 4321 1\n" +
      "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 999 1\n";
    expect([...parseInetTable(table, "tcp")]).toEqual([["4321", "127.0.0.1:8080"]]);
    expect(parseInetTable(table, "udp").get("999")).toBe("*");
  });
});

describe("process observer read failures", () => {
  it("fails when the app-server's descriptors cannot be read", async () => {
    const observation = await observe(
      fakeProc({ readdir: (dir) => (dir === "/p/100/fd" ? denied() : ["100", "net"]) }),
    );
    expect(observation.ok).toBe(false);
    expect(observation.error).toContain("descriptors are unreadable");
  });

  it("fails when a descriptor link or a network table cannot be read", async () => {
    const link = await observe(
      fakeProc({ readlink: (file) => (file === "/p/100/fd/3" ? denied() : "") }),
    );
    expect(link.ok).toBe(false);
    const table = await observe(
      fakeProc({
        readFile: (file) => {
          if (file === "/p/net/unix") return denied();
          return fakeProc().readFile(file);
        },
      }),
    );
    expect(table.ok).toBe(false);
    expect(table.error).toContain("EACCES");
  });

  it("fails when unix peers cannot be resolved", async () => {
    const observation = await observe(
      fakeProc({
        unixSocketTable: () => {
          throw new Error("ss is not on PATH; unix socket peers cannot be resolved");
        },
      }),
    );
    expect(observation.ok).toBe(false);
  });

  it("treats a refusing zombie as exited, not as an inspection failure", async () => {
    const zombie = fakeProc(
      { readdir: (dir) => (dir === "/p/100/fd" ? denied() : ["100", "net"]) },
      "Z",
    );
    const observation = await observe(zombie);
    expect(observation.ok).toBe(true);
  });

  it("stops following the root pid once another process reuses it", async () => {
    let reused = false;
    const io = fakeProc({
      readFile: (file) => {
        if (file === "/p/100/stat")
          return `100 (${reused ? "other" : "codex"}) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${reused ? 999 : 555} 0`;
        return fakeProc().readFile(file);
      },
      readdir: (dir) => {
        if (dir === "/p/100/fd" && reused) return denied();
        return fakeProc().readdir(dir);
      },
    });
    const observer = observeProcesses({ rootPid: 100, proc: "/p", io, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    reused = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const observation = await observer.stop();
    expect(observation.ok).toBe(true);
    expect(observation.root?.comm).toBe("codex");
  });
});

describe.skipIf(!linux)("process observer on Linux", () => {
  it("records grandchildren seen during the lifecycle", async () => {
    const child = spawn("sh", ["-c", "sh -c 'sleep 0.4' & wait"], { stdio: "ignore" });
    const observer = observeProcesses({ rootPid: child.pid!, intervalMs: 20 });
    await closed(child);
    const observation = await observer.stop();
    expect(observation.ok).toBe(true);
    expect(observation.processes.map((entry) => entry.comm)).toEqual(
      expect.arrayContaining(["sh", "sleep"]),
    );
    expect(observation.aliveAfterStop).toEqual([]);
  });

  it("finds a detached process through the marker and reports that it survived", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "humanish-observer-"));
    const marker = `CODEX_HOME=${home}`;
    const child = spawn("sh", ["-c", "(setsid sleep 0.8 &); sleep 0.3"], {
      stdio: "ignore",
      env: { ...process.env, CODEX_HOME: home },
    });
    const observer = observeProcesses({ rootPid: child.pid!, marker, intervalMs: 20 });
    await closed(child);
    const observation = await observer.stop();
    try {
      const detached = observation.processes.find(
        (entry) => entry.comm === "sleep" && entry.via === "marker",
      );
      expect(detached).toBeDefined();
      expect(observation.aliveAfterStop.map((entry) => entry.pid)).toContain(detached!.pid);
    } finally {
      for (const entry of observation.aliveAfterStop) process.kill(entry.pid, "SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The client holds its connection until the sampler has had a second after the server saw it.
  it("names the listener behind a connected unix client, whose own socket is unnamed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "humanish-observer-unix-"));
    const socket = path.join(dir, "daemon.sock");
    const { createServer } = await import("node:net");
    const server = createServer((connection) => connection.on("error", () => {}));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const connected = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const client = spawn(
      process.execPath,
      [
        "-e",
        `const s = require("net").connect(${JSON.stringify(socket)}); process.stdin.on("end", () => s.destroy()); process.stdin.resume();`,
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const observer = observeProcesses({ rootPid: client.pid!, intervalMs: 20 });
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    client.stdin!.end();
    await closed(client);
    const observation = await observer.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    expect(observation.ok).toBe(true);
    expect(observation.unixSockets).toContain(socket);
  });

  it("reports an inspection failure instead of an empty observation", async () => {
    const child = spawn("sh", ["-c", "sleep 0.1"], { stdio: "ignore" });
    const observer = observeProcesses({ rootPid: child.pid!, proc: "/nonexistent-proc" });
    await closed(child);
    const observation = await observer.stop();
    expect(observation.ok).toBe(false);
    expect(observation.error).not.toBeNull();
  });

  it("uses the real filesystem by default", () => {
    expect(NODE_IO.readdir("/proc").length).toBeGreaterThan(0);
  });
});
