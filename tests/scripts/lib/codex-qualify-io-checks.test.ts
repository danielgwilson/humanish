import { describe, expect, it } from "vitest";
import {
  comparedFileEvents,
  fileChecks,
  liveChecks,
  networkChecks,
  prepChecks,
  type CommandTrace,
  type LiveObservation,
} from "../../../scripts/lib/codex-qualify-io-checks.js";
import {
  fileEvent,
  withFileLog,
  HELPERS,
  NET,
  event,
  exec,
  failed,
  probeSet,
  summary,
  traced,
} from "../../helpers/codex-qualify-fixtures.js";

describe("codex:qualify network checks", () => {
  it("passes when each scenario reaches what the baseline reached", () => {
    expect(failed(networkChecks(probeSet(), probeSet()))).toEqual([]);
  });

  it("fails on a unix client connection to a daemon the baseline never reached", () => {
    // Codex's P1: the client socket is unnamed, so only the traced connect shows the path.
    const candidate = probeSet();
    const daemon = event(
      "connect",
      "unix-stream",
      "/srv/op/.codex/app-server-control/app-server-control.sock",
    );
    candidate.participant = summary({ trace: traced([...HELPERS], { net: [...NET, daemon] }) });
    const checks = networkChecks(probeSet(), candidate);
    expect(failed(checks)).toEqual([
      "each scenario's socket operations stay within the same baseline scenario's",
    ]);
    expect(checks[0]!.detail).toEqual({ participant: [daemon] });
  });

  it("fails on any TCP or UDP destination other than the loopback provider, even a brief one", () => {
    const external = [event("send", "udp", "10.0.0.2:53")];
    const baseline = probeSet();
    baseline.inventory = summary({ trace: traced([...HELPERS], { net: [...NET, ...external] }) });
    const candidate = probeSet();
    candidate.inventory = summary({ trace: traced([...HELPERS], { net: [...NET, ...external] }) });
    expect(failed(networkChecks(baseline, candidate))).toEqual([
      "TCP and UDP destinations are only the loopback provider",
    ]);
  });
});

describe("codex:qualify file checks", () => {
  it("passes when each scenario changes what the baseline changed", () => {
    expect(failed(fileChecks(probeSet(), probeSet()))).toEqual([]);
  });

  it("fails on a new file in a later scenario, not only in the inventory scenario", () => {
    // Codex's reproduction: new-secret.txt in the escape capture passed every check.
    const candidate = probeSet();
    candidate.escape = {
      ...candidate.escape,
      files: {
        ...candidate.escape.files,
        added: [...candidate.escape.files.added, "home/sub/new-secret.txt file"],
      },
      trace: {
        ...candidate.escape.trace,
        ...withFileLog(fileEvent("write", ["<codex-home>/sub/new-secret.txt"])),
      },
    };
    expect(failed(fileChecks(probeSet(), candidate))).toEqual([
      "each scenario's added, removed and retyped entries stay within the same baseline scenario's (known database sidecars excepted)",
      "each scenario's file writes stay within the same baseline scenario's (known database sidecars and removal of the run's own files excepted)",
    ]);
  });

  it("fails on a write outside the work directory, which no snapshot sees", () => {
    const candidate = probeSet();
    candidate.denials = summary({
      trace: traced([...HELPERS], withFileLog(fileEvent("write", ["/srv/op/.bashrc"]))),
    });
    expect(failed(fileChecks(probeSet(), candidate))).toEqual([
      "each scenario's file writes stay within the same baseline scenario's (known database sidecars and removal of the run's own files excepted)",
    ]);
  });

  it("skips only known-database sidecars and removal of the run's own files", () => {
    const preexisting = ["<codex-home>", "<codex-home>/config.toml"];
    expect(
      comparedFileEvents(
        [
          fileEvent("write", ["<codex-home>/logs_2.sqlite-journal"]),
          fileEvent("unlink", ["<codex-home>/queue_1.sqlite-shm"]),
          fileEvent("write", ["<codex-home>/tmp/arg0/codex-arg0<tmp>/.lock"]),
          fileEvent("unlink", ["<codex-home>/tmp/arg0/codex-arg0<tmp>/.lock"]),
          fileEvent("unlink", ["<codex-home>/config.toml"]),
          fileEvent("write", ["<codex-home>/unrelated-wal"]),
          fileEvent("unlink", ["<operator-codex-home>/auth.json"]),
        ],
        preexisting,
      ),
    ).toEqual([
      event("unlink", "<codex-home>/config.toml"),
      event("unlink", "<operator-codex-home>/auth.json"),
      event("write", "<codex-home>/tmp/arg0/codex-arg0<tmp>/.lock"),
      event("write", "<codex-home>/unrelated-wal"),
    ]);
  });

  it("skips a file the run created exclusively and removed, but not one it only opened", () => {
    expect(
      comparedFileEvents(
        [
          fileEvent("create", ["/var/tmp/etilqs_0123456789abcdef"]),
          fileEvent("unlink", ["/var/tmp/etilqs_0123456789abcdef"]),
          fileEvent("write", ["/srv/op/.bashrc"]),
          fileEvent("unlink", ["/srv/op/.bashrc"]),
        ],
        [],
      ),
    ).toEqual([event("unlink", "/srv/op/.bashrc"), event("write", "/srv/op/.bashrc")]);
  });

  it("fails when a snapshot could not be taken", () => {
    const candidate = probeSet();
    candidate.questions = summary({
      files: { error: "EACCES", added: [], removed: [], retyped: [], resized: [] },
    });
    expect(failed(fileChecks(probeSet(), candidate))).toContain(
      "work directory snapshots taken before and after every probe",
    );
  });
});

describe("codex:qualify preparatory commands", () => {
  const command = (overrides: Partial<CommandTrace> = {}): CommandTrace => ({
    ...traced([]),
    preexisting: ["<codex-home>"],
    ...overrides,
  });
  it("fails when --version or schema generation runs something the baseline's did not", () => {
    const base = { "--version": command(), "generate-json-schema": command() };
    expect(failed(prepChecks(base, { ...base }))).toEqual([]);
    const cand = {
      ...base,
      "--version": command({ execs: [exec("/bin/sh", "sh", "-c", "curl x")] }),
    };
    expect(failed(prepChecks(base, cand))).toEqual([
      "preparatory commands' execs, sockets and file writes stay within the baseline's",
    ]);
    // The schema generator's own output is compared by the protocol checks, not here.
    const schema = {
      ...base,
      "generate-json-schema": command(
        withFileLog(fileEvent("write", ["<schema-out>/v2/New.json"])),
      ),
    };
    expect(failed(prepChecks(base, schema))).toEqual([]);
    const outside = {
      ...base,
      "generate-json-schema": command(withFileLog(fileEvent("write", ["/srv/op/.profile"]))),
    };
    expect(failed(prepChecks(base, outside))).toEqual([
      "preparatory commands' execs, sockets and file writes stay within the baseline's",
    ]);
    const untraced = {
      ...base,
      "--version": command({ ok: false, error: "strace is not on PATH" }),
    };
    expect(failed(prepChecks(base, untraced))).toContain(
      "preparatory commands ran under strace (--version, schema, features)",
    );
  });
});

describe("codex:qualify live checks", () => {
  const LIVE_NET = [
    event("connect", "tcp", "<chatgpt.com>:443"),
    event("send", "udp", "<resolver>:53"),
  ];
  const launch = (overrides: Partial<LiveObservation> = {}): LiveObservation => ({
    phase: "analyst turn",
    inspection: { ok: true, error: null, samples: 40 },
    processes: [],
    aliveAfterStop: [],
    uninspectable: [],
    unixSockets: [],
    tcpRemotes: ["<chatgpt.com>:443"],
    udpRemotes: [],
    trace: traced([...HELPERS], { net: LIVE_NET }),
    preexisting: ["<codex-home>", "<codex-home>/config.toml"],
    ...overrides,
  });
  const version = launch({
    phase: "analyst turn (--version)",
    inspection: null,
    trace: traced([], { net: [] }),
  });
  const base = [version, launch()];

  it("passes when each launch matches the baseline's same launch", () => {
    expect(failed(liveChecks(base, [version, launch()], []))).toEqual([]);
  });

  it("fails on a traced daemon connection even when the sampler saw nothing", () => {
    const daemon = event(
      "connect",
      "unix-stream",
      "<operator-codex-home>/app-server-control/app-server-control.sock",
    );
    const both = [version, launch({ trace: traced([...HELPERS], { net: [...LIVE_NET, daemon] }) })];
    const checks = failed(liveChecks(both, both, []));
    expect(checks).toEqual(["live: no connection to a Codex daemon socket (strace and sampler)"]);
  });

  it("fails on a destination other than the backend and the resolver, and on an exec the baseline launch never ran", () => {
    const stray = [
      version,
      launch({
        trace: traced([...HELPERS], {
          net: [...LIVE_NET, event("connect", "tcp", "93.184.216.34:443")],
        }),
      }),
    ];
    expect(failed(liveChecks(stray, stray, []))).toEqual([
      "live: TCP and UDP destinations are only the account backend and the resolver",
    ]);
    const extra = [
      version,
      launch({
        trace: traced([...HELPERS, exec("/usr/bin/notify-send", "notify-send", "done")], {
          net: LIVE_NET,
        }),
      }),
    ];
    expect(failed(liveChecks(base, extra, []))).toEqual([
      "live: each launch's execs, sockets and file writes stay within the baseline's same launch",
    ]);
  });

  it("fails when a launch has no baseline counterpart or the app-server could not be inspected", () => {
    expect(failed(liveChecks([version], [version, launch()], []))).toContain(
      "live: each launch's execs, sockets and file writes stay within the baseline's same launch",
    );
    const blind = [version, launch({ inspection: { ok: false, error: "EACCES", samples: 3 } })];
    expect(failed(liveChecks(base, blind, []))).toEqual([
      "live: process inspection succeeded for every launched app-server",
    ]);
  });
});

describe("codex:qualify exemptions an honest release or the harness could slip through", () => {
  const ev = (op: string, path: string, ok = true, resolved?: string) => ({
    op,
    paths: [path],
    ok,
    ...(resolved === undefined ? {} : { resolved }),
  });
  const TMP = "/var/tmp/etilqs_0123456789abcdef";
  const JOURNAL = "<codex-home>/logs_2.sqlite-journal";

  it("does not treat a failed unlink as a removal", () => {
    expect(
      comparedFileEvents([ev("create", TMP, true, TMP), ev("unlink", TMP, false)], []),
    ).toEqual([event("create", TMP), event("unlink", TMP)]);
    expect(comparedFileEvents([ev("create", TMP, true, TMP), ev("unlink", TMP)], [])).toEqual([]);
  });

  it("judges create, unlink and recreate in order", () => {
    const log = [ev("create", TMP, true, TMP), ev("unlink", TMP), ev("create", TMP, true, TMP)];
    expect(comparedFileEvents(log, [])).toEqual([event("create", TMP), event("unlink", TMP)]);
  });

  it("exempts a sidecar only for an open of that very file, or its unlink", () => {
    expect(
      comparedFileEvents([ev("write", JOURNAL, true, JOURNAL), ev("unlink", JOURNAL)], []),
    ).toEqual([]);
    // Opened through a symlink: the kernel opened another file, and that path is compared.
    expect(comparedFileEvents([ev("write", JOURNAL, true, "/srv/op/notes.txt")], [])).toEqual([
      event("write", "/srv/op/notes.txt"),
    ]);
  });

  it("never exempts a symlink, link or rename that names a sidecar", () => {
    const log = [
      { op: "symlink", paths: [JOURNAL], ok: true },
      { op: "link", paths: ["/srv/op/notes.txt", JOURNAL], ok: true },
      { op: "rename", paths: ["<codex-home>/staged", JOURNAL], ok: true },
    ];
    expect(comparedFileEvents(log, [])).toEqual([
      event("link", "/srv/op/notes.txt", JOURNAL),
      event("rename", "<codex-home>/staged", JOURNAL),
      event("symlink", JOURNAL),
    ]);
  });

  it("compares a failed removal of the run's own file", () => {
    const own = "<codex-home>/tmp/arg0/codex-arg0<tmp>/.lock";
    const made = ev("write", own, true, own);
    expect(comparedFileEvents([made, ev("unlink", own)], [])).toEqual([event("write", own)]);
    expect(comparedFileEvents([made, ev("unlink", own, false)], [])).toEqual([
      event("unlink", own),
      event("write", own),
    ]);
  });
});

describe("codex:qualify schema output", () => {
  const command = (fileLog: { op: string; paths: string[]; ok: boolean; resolved?: string }[]) => ({
    ...traced([], { fileLog, files: fileLog.map((entry) => event(entry.op, ...entry.paths)) }),
    preexisting: ["<codex-home>"],
  });
  const base = { "generate-json-schema": command([]) };
  const SCHEMA = "<schema-out>/v2/New.json";

  it("skips a write the kernel resolved inside the schema output directory", () => {
    const inside = command([{ op: "write", paths: [SCHEMA], ok: true, resolved: SCHEMA }]);
    expect(failed(prepChecks(base, { "generate-json-schema": inside }))).toEqual([]);
  });

  it("compares a write that climbs out with .. or resolves elsewhere", () => {
    const climb = "<schema-out>/../../outside.txt";
    for (const fileLog of [
      [{ op: "write", paths: [climb], ok: true, resolved: climb }],
      [{ op: "write", paths: [SCHEMA], ok: true, resolved: "/srv/op/outside.txt" }],
    ])
      expect(failed(prepChecks(base, { "generate-json-schema": command(fileLog) }))).toEqual([
        "preparatory commands' execs, sockets and file writes stay within the baseline's",
      ]);
  });
});

describe("codex:qualify live sampler and io_uring", () => {
  const LIVE_NET = [event("connect", "tcp", "<chatgpt.com>:443")];
  const launch = (overrides: Partial<LiveObservation> = {}): LiveObservation => ({
    phase: "analyst turn",
    inspection: { ok: true, error: null, samples: 40 },
    processes: [],
    aliveAfterStop: [],
    uninspectable: [],
    unixSockets: [],
    tcpRemotes: ["<chatgpt.com>:443"],
    udpRemotes: [],
    trace: traced([...HELPERS], { net: LIVE_NET }),
    preexisting: [],
    ...overrides,
  });

  it("fails when the baseline's sampler failed, as it does for the candidate", () => {
    const blind = launch({ inspection: { ok: false, error: "EACCES", samples: 2 } });
    expect(failed(liveChecks([blind], [launch()], []))).toEqual([
      "live: process inspection succeeded for every launched app-server",
    ]);
  });

  it("compares sampled TCP and UDP remotes, which catch traffic the trace missed", () => {
    expect(failed(liveChecks([launch()], [launch()], []))).toEqual([]);
    const extra = launch({ tcpRemotes: ["<chatgpt.com>:443", "93.184.216.34:443"] });
    expect(failed(liveChecks([launch()], [extra], []))).toEqual([
      "live: sampled TCP and UDP remotes stay within the baseline launch's and the allowed destinations",
    ]);
  });

  it("fails on any io_uring setup, whose operations the trace cannot see", () => {
    const ring = launch({ trace: traced([...HELPERS], { net: LIVE_NET, ioUring: 1 }) });
    expect(failed(liveChecks([launch()], [ring], []))).toContain(
      "live: no traced process set up io_uring",
    );
    const offline = probeSet();
    offline.inventory = summary({ trace: traced([...HELPERS], { ioUring: 1 }) });
    expect(failed(networkChecks(probeSet(), offline))).toContain(
      "no traced process set up io_uring",
    );
  });
});

describe("codex:qualify path exemptions and baseline checks", () => {
  it("never exempts a removal that climbs out of the private directory with ..", () => {
    // Codex's reproduction: <codex-home>/../../shared-cache was exempt as the run's own file.
    const escape = "<codex-home>/../../shared-cache";
    expect(comparedFileEvents([fileEvent("unlink", [escape])], [])).toEqual([
      event("unlink", escape),
    ]);
  });

  it("exempts a private removal only when the run created that path earlier", () => {
    const stale = "<codex-home>/stale.json";
    expect(comparedFileEvents([fileEvent("unlink", [stale])], [])).toEqual([
      event("unlink", stale),
    ]);
    expect(
      comparedFileEvents([fileEvent("write", [stale]), fileEvent("unlink", [stale])], []),
    ).toEqual([event("write", stale)]);
  });

  it("compares a write on the path the kernel opened", () => {
    const lexical = "<probe>/cwd/notes.txt";
    const baseline = [fileEvent("write", [lexical])];
    const candidate = [fileEvent("write", [lexical], "/var/lib/codex/notes.txt")];
    expect(comparedFileEvents(candidate, [])).toEqual([event("write", "/var/lib/codex/notes.txt")]);
    expect(comparedFileEvents(baseline, [])).not.toEqual(comparedFileEvents(candidate, []));
  });

  it("fails the preparatory commands when the baseline set up io_uring", () => {
    const command = (ioUring: number) => ({ ...traced([], { ioUring }), preexisting: [] });
    expect(
      failed(
        prepChecks(
          { "features list (analyst)": command(1) },
          { "features list (analyst)": command(0) },
        ),
      ),
    ).toEqual(["preparatory commands' execs, sockets and file writes stay within the baseline's"]);
  });
});
