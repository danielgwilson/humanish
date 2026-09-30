// The lifecycle record for `pnpm codex:qualify`: the app-server runs under `strace -f`, which follows
// it and every descendant, detached ones included, from launch to exit. This module parses three
// views of that log: executed programs, network destinations and write-intent file operations.
// strace is Linux-only, so qualification is too; without it the trace checks fail.
import { accessSync, constants } from "node:fs";
import path from "node:path";

/** The strace executable on PATH, or undefined when process events cannot be recorded. */
export function findStrace(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(directory, "strace");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue PATH.
    }
  }
  return undefined;
}

// Strings and argv arrays longer than this would be cut short and compare as equal prefixes.
const MAX_STRING = 65_536;
const EXEC_CALLS = ["execve", "execveat"];
const NET_CALLS = ["connect", "bind", "sendto", "sendmsg", "sendmmsg"];
// Both ends of a socketpair belong to the traced tree, so sends on them never leave it.
const PAIR_CALLS = ["socketpair"];
// Working directories, so a relative file path resolves; clone passes one to the child.
const CWD_CALLS = ["chdir", "fchdir", "clone", "clone3", "fork", "vfork"];
// io_uring submits opens and socket operations the syscall trace cannot see.
const RING_CALLS = ["io_uring_setup"];
const FILE_CALLS = [
  "open",
  "openat",
  "openat2",
  "creat",
  "mkdir",
  "mkdirat",
  "rename",
  "renameat",
  "renameat2",
  "link",
  "linkat",
  "symlink",
  "symlinkat",
  "unlink",
  "unlinkat",
  "rmdir",
  "truncate",
];

/**
 * Wraps a command so strace records execs, socket destinations and file writes; `-yy` prints the
 * path or socket behind each descriptor. Tracees die if strace itself is killed.
 */
export function tracedCommand(
  strace: string,
  traceFile: string,
  file: string,
  args: readonly string[],
): { file: string; args: string[] } {
  return {
    file: strace,
    args: [
      "-f",
      // -q keeps strace's exit line for each process, so a trace cut short is detectable.
      "-q",
      "-yy",
      "-s",
      String(MAX_STRING),
      "--kill-on-exit",
      // No `-e signal=` filter: strace prints `+++ killed by SIG... +++` only for signals in that
      // set, and a process killed by a signal needs its end line.
      "-e",
      `trace=${[...EXEC_CALLS, ...NET_CALLS, ...PAIR_CALLS, ...FILE_CALLS, ...CWD_CALLS, ...RING_CALLS].join(",")}`,
      "-o",
      traceFile,
      "--",
      file,
      ...args,
    ],
  };
}

/**
 * The only rewrites applied before comparing events: each literal `path` becomes `label` in every
 * path and argument string. Nothing else is rewritten, and strace's pid column is never compared.
 */
export interface ExecRewrite {
  label: string;
  path: string;
}
interface Syscall {
  pid: string;
  name: string;
  /** Arguments through the result, with a resumed call joined to its start. */
  text: string;
}

const START = /^(\d+)\s+([a-z0-9_]+)\((.*)$/;
const RESUMED = /^(\d+)\s+<\.\.\. ([a-z0-9_]+) resumed>(.*)$/;
// The only lines allowed outside the syscall grammar, each one strace's own:
// - a process's end;
const ENDED =
  /^(\d+) \+\+\+ (?:exited with \d+|killed by SIG[A-Z0-9_]+(?: \(core dumped\))?) \+\+\+$/;
// - a thread's execve replacing its thread-group leader, whose pid the thread takes;
const SUPERSEDED = /^(\d+) \+\+\+ superseded by execve in pid (\d+) \+\+\+$/;
// - a signal delivery;
const SIGNAL = /^(\d+) --- SIG[A-Z0-9_]+ \{.*\} ---$/;
// - a call whose registers strace could not read because the thread was being killed (a
//   sibling's exit_group, say), which ends with `= ?` or not at all: the kernel skips a
//   syscall when a fatal signal is pending at entry.
const UNDECODED_START = /^(\d+) \?\?\?\( <unfinished \.\.\.>$/;
const UNDECODED_RESUMED = /^(\d+) <\.\.\. \?\?\? resumed>\)\s*= \?$/;
const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

/**
 * Joins each `<unfinished ...>` start with its resumption, in trace order. A line outside
 * strace's grammar (a truncated one, say), an unpaired resumption, or a process with no end
 * line (a trace cut short) is an error. A call still unfinished when its process ended is one
 * it died in, `= ?`, which counts an exec as run and a file operation as attempted.
 */
function pairSyscalls(text: string): { calls: Syscall[]; errors: Set<string> } {
  const pending = new Map<string, Syscall>();
  const calls: Syscall[] = [];
  const errors = new Set<string>();
  // Processes seen since their last end line.
  const live = new Set<string>();
  const diedIn = (pid: string): void => {
    const call = pending.get(pid);
    pending.delete(pid);
    if (call !== undefined && call.name !== "???")
      calls.push({ ...call, text: `${call.text}) = ?` });
  };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const ended = ENDED.exec(line);
    if (ended) {
      diedIn(ended[1]!);
      live.delete(ended[1]!);
      continue;
    }
    const superseded = SUPERSEDED.exec(line);
    if (superseded) {
      const leader = superseded[1]!,
        thread = superseded[2]!;
      diedIn(leader);
      const exec = pending.get(thread);
      pending.delete(thread);
      live.delete(thread);
      if (exec !== undefined) pending.set(leader, { ...exec, pid: leader });
      live.add(leader);
      continue;
    }
    const pid = /^(\d+) /.exec(line)?.[1];
    if (pid !== undefined) live.add(pid);
    if (SIGNAL.test(line)) continue;
    if (UNDECODED_START.test(line)) {
      pending.set(pid!, { pid: pid!, name: "???", text: "" });
      continue;
    }
    if (UNDECODED_RESUMED.test(line)) {
      if (pending.get(pid!)?.name !== "???") errors.add("a ??? resumed without its start");
      pending.delete(pid!);
      continue;
    }
    const resumed = RESUMED.exec(line);
    if (resumed) {
      const call = pending.get(resumed[1]!);
      pending.delete(resumed[1]!);
      if (call === undefined || call.name !== resumed[2])
        errors.add(`a ${resumed[2]} resumed without its start`);
      else calls.push({ pid: call.pid, name: call.name, text: call.text + resumed[3]! });
      continue;
    }
    const start = START.exec(line);
    if (!start) {
      errors.add("a trace line is outside strace's grammar");
      continue;
    }
    const body = start[3]!.trimEnd();
    if (body.endsWith("<unfinished ...>"))
      pending.set(start[1]!, {
        pid: start[1]!,
        name: start[2]!,
        text: body.slice(0, -"<unfinished ...>".length),
      });
    else calls.push({ pid: start[1]!, name: start[2]!, text: body });
  }
  const [open] = live;
  if (open !== undefined)
    errors.add(
      `the trace ends before process ${open}${live.size > 1 ? ` and ${live.size - 1} more` : ""} exited`,
    );
  return { calls, errors };
}

// The result is the last `) = ` on the line, after every quoted argument. `= ?` means the tracee
// died during the call.
const result = (text: string): string | undefined =>
  [...text.matchAll(/\)\s*=\s*(-?\d+|\?)/g)].at(-1)?.[1];

/**
 * Quoted strings replaced by `"#n"` placeholders, so argument text such as a sent payload cannot
 * look like syntax; `strings[n]` holds each original (still strace-escaped).
 */
function masked(text: string): { text: string; strings: string[] } {
  const strings: string[] = [];
  return {
    text: text.replace(QUOTED, (_, value: string) => `"#${strings.push(value) - 1}"`),
    strings,
  };
}
/** Top-level arguments of a masked call, split on commas outside brackets and braces. */
function topLevel(text: string): string[] {
  const args: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") {
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}
const unquote = (token: string | undefined, strings: string[]): string | undefined => {
  const match = /^"#(\d+)"/.exec(token ?? "");
  return match ? strings[Number(match[1])] : undefined;
};
/** The path strace printed for a descriptor argument (`3</dir>`, `AT_FDCWD</cwd>`), if any. */
const descriptorPath = (token: string | undefined): string | undefined =>
  /^(?:AT_FDCWD|-?\d+)<([^>]*)>/.exec(token ?? "")?.[1];

/**
 * Pattern rewrites for file and socket paths only (never exec argv): per-run process ids and the
 * random suffixes of Codex's temporary names. Each run prints this list.
 */
export const PATH_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\/proc\/\d+\//g, label: "/proc/<pid>/" },
  { pattern: /\/codex-arg0[A-Za-z0-9]{6}(?=\/|$)/g, label: "/codex-arg0<tmp>" },
  { pattern: /\/\.tmp[A-Za-z0-9]{6}(?=\/|$)/g, label: "/.tmp<tmp>" },
];
export const applyPathPatterns = (value: string): string =>
  PATH_PATTERNS.reduce((current, { pattern, label }) => current.replace(pattern, label), value);
function rewriter(rewrites: readonly ExecRewrite[]): (value: string) => string {
  return (value) =>
    rewrites.reduce(
      (current, rewrite) =>
        rewrite.path ? current.split(rewrite.path).join(rewrite.label) : current,
      value,
    );
}

export interface ParsedTrace {
  /** The traced command's own exec, normalized; it is set aside, not compared. */
  root: string | null;
  /** Every later exec as a JSON array of program then argv, after the rewrites. */
  execs: string[];
  /** The same execs before the rewrites, index for index. */
  raw: string[];
  /** Socket operations as JSON `[op, family, destination]`, attempted or not. */
  net: string[];
  /** Sends between two ends of a socketpair the traced tree created (for review). */
  internal: string[];
  /**
   * Write-intent file operations as JSON `[op, ...paths]`, attempted or not; `create` is a
   * successful exclusive creation, so the path did not exist before.
   */
  files: string[];
  /** The same operations in the order they finished, with their outcome. */
  fileLog: FileEvent[];
  /** io_uring_setup calls; the operations a ring submits are invisible to this trace. */
  ioUring: number;
  /** Why the log is not a complete record, when it is not. */
  error: string | null;
}

function execOf(call: Syscall, errors: Set<string>): string[] | undefined {
  const { text, strings } = masked(call.text);
  const args = topLevel(text);
  const [dirfd, pathArg, argvArg] =
    call.name === "execveat" ? [args[0], args[1], args[2]] : [undefined, args[0], args[1]];
  const given = unquote(pathArg, strings);
  if (given === undefined || argvArg === undefined || !argvArg.startsWith("[")) {
    errors.add("an execve line did not parse");
    return undefined;
  }
  // strace marks a cut string with `"..."...` and a cut array with a bare `...`.
  if (/"\.\.\./.test(argvArg) || argvArg.replace(/"#\d+"/g, "").includes("...")) {
    errors.add("strace truncated an exec argument");
    return undefined;
  }
  const base = descriptorPath(dirfd);
  const program = path.isAbsolute(given)
    ? given
    : base !== undefined
      ? given === ""
        ? base
        : path.join(base, given)
      : undefined;
  if (program === undefined) {
    errors.add("an exec used a relative path without a known directory");
    return undefined;
  }
  const argv = [...argvArg.matchAll(/"#(\d+)"/g)].map((match) => strings[Number(match[1])]!);
  return [program, ...argv];
}

const SOCKET_ANNOTATION = /^-?\d+<([A-Za-z0-9-]+):\[(.*?)\]>/;
/**
 * Labels for network addresses, the only address rewrites: a `host:port` key replaces the whole
 * destination (the loopback provider becomes `<loopback>`); a bare host key keeps the port
 * (`<chatgpt.com>:443`). Each run prints its labels.
 */
export type AddressLabels = ReadonlyMap<string, string>;
export function labelAddress(address: string, labels: AddressLabels): string {
  const exact = labels.get(address);
  if (exact !== undefined) return exact;
  const split = /^\[?(.*?)\]?:(\d+)$/.exec(address);
  const host = split ? labels.get(split[1]!) : undefined;
  return host !== undefined ? `${host}:${split![2]}` : address;
}
function destination(
  sockaddr: string,
  strings: string[],
  labels: AddressLabels,
  normalize: (value: string) => string,
): string | undefined {
  const unix = /sa_family=AF_UNIX(?:, sun_path=(@?)"#(\d+)")?/.exec(sockaddr);
  if (unix)
    return unix[2] === undefined ? "unnamed" : `${unix[1]}${normalize(strings[Number(unix[2])]!)}`;
  const inet = /sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("#(\d+)"\)/.exec(
    sockaddr,
  );
  if (inet) return labelAddress(`${strings[Number(inet[2])]}:${inet[1]}`, labels);
  const inet6 = /sa_family=AF_INET6, sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "#(\d+)"/.exec(
    sockaddr,
  );
  if (inet6) return labelAddress(`[${strings[Number(inet6[2])]}]:${inet6[1]}`, labels);
  return /sa_family=(AF_[A-Z0-9]+)/.exec(sockaddr)?.[1];
}

interface SocketState {
  /** Inodes of socketpair ends the traced tree created. */
  pairs: Set<string>;
  /** Unix client inode to the path it connected to. */
  connected: Map<string, string>;
}
function netOf(
  call: Syscall,
  labels: AddressLabels,
  normalize: (value: string) => string,
  sockets: SocketState,
): { event: string; internal: boolean }[] {
  const { text, strings } = masked(call.text);
  const annotation = SOCKET_ANNOTATION.exec(text);
  const family = annotation?.[1]?.toLowerCase() ?? "unknown";
  const [inode, peerInode] = (annotation?.[2] ?? "").split("->");
  const op = call.name === "connect" ? "connect" : call.name === "bind" ? "bind" : "send";
  const addresses = [...text.matchAll(/\{sa_family=[^}]*\}/g)].map((match) =>
    destination(match[0], strings, labels, normalize),
  );
  // -yy names a netlink socket's subsystem (ROUTE, AUDIT, ...) when it can, else only its inode.
  const subsystem = family === "netlink" ? /^([A-Z_]+):/.exec(inode ?? "")?.[1] : undefined;
  const protocol = subsystem ? ` ${subsystem}` : "";
  if (addresses.length > 0) {
    if (op === "connect" && family.startsWith("unix") && inode && addresses[0])
      sockets.connected.set(inode, addresses[0]);
    return addresses.map((to) => ({
      event: JSON.stringify([op, family, `${to}${protocol}`]),
      internal: false,
    }));
  }
  // A send without an address goes to the connected peer, which -yy prints after `->`.
  if (family.startsWith("unix") && peerInode !== undefined) {
    const internal = sockets.pairs.has(inode!) && sockets.pairs.has(peerInode);
    const to = internal ? "socketpair" : (sockets.connected.get(inode!) ?? "connected");
    return [{ event: JSON.stringify([op, family, to]), internal }];
  }
  const to = peerInode === undefined ? "unconnected" : labelAddress(peerInode, labels);
  return [{ event: JSON.stringify([op, family, `${to}${protocol}`]), internal: false }];
}

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC/;
// Argument positions of each path, with the descriptor it is relative to; -1 means none.
const FILE_PATHS: Record<string, [dirfd: number, path: number][]> = {
  open: [[-1, 0]],
  openat: [[0, 1]],
  openat2: [[0, 1]],
  creat: [[-1, 0]],
  mkdir: [[-1, 0]],
  mkdirat: [[0, 1]],
  rename: [
    [-1, 0],
    [-1, 1],
  ],
  renameat: [
    [0, 1],
    [2, 3],
  ],
  renameat2: [
    [0, 1],
    [2, 3],
  ],
  link: [
    [-1, 0],
    [-1, 1],
  ],
  linkat: [
    [0, 1],
    [2, 3],
  ],
  symlink: [[-1, 1]],
  symlinkat: [[1, 2]],
  unlink: [[-1, 0]],
  unlinkat: [[0, 1]],
  rmdir: [[-1, 0]],
  truncate: [[-1, 0]],
};
/** One write-intent file operation. `resolved` is the path the kernel opened, for an open. */
export interface FileEvent {
  op: string;
  paths: string[];
  ok: boolean;
  resolved?: string;
}
/** How an event compares: an open by the path the kernel opened, anything else by its paths. */
export const fileEventKey = (event: FileEvent): string =>
  JSON.stringify([event.op, ...(event.resolved === undefined ? event.paths : [event.resolved])]);
const climbs = (value: string): boolean => value.split("/").includes("..");
/** A working directory, shared between processes that clone with CLONE_FS. */
interface Cwd {
  path: string | undefined;
}
function fileOf(
  call: Syscall,
  outcome: string,
  normalize: (value: string) => string,
  cwd: string | undefined,
  errors: Set<string>,
): FileEvent | undefined {
  const { text, strings } = masked(call.text);
  const args = topLevel(text);
  const flags = call.name.startsWith("open") ? (args[call.name === "open" ? 1 : 2] ?? "") : "";
  if (call.name.startsWith("open") && !WRITE_FLAGS.test(flags)) return undefined;
  const ok = /^\d+$/.test(outcome);
  // A successful O_CREAT|O_EXCL open made a file that did not exist before.
  const created = /O_CREAT/.test(flags) && /O_EXCL/.test(flags) && ok;
  const kernel = /=\s*\d+<([^>]*)>\s*$/.exec(call.text)?.[1];
  const paths: string[] = [];
  for (const [dirfd, index] of FILE_PATHS[call.name] ?? []) {
    const given = unquote(args[index], strings);
    if (given === undefined) {
      errors.add(`a ${call.name} line did not parse`);
      return undefined;
    }
    const base = dirfd >= 0 ? (descriptorPath(args[dirfd]) ?? undefined) : cwd;
    // `..` after a symlink leaves where a lexical join says, and so does a relative path under an
    // unknown directory; only the kernel's own path settles either.
    if (climbs(given) || (!path.isAbsolute(given) && base === undefined)) {
      if (kernel !== undefined && index === FILE_PATHS[call.name]![0]![1]) {
        paths.push(normalize(kernel));
        continue;
      }
      errors.add(
        climbs(given)
          ? "a file path contains .. that the kernel did not resolve"
          : "a file path was relative to an unknown directory",
      );
      return undefined;
    }
    paths.push(normalize(path.isAbsolute(given) ? given : path.join(base!, given)));
  }
  // A symlink's target is kept as written; it says what the link will point at.
  if (call.name === "symlink" || call.name === "symlinkat") {
    const target = unquote(args[0], strings);
    if (target !== undefined) paths.push(normalize(target));
  }
  const op = created
    ? "create"
    : call.name.startsWith("open") || call.name === "creat"
      ? "write"
      : call.name.replace(/at2?$/, "");
  return { op, paths, ok, ...(kernel === undefined ? {} : { resolved: normalize(kernel) }) };
}

/** Updates the per-process working directories from a chdir, fchdir or process creation. */
function trackCwd(call: Syscall, outcome: string, cwds: Map<string, Cwd>): void {
  const own = cwds.get(call.pid);
  if (call.name === "chdir" || call.name === "fchdir") {
    if (outcome !== "0") return;
    const { text, strings } = masked(call.text);
    const arg = topLevel(text)[0];
    const given = call.name === "chdir" ? unquote(arg, strings) : descriptorPath(arg);
    // A chdir through `..` is unknown until the kernel reports the directory (AT_FDCWD).
    const next =
      given === undefined || (call.name === "chdir" && climbs(given))
        ? undefined
        : path.isAbsolute(given)
          ? given
          : own?.path === undefined
            ? undefined
            : path.join(own.path, given);
    if (own) own.path = next;
    else cwds.set(call.pid, { path: next });
    return;
  }
  // clone, clone3, fork, vfork: the result is the child's pid. A child that already reported
  // its own chdir keeps it.
  if (!/^\d+$/.test(outcome) || outcome === "0" || cwds.has(outcome)) return;
  cwds.set(outcome, /CLONE_FS/.test(call.text) && own ? own : { path: own?.path });
}

/**
 * Parses an strace log. The first exec must be `root` (the traced command); it is returned
 * separately. Failed PATH probes are dropped from execs; socket and file operations count whether
 * or not they succeeded. A truncated argument, a line that does not parse, an exec path without a
 * known directory, or a call start and resumption that do not pair up sets `error`.
 */
export function parseTrace(
  text: string,
  root: string,
  rewrites: readonly ExecRewrite[],
  labels: AddressLabels = new Map(),
  /** The traced command's working directory when it started, when known. */
  cwd?: string,
): ParsedTrace {
  const normalize = rewriter(rewrites);
  const normalizePath = (value: string): string => applyPathPatterns(normalize(value));
  const { calls, errors } = pairSyscalls(text);
  const executed: string[][] = [];
  const net = new Set<string>();
  const internal = new Set<string>();
  const files = new Set<string>();
  const fileLog: FileEvent[] = [];
  let ioUring = 0;
  const sockets: SocketState = { pairs: new Set(), connected: new Map() };
  const cwds = new Map<string, Cwd>();
  if (calls[0]) cwds.set(calls[0].pid, { path: cwd });
  for (const call of calls) {
    // -yy prints the kernel's working directory for AT_FDCWD; it replaces any lexical guess.
    const at = /AT_FDCWD<([^>]*)>/.exec(call.text)?.[1];
    if (at !== undefined) {
      const own = cwds.get(call.pid);
      if (own) own.path = at;
      else cwds.set(call.pid, { path: at });
    }
    const outcome = result(call.text);
    if (outcome === undefined) {
      errors.add(`a ${call.name} line did not parse`);
      continue;
    }
    if (EXEC_CALLS.includes(call.name)) {
      const exec = execOf(call, errors);
      // `= ?` means the tracee died during the call; it is counted as executed.
      if (exec && (outcome === "0" || outcome === "?")) executed.push(exec);
    } else if (PAIR_CALLS.includes(call.name)) {
      for (const match of call.text.matchAll(/<UNIX-[A-Z]+:\[(\d+)->(\d+)\]>/g))
        sockets.pairs.add(match[1]!).add(match[2]!);
    } else if (NET_CALLS.includes(call.name)) {
      for (const entry of netOf(call, labels, normalizePath, sockets))
        (entry.internal ? internal : net).add(entry.event);
    } else if (FILE_CALLS.includes(call.name)) {
      const event = fileOf(call, outcome, normalizePath, cwds.get(call.pid)?.path, errors);
      if (event) {
        fileLog.push(event);
        files.add(fileEventKey(event));
      }
    } else if (CWD_CALLS.includes(call.name)) trackCwd(call, outcome, cwds);
    else if (RING_CALLS.includes(call.name)) ioUring += 1;
  }
  const [first, ...rest] = executed;
  if (first?.[0] !== root) errors.add("the first exec is not the traced command");
  const key = (exec: string[]): string => JSON.stringify(exec.map(normalize));
  return {
    root: first ? key(first) : null,
    execs: rest.map(key),
    raw: rest.map((exec) => JSON.stringify(exec)),
    net: [...net].sort(),
    internal: [...internal].sort(),
    files: [...files].sort(),
    fileLog,
    ioUring,
    error: errors.size > 0 ? [...errors].join("; ") : null,
  };
}
