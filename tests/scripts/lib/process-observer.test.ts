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
} from "../../../scripts/lib/process-observer.js";

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
    "/p/100/task/100/stat": `100 (codex) ${state} 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 555 0`,
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
  it("reads named unix sockets, unix peers and TCP and udp remotes", () => {
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
      fakeProc({
        readdir: (dir) =>
          /^\/p\/100\/(?:task\/\d+\/)?fd$/.test(dir)
            ? denied()
            : dir === "/p/100/task"
              ? ["100"]
              : ["100", "net"],
      }),
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

  describe("an app-server whose process-level descriptors refuse", () => {
    // Thread 100 is the leader; 101 is a second thread. `flags` 4 is PF_EXITING.
    const stat = (pid: number, state: string, flags = 0) =>
      `${pid} (codex) ${state} 1 0 0 0 0 ${flags} 0 0 0 0 0 0 0 0 0 0 0 0 555 0`;
    const threads = (tasks: Record<string, { state: string; flags?: number; fd?: boolean }>) =>
      fakeProc(
        {
          readFile: (file) => {
            const tid = /^\/p\/100\/task\/(\d+)\/stat$/.exec(file)?.[1];
            if (tid !== undefined && tasks[tid])
              return stat(Number(tid), tasks[tid].state, tasks[tid].flags);
            if (file === "/p/net/tcp")
              return (
                "  sl local rem st\n" +
                "   0: 0100007F:9C40 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 42 1\n"
              );
            return fakeProc().readFile(file);
          },
          readdir: (dir) => {
            if (dir === "/p/100/fd") return denied();
            if (dir === "/p/100/task") return Object.keys(tasks);
            const tid = /^\/p\/100\/task\/(\d+)\/fd$/.exec(dir)?.[1];
            if (tid !== undefined) return tasks[tid]?.fd ? ["3"] : denied();
            return fakeProc().readdir(dir);
          },
          readlink: (file) => (file.endsWith("/fd/3") ? "socket:[42]" : "/usr/bin/codex"),
        },
        tasks["100"]?.state ?? "S",
      );

    it("reads a zombie leader's sockets through its running thread", async () => {
      const observation = await observe(
        threads({ "100": { state: "Z" }, "101": { state: "S", fd: true } }),
      );
      expect(observation.error).toBeNull();
      expect(observation.tcpRemotes).toEqual(["127.0.0.1:8080"]);
    });

    it("treats threads that have all begun to exit as holding nothing", async () => {
      const observation = await observe(
        threads({ "100": { state: "R", flags: 4 }, "101": { state: "Z" } }),
      );
      expect(observation.error).toBeNull();
    });

    it("fails when a thread refuses without exiting", async () => {
      const observation = await observe(
        threads({ "100": { state: "R", flags: 4 }, "101": { state: "S" } }),
      );
      expect(observation.error).toContain("descriptors are unreadable");
    });
  });

  it("records a descendant first seen before its exec as what it runs after it", async () => {
    let execed = false;
    const child = () =>
      `101 (${execed ? "sleep" : "sh"}) S 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777 0`;
    const io = fakeProc({
      readFile: (file) => {
        if (file === "/p/101/stat") return child();
        if (file === "/p/101/cmdline") return execed ? "sleep\u000030\u0000" : "sh\u0000";
        return fakeProc().readFile(file);
      },
      readdir: (dir) => (dir === "/p" ? ["100", "101", "net"] : fakeProc().readdir(dir)),
      readlink: (file) =>
        file === "/p/101/exe"
          ? execed
            ? "/usr/bin/sleep"
            : "/usr/bin/dash"
          : fakeProc().readlink(file),
    });
    const observer = observeProcesses({ rootPid: 100, proc: "/p", io, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    execed = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const observation = await observer.stop();
    expect(observation.error).toBeNull();
    expect(observation.processes).toEqual([
      expect.objectContaining({ pid: 101, comm: "sleep", exe: "sleep", args: "sleep 30" }),
    ]);
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

describe("process observer malformed input", () => {
  const withFile = (file: string, text: string) =>
    fakeProc({
      readFile: (name) => (name === file ? text : fakeProc().readFile(name)),
    });

  it("fails on a network table without its header or with a short row", async () => {
    expect((await observe(withFile("/p/net/unix", ""))).ok).toBe(false);
    expect((await observe(withFile("/p/net/tcp", "  sl local rem st\n   0: 0100007F\n"))).ok).toBe(
      false,
    );
  });

  it("fails on empty ss output when a socket needs its peer", async () => {
    const observation = await observe(fakeProc({ unixSocketTable: () => "" }));
    expect(observation.ok).toBe(false);
  });

  it("fails on an empty stat for the root process", async () => {
    expect((await observe(withFile("/p/100/stat", ""))).ok).toBe(false);
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

  it("finds a process outside the tree through the marker and reports that it survived", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "humanish-observer-"));
    const marker = `CODEX_HOME=${home}`;
    // Never a descendant of the root, so only the marker can find it. It outlives stop() under any
    // load, and the finally block kills it.
    const outside = spawn("sleep", ["30"], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, CODEX_HOME: home },
    });
    const root = spawn("sleep", ["0.3"], { stdio: "ignore" });
    const observer = observeProcesses({ rootPid: root.pid!, marker, intervalMs: 20 });
    await closed(root);
    const observation = await observer.stop();
    try {
      expect(observation.processes.find((entry) => entry.pid === outside.pid)).toMatchObject({
        comm: "sleep",
        via: "marker",
      });
      expect(observation.aliveAfterStop.map((entry) => entry.pid)).toContain(outside.pid);
    } finally {
      outside.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps following a descendant that detaches and reports that it survived", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "humanish-observer-"));
    const marker = `CODEX_HOME=${home}`;
    // setsid runs sleep in its own pid, which the subshell prints before it exits.
    const child = spawn("sh", ["-c", "(setsid sleep 30 >/dev/null 2>&1 & echo $!); sleep 0.3"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, CODEX_HOME: home },
    });
    let printed = "";
    child.stdout!.on("data", (chunk: Buffer) => (printed += chunk.toString()));
    const observer = observeProcesses({ rootPid: child.pid!, marker, intervalMs: 20 });
    await closed(child);
    const observation = await observer.stop();
    const pid = Number(printed.trim());
    try {
      // Seen first in the tree or, once it detached, through the marker; either way as sleep.
      expect(observation.processes.find((entry) => entry.pid === pid)).toMatchObject({
        comm: "sleep",
        args: "sleep 30",
      });
      expect(observation.aliveAfterStop.map((entry) => entry.pid)).toContain(pid);
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
