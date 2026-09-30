// Pass/fail rules for `pnpm codex:qualify`. Each rule compares a candidate Codex CLI release with a
// release already qualified on the same host; the capture code lives in codex-loopback-probe.mjs.
import path from "node:path";
import type { FileEvent } from "./strace.js";

export const PROBE_SCENARIOS = [
  "inventory",
  "denials",
  "questions",
  "participant",
  "escape",
] as const;
export type ProbeScenario = (typeof PROBE_SCENARIOS)[number];

export interface QualifyCheck {
  check: string;
  pass: boolean;
  detail: unknown;
}
export interface ProtocolSummary {
  threadItems: string[];
  responseItems: string[];
  serverRequests: string[];
  serverNotifications: string[];
  files: Record<string, string>;
}
export interface FeatureSummary {
  table: Record<string, { stage: string; enabled: boolean }>;
  pinned: string[];
}
export interface ProbeSummary {
  error: string | null;
  turn: string;
  userAgentShape: string;
  tools: string[];
  nestedTools: string[];
  hostCanaryPresent: boolean;
  instructionSources: unknown;
  outputs: Record<string, string>;
  events: string[];
  serverRequests: { method: string; tool: string | null }[];
  toolCalls: number;
  inspection: { ok: boolean; error: string | null; samples: number };
  /** Every successful execve under strace, normalized; `survived` means strace outlived the app-server. */
  trace: ExecTrace;
  /** The app-server had exited before the probe stopped it. */
  exitedBeforeStop: boolean;
  /** Executable basenames the sampler saw besides the app-server itself (for review). */
  processes: string[];
  aliveAfterStop: string[];
  /** Names (comm) of live descendants whose descriptors the kernel refused to the sampler. */
  uninspectable: string[];
  /** Unix socket paths (bound or reached), with the probe's private directory shown as `<probe>`. */
  unixSockets: string[];
  /** TCP remotes, with the loopback provider shown as `<loopback>`. */
  tcpRemotes: string[];
  /** Connected UDP remotes; `*` is an unconnected UDP socket. */
  udpRemotes: string[];
  /** The recursive before/after snapshot of the probe's work directory. */
  files: FileChanges;
  /** Normalized paths that existed before the app-server started. */
  preexisting: string[];
  developerInstructions: string;
}
export interface FileChanges {
  error: string | null;
  added: string[];
  removed: string[];
  retyped: string[];
  resized: string[];
}
export type ProbeSet = Record<ProbeScenario, ProbeSummary>;
export interface ExecTrace {
  ok: boolean;
  error: string | null;
  survived: boolean;
  /** Execs after the traced app-server's own, as JSON arrays of program then argv, rewritten. */
  execs: string[];
  /** The same execs as strace recorded them, index for index. */
  raw: string[];
  /** Socket operations as JSON `[op, family, destination]`. */
  net: string[];
  /** Sends between the ends of a socketpair inside the traced tree (for review). */
  internal: string[];
  /** Write-intent file operations as JSON `[op, ...paths]`. */
  files: string[];
  /** The same operations in the order they finished, with their outcome. */
  fileLog: FileEvent[];
  /** io_uring_setup calls; any ring fails qualification. */
  ioUring: number;
}
/** The probe's canary; it appears only in model-supplied tool arguments. */
export const PROBE_CANARY = "HOST_CANARY_7f3a91";

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const subset = (a: readonly string[], b: readonly string[]): boolean =>
  a.every((item) => b.includes(item));
export const added = (a: readonly string[], b: readonly string[]): string[] =>
  b.filter((item) => !a.includes(item));

function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The baseline must already be qualified on this host and must not be the candidate. */
export function selectBaseline(
  candidate: string,
  qualified: readonly string[],
  requested?: string,
): { baseline: string } | { error: string } {
  if (requested !== undefined) {
    if (requested === candidate) return { error: "The baseline cannot be the candidate." };
    if (!qualified.includes(requested))
      return {
        error: `Baseline ${requested} is not qualified on this host (${qualified.join(", ") || "none"}).`,
      };
    return { baseline: requested };
  }
  const older = qualified.filter((version) => compareVersions(version, candidate) < 0);
  const baseline = older.at(-1);
  return baseline === undefined
    ? {
        error:
          "No qualified release older than the candidate; pass --baseline <qualified release>.",
      }
    : { baseline };
}

export interface EscapeResult {
  names: string[];
  /** Each call's outcome; `error` is the thrown message, which separates refusal from bad input. */
  calls: Record<string, { ok: boolean; error: string | null }>;
  globals: string[] | null;
  fetch: "refused" | "reached" | null;
}
/** Reads the escape probe's JSON lines: the isolate's own tool keys and each call's outcome. */
export function parseEscapeOutput(text: string): EscapeResult | null {
  const result: EscapeResult = { names: [], calls: {}, globals: null, fetch: null };
  let sawNames = false;
  for (const line of text.split("\n").map((entry) => entry.trim())) {
    if (line === "fetch-refused" || line === "fetch-reached") {
      result.fetch = line === "fetch-refused" ? "refused" : "reached";
      continue;
    }
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.names)) {
      result.names = record.names.map(String);
      sawNames = true;
    } else if (typeof record.n === "string" && typeof record.ok === "boolean")
      result.calls[record.n] = {
        ok: record.ok,
        error: typeof record.error === "string" ? record.error : null,
      };
    else if (Array.isArray(record.globals)) result.globals = record.globals.map(String);
  }
  return sawNames ? result : null;
}
const succeeded = (escape: EscapeResult): string[] =>
  Object.keys(escape.calls).filter((name) => escape.calls[name]!.ok);

export function protocolChecks(base: ProtocolSummary, cand: ProtocolSummary): QualifyCheck[] {
  const changed = Object.keys(cand.files).filter((name) => base.files[name] !== cand.files[name]);
  return [
    {
      check: "thread item types unchanged",
      pass: same(base.threadItems, cand.threadItems),
      detail: added(base.threadItems, cand.threadItems),
    },
    {
      check: "raw response item types unchanged",
      pass: same(base.responseItems, cand.responseItems),
      detail: added(base.responseItems, cand.responseItems),
    },
    {
      check: "server request methods unchanged",
      pass: same(base.serverRequests, cand.serverRequests),
      detail: added(base.serverRequests, cand.serverRequests),
    },
    {
      check: "new server notifications (review)",
      pass: true,
      detail: added(base.serverNotifications, cand.serverNotifications),
    },
    { check: "changed protocol files used by the launcher (review)", pass: true, detail: changed },
  ];
}

export function featureChecks(
  base: Record<"analyst" | "participant", FeatureSummary>,
  cand: Record<"analyst" | "participant", FeatureSummary>,
): QualifyCheck[] {
  return (["analyst", "participant"] as const).flatMap((mode) => {
    const [b, c] = [base[mode], cand[mode]];
    const drift = b.pinned.filter((name) => !same(b.table[name], c.table[name]));
    const enabled = Object.keys(c.table).filter(
      (name) => c.table[name]!.enabled && !b.table[name]?.enabled,
    );
    return [
      {
        check: `${mode}: pinned features keep stage and value`,
        pass: drift.length === 0,
        detail: drift,
      },
      { check: `${mode}: newly enabled features (review)`, pass: true, detail: enabled },
    ];
  });
}

/** The SQLite databases these releases are known to create; their sidecars come and go. */
export const KNOWN_DATABASES = [
  "goals_1.sqlite",
  "logs_2.sqlite",
  "memories_1.sqlite",
  "queue_1.sqlite",
  "state_5.sqlite",
] as const;
const distinct = (lists: readonly string[][]): string[] => [...new Set(lists.flat())].sort();
/** Execs the baseline never ran, each with the raw argv strace recorded for it. */
export function addedExecs(
  baseline: readonly string[],
  traces: readonly ExecTrace[],
): { normalized: string; raw: string[] }[] {
  const executed = distinct(traces.map((trace) => trace.execs));
  return added(baseline, executed).map((normalized) => ({
    normalized,
    raw: distinct(
      traces.map((trace) => trace.raw.filter((_, index) => trace.execs[index] === normalized)),
    ),
  }));
}

/** Programs the app-server and its descendants executed, from strace, against the baseline. */
export function execChecks(b: ProbeSet, c: ProbeSet): QualifyCheck[] {
  const [base, cand] = [PROBE_SCENARIOS.map((s) => b[s]), PROBE_SCENARIOS.map((s) => c[s])];
  const baseline = distinct(base.map((summary) => summary.trace.execs));
  const candidate = distinct(cand.map((summary) => summary.trace.execs));
  return [
    {
      check: "process events recorded for every probe (strace -f execve)",
      pass: [...base, ...cand].every((summary) => summary.trace.ok),
      detail: PROBE_SCENARIOS.map(
        (s) => `${s}: ${c[s].trace.error ?? `${c[s].trace.execs.length} execs`}`,
      ),
    },
    {
      // Pooling alone would let a helper move from one profile to another.
      check: "each scenario's execs stay within the same baseline scenario's",
      pass: PROBE_SCENARIOS.every((s) => subset(c[s].trace.execs, b[s].trace.execs)),
      detail: Object.fromEntries(
        PROBE_SCENARIOS.flatMap((s) => {
          const list = addedExecs(b[s].trace.execs, [c[s].trace]);
          return list.length > 0 ? [[s, list]] : [];
        }),
      ),
    },
    {
      check: "executed programs (path and full argv) stay within the baseline's",
      pass: subset(candidate, baseline),
      detail: {
        added: addedExecs(
          baseline,
          cand.map((summary) => summary.trace),
        ),
        candidate,
      },
    },
    {
      check: "no executed program carries a model-supplied probe argument",
      pass: candidate.every((line) => !line.includes(PROBE_CANARY)),
      detail: candidate.filter((line) => line.includes(PROBE_CANARY)),
    },
    {
      check: "every app-server ran until the probe stopped it",
      pass: cand.every((summary) => !summary.exitedBeforeStop),
      detail: PROBE_SCENARIOS.filter((s) => c[s].exitedBeforeStop),
    },
    {
      check: "no traced process outlived the app-server",
      pass: cand.every((summary) => !summary.trace.survived),
      detail: PROBE_SCENARIOS.filter((s) => c[s].trace.survived),
    },
  ];
}

export function isolateCheck(b: ProbeSet, c: ProbeSet): QualifyCheck {
  const baseline = parseEscapeOutput(b.escape.outputs["code-1"] ?? "");
  const candidate = parseEscapeOutput(c.escape.outputs["code-1"] ?? "");
  const everyNameCalled =
    candidate !== null &&
    candidate.names
      .filter((name) => name !== "humanish_ui")
      .every((name) => name in candidate.calls);
  // A tool both releases expose must fail the same way: "disabled" and "missing field" differ.
  const changedErrors =
    baseline && candidate
      ? Object.keys(candidate.calls).filter(
          (name) => name in baseline.calls && !same(baseline.calls[name], candidate.calls[name]),
        )
      : [];
  return {
    check:
      "participant isolate: tool keys, successful calls and error messages stay within the baseline's",
    pass:
      baseline !== null &&
      candidate !== null &&
      everyNameCalled &&
      changedErrors.length === 0 &&
      subset(candidate.names, baseline.names) &&
      subset(succeeded(candidate), succeeded(baseline)) &&
      candidate.globals !== null &&
      candidate.globals.every((value) => value === "undefined") &&
      candidate.fetch === "refused",
    detail: { baseline, candidate, changedErrors },
  };
}

/** A descendant the sampler could not read must be a program strace recorded, with its sockets. */
export const tracedName = (name: string, trace: ExecTrace): boolean =>
  trace.execs.some((exec) => {
    const program = (JSON.parse(exec) as string[])[0] ?? "";
    return program.split("/").pop()!.slice(0, 15) === name;
  });

export function processChecks(b: ProbeSet, c: ProbeSet): QualifyCheck[] {
  const all = [...PROBE_SCENARIOS.map((s) => b[s]), ...PROBE_SCENARIOS.map((s) => c[s])];
  const candidates = PROBE_SCENARIOS.map((s) => c[s]);
  return [
    {
      check: "process inspection succeeded for every probe",
      pass: all.every((summary) => summary.inspection.ok && summary.inspection.samples > 0),
      detail: PROBE_SCENARIOS.map(
        (s) => `${s}: ${c[s].inspection.error ?? `${c[s].inspection.samples} samples`}`,
      ),
    },
    {
      check: "every descendant the sampler could not read is a traced exec",
      pass: [...PROBE_SCENARIOS.map((s) => b[s]), ...candidates].every((summary) =>
        summary.uninspectable.every((name) => tracedName(name, summary.trace)),
      ),
      detail: PROBE_SCENARIOS.map((s) => `${s}: ${c[s].uninspectable.join(",") || "none"}`),
    },
    {
      check: "processes the sampler saw (review)",
      pass: true,
      detail: PROBE_SCENARIOS.map((s) => `${s}: ${c[s].processes.join(",") || "none"}`),
    },
    {
      check: "no observed process outlived its app-server",
      pass: candidates.every((summary) => summary.aliveAfterStop.length === 0),
      detail: candidates.flatMap((summary) => summary.aliveAfterStop),
    },
    {
      check:
        "sampled sockets: TCP and UDP only to the loopback provider, unix sockets only in the probe directory",
      pass: PROBE_SCENARIOS.every(
        (s) =>
          subset(c[s].tcpRemotes, ["<loopback>"]) &&
          c[s].udpRemotes.every(
            (remote) => remote === "<loopback>" || b[s].udpRemotes.includes(remote),
          ) &&
          c[s].unixSockets.every((socket) => socket.startsWith("<probe>/")),
      ),
      detail: {
        tcp: [...new Set(candidates.flatMap((summary) => summary.tcpRemotes))],
        udp: [...new Set(candidates.flatMap((summary) => summary.udpRemotes))],
        unix: [...new Set(candidates.flatMap((summary) => summary.unixSockets))],
      },
    },
  ];
}

export function probeChecks(b: ProbeSet, c: ProbeSet): QualifyCheck[] {
  return [
    {
      check: "every probe turn completed",
      pass: PROBE_SCENARIOS.every(
        (s) => b[s].turn === "completed" && c[s].turn === "completed" && !c[s].error,
      ),
      detail: PROBE_SCENARIOS.map((s) => `${s}:${c[s].turn}`),
    },
    {
      check: "advertised tools are a subset of the baseline",
      pass: subset(c.inventory.tools, b.inventory.tools),
      detail: c.inventory.tools,
    },
    {
      check: "advertised nested Code Mode tools are a subset of the baseline",
      pass: subset(c.inventory.nestedTools, b.inventory.nestedTools),
      detail: { baseline: b.inventory.nestedTools, candidate: c.inventory.nestedTools },
    },
    {
      check: "no host instructions reach the request",
      pass: !c.inventory.hostCanaryPresent && same(c.inventory.instructionSources, []),
      detail: c.inventory.instructionSources,
    },
    {
      check: "all injected tool calls get the baseline denials",
      pass: same(b.denials.outputs, c.denials.outputs) && c.denials.serverRequests.length === 0,
      detail: c.denials.outputs,
    },
    {
      // The launcher rejects the first offending event, so order is reviewed, not required;
      // the sorted comparison still counts each event.
      check: "question tools: baseline outputs and the same event multiset",
      pass:
        same(b.questions.outputs, c.questions.outputs) &&
        same([...b.questions.events].sort(), [...c.questions.events].sort()) &&
        c.questions.serverRequests.length === 0,
      detail: c.questions.outputs,
    },
    {
      check: "question event order (review)",
      pass: true,
      detail: same(b.questions.events, c.questions.events) ? "unchanged" : c.questions.events,
    },
    {
      check: "participant Code Mode lifecycle matches the baseline",
      pass: same(b.participant.events, c.participant.events) && c.participant.toolCalls === 1,
      detail: c.participant.events,
    },
    isolateCheck(b, c),
    ...execChecks(b, c),
    ...processChecks(b, c),
    {
      check: "userAgent shape unchanged",
      pass: b.inventory.userAgentShape === c.inventory.userAgentShape,
      detail: c.inventory.userAgentShape,
    },
    {
      check: "developer instructions (review)",
      pass: true,
      detail:
        b.inventory.developerInstructions === c.inventory.developerInstructions
          ? "unchanged"
          : "changed; see evidence.json",
    },
  ];
}

/**
 * The launcher runs every launch in `<private work>/cwd`; this returns that work directory. The
 * live check follows these directories by path, because other processes on the host (test suites
 * among them) create and remove directories with the same prefix.
 */
export function privateWorkDir(cwd: unknown): string | undefined {
  return typeof cwd === "string" &&
    path.basename(cwd) === "cwd" &&
    path.basename(path.dirname(cwd)).startsWith("humanish-codex-analysis-")
    ? path.dirname(cwd)
    : undefined;
}
export function privateWorkCheck(
  workDirs: readonly string[],
  leftBehind: readonly string[],
): QualifyCheck {
  return {
    check: "live: every launch's private work directory was removed",
    pass: workDirs.length > 0 && leftBehind.length === 0,
    detail: { privateWorkDirs: workDirs.length, leftBehind: leftBehind.length },
  };
}
