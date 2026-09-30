// Samples one process lifecycle through Linux /proc for `pnpm codex:qualify`. Every interval it
// records the root's descendant tree, plus any process whose environment carries the caller's
// marker (the probe's private CODEX_HOME), which also catches detached processes that keep their
// environment. It resolves each observed process's sockets, including the listener path behind a
// connected unix client (through `ss`), and after stop reports anything still alive. The strace log
// is the lifecycle record; sampling adds sockets held open and survivors. A read the sampler needs
// that fails for any reason other than the process having exited fails the observation.
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

export interface ObservedProcess {
  pid: number;
  ppid: number;
  comm: string;
  exe: string;
  /** Command line, NUL-separated arguments joined by spaces, capped at 300 characters. */
  args: string;
  start: string;
  via: "tree" | "marker";
}
export interface ProcessObservation {
  ok: boolean;
  error: string | null;
  intervalMs: number;
  samples: number;
  root: { comm: string; exe: string } | null;
  processes: ObservedProcess[];
  /** Paths of unix sockets the processes bound, and of the listeners their clients reached. */
  unixSockets: string[];
  tcpRemotes: string[];
  /** Connected UDP remotes; `*` is an unconnected UDP socket. */
  udpRemotes: string[];
  /** Descendants whose descriptors the kernel refused; their sockets are only in the strace log. */
  uninspectable: ObservedProcess[];
  aliveAfterStop: ObservedProcess[];
}
/** File access the sampler uses; tests replace it to inject failures. */
export interface ObserverIo {
  readFile(file: string): string;
  readdir(dir: string): string[];
  readlink(file: string): string;
  /** `ss -xan` output: every unix socket with its inode and its peer's inode. */
  unixSocketTable(): string;
}
interface Stat {
  ppid: number;
  comm: string;
  start: string;
  /** The state letter; Z and X have exited and hold no descriptors. */
  state: string;
}

function onPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue PATH.
    }
  }
  throw new Error(`${name} is not on PATH; unix socket peers cannot be resolved`);
}
export const NODE_IO: ObserverIo = {
  readFile: (file) => readFileSync(file, "utf8"),
  readdir: (dir) => readdirSync(dir),
  readlink: (file) => readlinkSync(file),
  unixSocketTable: () => execFileSync(onPath("ss"), ["-xan"], { encoding: "utf8" }),
};
const code = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;
/** The process exited between listing and reading; any other failure is rethrown. */
function gone<T>(read: () => T, fallback: T, also: readonly string[] = []): T {
  try {
    return read();
  } catch (error) {
    if (["ENOENT", "ESRCH", ...also].includes(code(error) ?? "")) return fallback;
    throw error;
  }
}

function readStat(io: ObserverIo, proc: string, pid: number): Stat | undefined {
  const text = gone(() => io.readFile(path.join(proc, String(pid), "stat")), undefined);
  if (text === undefined) return undefined;
  const open = text.indexOf("("),
    close = text.lastIndexOf(")");
  const fields = text.slice(close + 2).split(" ");
  return {
    comm: text.slice(open + 1, close),
    state: fields[0] ?? "",
    ppid: Number(fields[1]),
    start: fields[19] ?? "",
  };
}
const pids = (io: ObserverIo, proc: string): number[] =>
  io
    .readdir(proc)
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
// Other users' processes refuse environ reads; they cannot carry this run's private home.
const carries = (io: ObserverIo, proc: string, pid: number, marker: string): boolean =>
  gone(
    () =>
      io
        .readFile(path.join(proc, String(pid), "environ"))
        .split("\0")
        .includes(marker),
    false,
    ["EACCES", "EPERM"],
  );
// Names are for review only, so an unreadable one is left blank.
function exeName(io: ObserverIo, proc: string, pid: number): string {
  try {
    return path.basename(io.readlink(path.join(proc, String(pid), "exe")));
  } catch {
    return "";
  }
}
function commandLine(io: ObserverIo, proc: string, pid: number): string {
  try {
    return io
      .readFile(path.join(proc, String(pid), "cmdline"))
      .split("\0")
      .filter(Boolean)
      .join(" ")
      .slice(0, 300);
  } catch {
    return "";
  }
}
const DENIED = Symbol("denied");
/**
 * Socket inodes a process holds, or DENIED when the kernel refuses its descriptors. A process that
 * dropped dumpability (bubblewrap's sandboxed child does) refuses them even to its own user.
 */
function socketInodes(io: ObserverIo, proc: string, pid: number): string[] | typeof DENIED {
  const fdDir = path.join(proc, String(pid), "fd");
  try {
    return gone(() => io.readdir(fdDir), []).flatMap((fd) => {
      const target = gone(() => io.readlink(path.join(fdDir, fd)), "");
      const match = /^socket:\[(\d+)\]$/.exec(target);
      return match ? [match[1]!] : [];
    });
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(code(error) ?? "")) throw error;
    // An exited process not yet reaped (a zombie) also refuses; it holds no descriptors.
    const state = readStat(io, proc, pid)?.state;
    return state === undefined || state === "Z" || state === "X" ? [] : DENIED;
  }
}

/** Unix socket inode to bound path, from /proc/net/unix (unnamed sockets have no path). */
export function parseUnixTable(text: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 8 && fields[7]) table.set(fields[6]!, fields[7]);
  }
  return table;
}
/** Unix socket inode to its own path (or `*`) and its peer's inode, from `ss -xan`. */
export function parseUnixPeers(text: string): Map<string, { path: string; peer: string }> {
  const table = new Map<string, { path: string; peer: string }>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 8) table.set(fields[5]!, { path: fields[4]!, peer: fields[7]! });
  }
  return table;
}
function ipv4(hex: string): string {
  return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
}
/**
 * Socket inode to remote address, from /proc/net/{tcp,tcp6,udp,udp6}. TCP listeners are skipped;
 * an unconnected UDP socket's remote is `*`.
 */
export function parseInetTable(text: string, protocol: "tcp" | "udp"): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || (protocol === "tcp" && fields[3] === "0A")) continue;
    const [address, port] = fields[2]!.split(":");
    const host =
      address!.length === 8
        ? ipv4(address!)
        : address!.startsWith("0000000000000000FFFF0000")
          ? ipv4(address!.slice(24))
          : address!;
    const remote = `${host}:${parseInt(port!, 16)}`;
    table.set(
      fields[9]!,
      protocol === "udp" && /^(0\.0\.0\.0|0{32}):0$/.test(remote) ? "*" : remote,
    );
  }
  return table;
}
export function observeProcesses(options: {
  rootPid: number;
  marker?: string;
  intervalMs?: number;
  proc?: string;
  io?: ObserverIo;
}): { stop(): Promise<ProcessObservation> } {
  const proc = options.proc ?? "/proc";
  const io = options.io ?? NODE_IO;
  const intervalMs = options.intervalMs ?? 50;
  const seen = new Map<string, ObservedProcess>();
  const markerChecked = new Map<string, boolean>();
  const unixSockets = new Set<string>();
  const tcpRemotes = new Set<string>();
  const udpRemotes = new Set<string>();
  // Sockets whose peer is known; others are looked up again, since a client may connect later.
  const peered = new Set<string>();
  const uninspectable = new Map<string, ObservedProcess>();
  let root: ProcessObservation["root"] = null;
  // The root's start time; once it changes, the pid belongs to another process and is not followed.
  let rootStart: string | undefined;
  let error: string | null = null;
  let samples = 0;
  const table = (name: string, optional = false): string =>
    optional
      ? gone(() => io.readFile(path.join(proc, "net", name)), "")
      : io.readFile(path.join(proc, "net", name));
  const sample = (): void => {
    if (error !== null) return;
    try {
      const stats = new Map<number, Stat>();
      for (const pid of pids(io, proc)) {
        const stat = readStat(io, proc, pid);
        if (stat) stats.set(pid, stat);
      }
      const current = stats.get(options.rootPid);
      if (current && rootStart === undefined) {
        rootStart = current.start;
        root = { comm: current.comm, exe: exeName(io, proc, options.rootPid) };
      }
      const rootStat = current?.start === rootStart ? current : undefined;
      const tree = new Set<number>(rootStat ? [options.rootPid] : []);
      for (let grew = true; grew;) {
        grew = false;
        for (const [pid, stat] of stats)
          if (!tree.has(pid) && tree.has(stat.ppid)) {
            tree.add(pid);
            grew = true;
          }
      }
      const live: number[] = [...tree];
      for (const [pid, stat] of stats) {
        const key = `${pid}:${stat.start}`;
        if (options.marker === undefined || tree.has(pid)) continue;
        if (!markerChecked.has(key)) markerChecked.set(key, carries(io, proc, pid, options.marker));
        if (markerChecked.get(key)) live.push(pid);
      }
      const inodes = new Set<string>();
      for (const pid of live) {
        const stat = stats.get(pid)!;
        const key = `${pid}:${stat.start}`;
        if (pid !== options.rootPid && !seen.has(key))
          seen.set(key, {
            pid,
            ppid: stat.ppid,
            comm: stat.comm,
            exe: exeName(io, proc, pid),
            args: commandLine(io, proc, pid),
            start: stat.start,
            via: tree.has(pid) ? "tree" : "marker",
          });
        const held = socketInodes(io, proc, pid);
        if (held === DENIED) {
          // The app-server itself must stay inspectable; a refusing descendant is listed.
          if (pid === options.rootPid)
            throw new Error(`the app-server's descriptors are unreadable`);
          uninspectable.set(key, seen.get(key)!);
          continue;
        }
        for (const inode of held) inodes.add(inode);
      }
      if (inodes.size > 0) {
        const unix = parseUnixTable(table("unix"));
        // A host without IPv6 has no tcp6/udp6 table and no IPv6 sockets to miss.
        const tcp = new Map([
          ...parseInetTable(table("tcp"), "tcp"),
          ...parseInetTable(table("tcp6", true), "tcp"),
        ]);
        const udp = new Map([
          ...parseInetTable(table("udp"), "udp"),
          ...parseInetTable(table("udp6", true), "udp"),
        ]);
        for (const inode of inodes) {
          if (unix.has(inode)) unixSockets.add(unix.get(inode)!);
          if (tcp.has(inode)) tcpRemotes.add(tcp.get(inode)!);
          if (udp.has(inode)) udpRemotes.add(udp.get(inode)!);
        }
        // A connected unix client is unnamed; the path belongs to the listener at the other end.
        const unresolved = [...inodes].filter(
          (inode) => !tcp.has(inode) && !udp.has(inode) && !peered.has(inode),
        );
        if (unresolved.length > 0) {
          const peers = parseUnixPeers(io.unixSocketTable());
          for (const inode of unresolved) {
            const peer = peers.get(inode)?.peer;
            // `ss -x` lists only unix sockets; anything else (netlink, for one) has no peer path.
            if (peer === undefined) peered.add(inode);
            if (peer === undefined || peer === "*" || peer === "0") continue;
            peered.add(inode);
            const listener = peers.get(peer)?.path;
            if (listener && listener !== "*") unixSockets.add(listener);
          }
        }
      }
      samples++;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      sample();
      await new Promise((resolve) => setTimeout(resolve, 200));
      let aliveAfterStop: ObservedProcess[] = [];
      try {
        aliveAfterStop = [...seen.values()].filter(
          (entry) => readStat(io, proc, entry.pid)?.start === entry.start,
        );
      } catch (caught) {
        error ??= caught instanceof Error ? caught.message : String(caught);
      }
      return {
        ok: error === null && samples > 0 && root !== null,
        error: error ?? (root === null ? "root process was never observed" : null),
        intervalMs,
        samples,
        root,
        processes: [...seen.values()],
        unixSockets: [...unixSockets].sort(),
        tcpRemotes: [...tcpRemotes].sort(),
        udpRemotes: [...udpRemotes].sort(),
        uninspectable: [...uninspectable.values()],
        aliveAfterStop,
      };
    },
  };
}

/** Waits for a child of `parentPid` running `exe` (the tracee under strace) and returns its pid. */
export async function waitForChild(
  parentPid: number,
  exe: string,
  timeoutMs = 3000,
  proc = "/proc",
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      for (const pid of pids(NODE_IO, proc)) {
        if (readStat(NODE_IO, proc, pid)?.ppid !== parentPid) continue;
        try {
          if (readlinkSync(path.join(proc, String(pid), "exe")) === exe) return pid;
        } catch {
          // Not yet exec'd or already gone.
        }
      }
    } catch {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}
