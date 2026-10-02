// Synthetic probe summaries for the codex:qualify rule tests, shaped like the collectors' output.
import {
  PROBE_SCENARIOS,
  type ExecTrace,
  type ProbeSet,
  type ProbeSummary,
} from "../../scripts/lib/codex-qualify-checks.js";
import type { FileEvent } from "../../scripts/lib/strace.js";

export const exec = (...argv: string[]): string => JSON.stringify(argv);
export const event = (...parts: string[]): string => JSON.stringify(parts);
// The startup helpers every release runs: a bubblewrap probe and OS information.
export const HELPERS = [
  exec(
    "/usr/bin/bwrap",
    "bwrap",
    "--unshare-user",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "/bin/true",
  ),
  exec("/usr/bin/lsb_release", "lsb_release", "-a"),
];
export const CODE_MODE_HOST = exec(
  "<codex>/bin/codex-code-mode-host",
  "<codex>/bin/codex-code-mode-host",
);
export const NET = [event("connect", "tcp", "<loopback>"), event("send", "netlink", "AF_NETLINK")];
const FILES = [
  event("write", "<codex-home>/state_5.sqlite"),
  event("write", "<codex-home>/state_5.sqlite-wal"),
  event("mkdir", "<codex-home>/tmp/arg0/codex-arg0<tmp>"),
];

// The ordered log behind files: each open succeeded on the very path it named.
const FILE_LOG = FILES.map((key) => {
  const [op, ...paths] = JSON.parse(key) as string[];
  return { op: op!, paths, ok: true, ...(op === "write" ? { resolved: paths[0] } : {}) };
});

/** A successful file operation; an open resolves to the path it named unless `resolved` says otherwise. */
export const fileEvent = (op: string, paths: string[], resolved?: string): FileEvent => ({
  op,
  paths,
  ok: true,
  ...(resolved !== undefined
    ? { resolved }
    : op === "write" || op === "create"
      ? { resolved: paths[0] }
      : {}),
});
/** The default file log plus `extra`, with the matching key list. */
export function withFileLog(...extra: FileEvent[]): Pick<ExecTrace, "files" | "fileLog"> {
  const fileLog = [...FILE_LOG, ...extra];
  return {
    fileLog,
    files: [...new Set(fileLog.map((entry) => JSON.stringify([entry.op, ...entry.paths])))].sort(),
  };
}

export function traced(execs: string[], overrides: Partial<ExecTrace> = {}): ExecTrace {
  return {
    ok: true,
    error: null,
    survived: false,
    execs,
    raw: execs,
    net: [...NET],
    internal: [],
    files: [...FILES],
    fileLog: FILE_LOG.map((event) => ({ ...event, paths: [...event.paths] })),
    ioUring: 0,
    ...overrides,
  };
}
export const escapeOutput = (names: string[], calls: Record<string, boolean | string>): string =>
  [
    "Script completed",
    JSON.stringify({ names }),
    ...Object.entries(calls).map(([n, outcome]) =>
      JSON.stringify(
        outcome === true
          ? { n, ok: true }
          : { n, ok: false, error: outcome === false ? "disabled" : outcome },
      ),
    ),
    JSON.stringify({ globals: ["undefined", "undefined", "undefined", "undefined"] }),
    "fetch-refused",
  ].join("\n");

export function summary(overrides: Partial<ProbeSummary> = {}): ProbeSummary {
  return {
    error: null,
    turn: "completed",
    userAgentShape: "humanish_analysis/<version> (Linux)",
    tools: ["functions.exec", "functions.wait"],
    nestedTools: ["clock__curr_time"],
    hostCanaryPresent: false,
    instructionSources: [],
    outputs: {},
    events: ["a", "b"],
    serverRequests: [],
    toolCalls: 1,
    inspection: { ok: true, error: null, samples: 20 },
    trace: traced([...HELPERS]),
    exitedBeforeStop: false,
    processes: [],
    aliveAfterStop: [],
    uninspectable: [],
    unixSockets: [],
    tcpRemotes: ["<loopback>"],
    udpRemotes: [],
    files: {
      error: null,
      added: ["home/state_5.sqlite file", "home/.sandbox_migration file"],
      removed: [],
      retyped: [],
      resized: [],
    },
    preexisting: ["<probe>", "<codex-home>", "<codex-home>/config.toml", "<probe>/cwd/AGENTS.md"],
    developerInstructions: "same",
    ...overrides,
  };
}
export function probeSet(
  escape = escapeOutput(["clock__curr_time", "humanish_ui"], { clock__curr_time: true }),
): ProbeSet {
  const set = Object.fromEntries(PROBE_SCENARIOS.map((s) => [s, summary()])) as ProbeSet;
  for (const s of ["participant", "escape"] as const)
    set[s] = summary({
      trace: traced([...HELPERS, CODE_MODE_HOST]),
      processes: ["codex-code-mode-host"],
      ...(s === "escape" ? { outputs: { "code-1": escape } } : {}),
    });
  return set;
}
export const failed = (checks: { check: string; pass: boolean }[]): string[] =>
  checks.filter((entry) => !entry.pass).map((entry) => entry.check);
