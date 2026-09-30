// Network, file, preparatory-command and live rules for `pnpm codex:qualify`. Each compares the
// candidate's strace record (and, offline, its file snapshots) with the baseline's for the same
// scenario or launch; codex-qualify-checks.ts holds the protocol, probe and exec rules.
import {
  KNOWN_DATABASES,
  PROBE_SCENARIOS,
  added,
  addedExecs,
  subset,
  tracedName,
  type ExecTrace,
  type ProbeSet,
  type ProbeSummary,
  type QualifyCheck,
} from "./codex-qualify-checks.js";
import type { FileEvent } from "./strace.js";

const DATABASES = KNOWN_DATABASES.map((db) => db.replace(".", "\\.")).join("|");
const SIDECAR_PATH = new RegExp(
  `^<(?:codex-home|operator-codex-home)>/(?:${DATABASES})-(?:journal|wal|shm)$`,
);
const SIDECAR_ENTRY = new RegExp(`^home/(?:${DATABASES})-(?:journal|wal|shm) file$`);

const key = (event: FileEvent): string => JSON.stringify([event.op, ...event.paths]);
const creates = new Set(["create", "write", "mkdir", "link", "symlink", "truncate"]);
/**
 * Paths the run created exclusively and removed again, judged on the ordered log: the first
 * successful operation on the path is an exclusive create and the last is a successful unlink.
 * A failed unlink is not a removal, and a recreation after the unlink keeps the path.
 */
function transientPaths(log: readonly FileEvent[]): Set<string> {
  const history = new Map<string, string[]>();
  const record = (target: string, op: string): void => {
    history.set(target, [...(history.get(target) ?? []), op]);
  };
  for (const event of log) {
    if (!event.ok) continue;
    if (event.op === "rename") {
      record(event.paths[0]!, "unlink-by-rename");
      record(event.paths[1]!, "create-by-rename");
    } else if (event.op === "link") record(event.paths[1]!, "link");
    else record(event.paths[0]!, event.op);
  }
  return new Set(
    [...history]
      .filter(([, ops]) => ops[0] === "create" && ops.at(-1) === "unlink")
      .map(([target]) => target),
  );
}
/**
 * The file events a comparison uses, judged one occurrence at a time on the ordered log. Three
 * kinds are skipped, all listed in the docs:
 * - an open of a known database's `-journal`, `-wal` or `-shm` file that the kernel resolved to
 *   that very path, or an unlink of it; never a symlink, link or rename naming one;
 * - operations on a path the run created exclusively and removed again (SQLite's temporary
 *   files), wherever it was;
 * - a successful removal of a path the run created inside its private directory.
 */
export function comparedFileEvents(
  log: readonly FileEvent[],
  preexisting: readonly string[],
): string[] {
  const before = new Set(preexisting);
  const transient = transientPaths(log);
  const exempt = (event: FileEvent): boolean => {
    const target = event.paths[0] ?? "";
    if (SIDECAR_PATH.test(target) && event.paths.length === 1) {
      if (event.op === "unlink") return true;
      if ((event.op === "write" || event.op === "create") && event.resolved === target) return true;
    }
    if (
      transient.has(target) &&
      event.paths.length === 1 &&
      (event.op === "unlink" || creates.has(event.op))
    )
      return true;
    const own = /^<(?:codex-home|probe|work)>\//.test(target);
    return (
      (event.op === "unlink" || event.op === "rmdir") && event.ok && own && !before.has(target)
    );
  };
  return [...new Set(log.filter((event) => !exempt(event)).map(key))].sort();
}
/**
 * Writes inside the schema generator's output directory are its output, which the protocol
 * checks compare. Every path must sit under it with no `..`, and an open must have resolved there.
 */
const schemaOutput = (event: FileEvent): boolean => {
  const inside = (entry: string): boolean =>
    entry.startsWith("<schema-out>/") && !entry.split("/").includes("..");
  return (
    event.paths.every((entry) => entry === "<schema-out>" || inside(entry)) &&
    (event.resolved === undefined ? !event.op.match(/^(write|create)$/) : inside(event.resolved))
  );
};
const withoutSchemaOutput = (log: readonly FileEvent[]): FileEvent[] =>
  log.filter((event) => !schemaOutput(event));
const perScenario = (
  b: ProbeSet,
  c: ProbeSet,
  pick: (summary: ProbeSummary) => readonly string[],
): Record<string, string[]> =>
  Object.fromEntries(
    PROBE_SCENARIOS.flatMap((s) => {
      const list = added(pick(b[s]), pick(c[s]));
      return list.length > 0 ? [[s, list]] : [];
    }),
  );
const INET = new Set(["tcp", "tcpv6", "udp", "udpv6"]);
/** Connects and sends over TCP or UDP whose destination fails `allowed`. */
function strayDestinations(net: readonly string[], allowed: (to: string) => boolean): string[] {
  return net.filter((event) => {
    const [op, family, to] = JSON.parse(event) as string[];
    return op !== "bind" && INET.has(family!) && !allowed(to!);
  });
}

export function networkChecks(b: ProbeSet, c: ProbeSet): QualifyCheck[] {
  const candidates = PROBE_SCENARIOS.map((s) => c[s]);
  return [
    {
      check: "each scenario's socket operations stay within the same baseline scenario's",
      pass: PROBE_SCENARIOS.every((s) => subset(c[s].trace.net, b[s].trace.net)),
      detail: perScenario(b, c, (summary) => summary.trace.net),
    },
    {
      check: "TCP and UDP destinations are only the loopback provider",
      pass: candidates.every(
        (summary) => strayDestinations(summary.trace.net, (to) => to === "<loopback>").length === 0,
      ),
      detail: candidates.flatMap((summary) =>
        strayDestinations(summary.trace.net, (to) => to === "<loopback>"),
      ),
    },
    {
      check: "socketpair traffic inside the traced tree (review)",
      pass: true,
      detail: PROBE_SCENARIOS.map((s) => `${s}: ${c[s].trace.internal.length}`),
    },
    {
      // A ring's opens and socket operations bypass the traced syscalls, so any ring fails.
      check: "no traced process set up io_uring",
      pass: [...PROBE_SCENARIOS.map((s) => b[s]), ...candidates].every(
        (summary) => summary.trace.ioUring === 0,
      ),
      detail: PROBE_SCENARIOS.filter((s) => b[s].trace.ioUring + c[s].trace.ioUring > 0),
    },
  ];
}

export function fileChecks(b: ProbeSet, c: ProbeSet): QualifyCheck[] {
  const all = [...PROBE_SCENARIOS.map((s) => b[s]), ...PROBE_SCENARIOS.map((s) => c[s])];
  const addedEntries = (summary: ProbeSummary): string[] =>
    summary.files.added.filter((entry) => !SIDECAR_ENTRY.test(entry));
  const writes = (summary: ProbeSummary): string[] =>
    comparedFileEvents(summary.trace.fileLog, summary.preexisting);
  return [
    {
      check: "work directory snapshots taken before and after every probe",
      pass: all.every((summary) => summary.files.error === null),
      detail: all.flatMap((summary) => (summary.files.error ? [summary.files.error] : [])),
    },
    {
      check:
        "each scenario's added, removed and retyped entries stay within the same baseline scenario's (known database sidecars excepted)",
      pass: PROBE_SCENARIOS.every(
        (s) =>
          subset(addedEntries(c[s]), addedEntries(b[s])) &&
          subset(c[s].files.removed, b[s].files.removed) &&
          subset(c[s].files.retyped, b[s].files.retyped),
      ),
      detail: {
        added: perScenario(b, c, addedEntries),
        removed: perScenario(b, c, (summary) => summary.files.removed),
        retyped: perScenario(b, c, (summary) => summary.files.retyped),
      },
    },
    {
      check:
        "each scenario's file writes stay within the same baseline scenario's (known database sidecars and removal of the run's own files excepted)",
      pass: PROBE_SCENARIOS.every((s) => subset(writes(c[s]), writes(b[s]))),
      detail: perScenario(b, c, writes),
    },
    {
      check: "resized files (review)",
      pass: true,
      detail: PROBE_SCENARIOS.map((s) => `${s}: ${c[s].files.resized.length}`),
    },
  ];
}

/** One traced run of a preparatory command (`--version`, schema generation, feature listing). */
export interface CommandTrace extends ExecTrace {
  preexisting: string[];
}
export function prepChecks(
  b: Record<string, CommandTrace>,
  c: Record<string, CommandTrace>,
): QualifyCheck[] {
  const names = Object.keys(c);
  const differences = (name: string): Record<string, unknown> => {
    const [base, cand] = [b[name], c[name]!];
    if (!base) return { missing: "no baseline run" };
    return {
      execs: addedExecs(base.execs, [cand]),
      net: added(base.net, cand.net),
      files: added(
        comparedFileEvents(withoutSchemaOutput(base.fileLog), base.preexisting),
        comparedFileEvents(withoutSchemaOutput(cand.fileLog), cand.preexisting),
      ),
      ioUring: cand.ioUring > 0 ? [`${cand.ioUring} io_uring_setup`] : [],
    };
  };
  const clean = (name: string): boolean =>
    Object.values(differences(name)).every((value) => Array.isArray(value) && value.length === 0);
  return [
    {
      check: "preparatory commands ran under strace (--version, schema, features)",
      pass: names.length > 0 && names.every((name) => c[name]!.ok && b[name]?.ok === true),
      detail: names.map((name) => `${name}: ${c[name]!.error ?? `${c[name]!.execs.length} execs`}`),
    },
    {
      check: "preparatory commands' execs, sockets and file writes stay within the baseline's",
      pass: names.every(clean),
      detail: Object.fromEntries(
        names.filter((name) => !clean(name)).map((name) => [name, differences(name)]),
      ),
    },
  ];
}

export interface LiveObservation {
  phase: string;
  /** Null for a traced `--version` launch, which the sampler does not follow. */
  inspection: { ok: boolean; error: string | null; samples: number } | null;
  processes: string[];
  aliveAfterStop: string[];
  uninspectable: string[];
  unixSockets: string[];
  tcpRemotes: string[];
  udpRemotes: string[];
  trace: ExecTrace;
  /** Normalized paths in the private work directory when the launch started. */
  preexisting: string[];
}
const DAEMON_SOCKET = /codex-daemon|app-server-control/;
// Live launches reach the account backend and the system resolver, under the labels the run prints.
const liveDestination = (to: string): boolean =>
  /^<chatgpt\.com>:\d+$/.test(to) || to === "<resolver>:53";

/**
 * Compares each candidate launch with the baseline launch of the same phase. Live runs use the
 * operator's login, so a daemon socket is only as far away as the operator home.
 */
export function liveChecks(
  base: readonly LiveObservation[],
  cand: readonly LiveObservation[],
  daemonSockets: readonly string[],
): QualifyCheck[] {
  const baseline = (phase: string): LiveObservation | undefined =>
    base.find((entry) => entry.phase === phase);
  // Both releases' app-servers must have been observed, or the comparison has nothing to stand on.
  const sampled = [...base, ...cand].filter((entry) => entry.inspection !== null);
  const daemon = cand.flatMap((entry) => [
    ...entry.unixSockets
      .filter((socket) => daemonSockets.includes(socket) || DAEMON_SOCKET.test(socket))
      .map((socket) => `${entry.phase}: ${socket}`),
    ...entry.trace.net
      .filter((event) => DAEMON_SOCKET.test(JSON.parse(event)[2] as string))
      .map((event) => `${entry.phase}: ${event}`),
  ]);
  const writes = (entry: LiveObservation): string[] =>
    comparedFileEvents(entry.trace.fileLog, entry.preexisting);
  // The sampler sees sockets held open, including traffic the trace does not name (a write on a
  // connected socket, say). Each remote must appear in the baseline's same launch and be allowed.
  const sampledStrays = cand.flatMap((entry) => {
    const other = baseline(entry.phase);
    return [...entry.tcpRemotes, ...entry.udpRemotes]
      .filter(
        (remote) =>
          !(other && [...other.tcpRemotes, ...other.udpRemotes].includes(remote)) ||
          !(remote === "*" || liveDestination(remote)),
      )
      .map((remote) => `${entry.phase}: ${remote}`);
  });
  const launchDifferences = cand.flatMap((entry): Record<string, unknown>[] => {
    const other = baseline(entry.phase);
    if (!other) return [{ phase: entry.phase, missing: "no baseline launch" }];
    const difference = {
      phase: entry.phase,
      execs: addedExecs(other.trace.execs, [entry.trace]),
      net: added(other.trace.net, entry.trace.net),
      files: added(writes(other), writes(entry)),
    };
    return difference.execs.length + difference.net.length + difference.files.length > 0
      ? [difference]
      : [];
  });
  return [
    {
      check: "live: process inspection succeeded for every launched app-server",
      pass:
        sampled.length > 0 &&
        sampled.every((entry) => entry.inspection!.ok && entry.inspection!.samples > 0),
      detail: sampled.map(
        (entry) =>
          `${entry.phase}: ${entry.inspection!.error ?? `${entry.inspection!.samples} samples`}`,
      ),
    },
    {
      check: "live: every descendant the sampler could not read is a traced exec",
      pass: cand.every((entry) =>
        entry.uninspectable.every((name) => tracedName(name, entry.trace)),
      ),
      detail: cand
        .filter((entry) => entry.uninspectable.length > 0)
        .map((entry) => `${entry.phase}: ${entry.uninspectable.join(",")}`),
    },
    {
      check: "live: no connection to a Codex daemon socket (strace and sampler)",
      pass: daemon.length === 0,
      detail: daemon,
    },
    {
      check: "live: every launch of both releases ran under strace",
      pass: cand.length > 0 && [...cand, ...base].every((entry) => entry.trace.ok),
      detail: cand.map(
        (entry) => `${entry.phase}: ${entry.trace.error ?? `${entry.trace.execs.length} execs`}`,
      ),
    },
    {
      check:
        "live: each launch's execs, sockets and file writes stay within the baseline's same launch",
      pass: launchDifferences.length === 0,
      detail: launchDifferences,
    },
    {
      check:
        "live: sampled TCP and UDP remotes stay within the baseline launch's and the allowed destinations",
      pass: sampledStrays.length === 0,
      detail: sampledStrays,
    },
    {
      check: "live: no traced process set up io_uring",
      pass: [...base, ...cand].every((entry) => entry.trace.ioUring === 0),
      detail: [...base, ...cand]
        .filter((entry) => entry.trace.ioUring > 0)
        .map((entry) => entry.phase),
    },
    {
      check: "live: TCP and UDP destinations are only the account backend and the resolver",
      pass: cand.every((entry) => strayDestinations(entry.trace.net, liveDestination).length === 0),
      detail: cand.flatMap((entry) =>
        strayDestinations(entry.trace.net, liveDestination).map(
          (event) => `${entry.phase}: ${event}`,
        ),
      ),
    },
    {
      check: "live: no observed process outlived its app-server",
      pass: cand.every((entry) => entry.aliveAfterStop.length === 0),
      detail: cand.flatMap((entry) => entry.aliveAfterStop),
    },
  ];
}
