import { describe, expect, it } from "vitest";
import {
  PROBE_CANARY,
  execChecks,
  isolateCheck,
  parseEscapeOutput,
  privateWorkCheck,
  privateWorkDir,
  probeChecks,
  processChecks,
  selectBaseline,
  type ProbeSummary,
} from "../scripts/lib/codex-qualify-checks.js";
import {
  CODE_MODE_HOST,
  HELPERS,
  escapeOutput,
  exec,
  failed,
  probeSet,
  summary,
  traced,
} from "./helpers/codex-qualify-fixtures.js";

const PER_SCENARIO = "each scenario's execs stay within the same baseline scenario's";
const OVERALL = "executed programs (path and full argv) stay within the baseline's";

describe("codex:qualify isolate check", () => {
  it("passes when the isolate exposes and reaches what the baseline did", () => {
    expect(isolateCheck(probeSet(), probeSet()).pass).toBe(true);
  });

  it("fails on an extra tool the isolate exposes and successfully calls", () => {
    // Codex's reproduction: advertised descriptions unchanged, one hidden callable tool.
    const candidate = probeSet(
      escapeOutput(["clock__curr_time", "hidden_shell", "humanish_ui"], {
        clock__curr_time: true,
        hidden_shell: true,
      }),
    );
    expect(isolateCheck(probeSet(), candidate).pass).toBe(false);
  });

  it("fails when a call the baseline refused now succeeds", () => {
    const names = ["clock__curr_time", "humanish_ui", "skills__list"];
    const baseline = probeSet(escapeOutput(names, { clock__curr_time: true, skills__list: false }));
    const candidate = probeSet(escapeOutput(names, { clock__curr_time: true, skills__list: true }));
    expect(isolateCheck(baseline, candidate).pass).toBe(false);
  });

  it("fails when a refused tool now rejects only its input", () => {
    // Codex's reproduction: "disabled" became "name required", and `{}` still throws.
    const names = ["clock__curr_time", "humanish_ui", "skills__read"];
    const baseline = probeSet(
      escapeOutput(names, { clock__curr_time: true, skills__read: "skills__read is disabled" }),
    );
    const candidate = probeSet(
      escapeOutput(names, { clock__curr_time: true, skills__read: "name required" }),
    );
    const check = isolateCheck(baseline, candidate);
    expect(check.pass).toBe(false);
    expect(check.detail).toMatchObject({ changedErrors: ["skills__read"] });
  });

  it("fails closed on missing or incomplete escape output", () => {
    expect(isolateCheck(probeSet(), probeSet("Script completed")).pass).toBe(false);
    const uncalled = probeSet(escapeOutput(["clock__curr_time", "humanish_ui"], {}));
    expect(isolateCheck(probeSet(), uncalled).pass).toBe(false);
    expect(parseEscapeOutput("no json here")).toBeNull();
  });
});

describe("codex:qualify sampler checks", () => {
  it("passes a clean observation", () => {
    expect(failed(processChecks(probeSet(), probeSet()))).toEqual([]);
  });

  it("fails when process inspection failed, even with nothing observed", () => {
    const candidate = probeSet();
    candidate.inventory = summary({ inspection: { ok: false, error: "no /proc", samples: 0 } });
    expect(failed(processChecks(probeSet(), candidate))).toEqual([
      "process inspection succeeded for every probe",
    ]);
  });

  it("accepts an unreadable descendant only when strace recorded it", () => {
    const recorded = probeSet();
    recorded.inventory = summary({ uninspectable: ["bwrap"] });
    expect(failed(processChecks(probeSet(), recorded))).toEqual([]);
    const unknown = probeSet();
    unknown.inventory = summary({ uninspectable: ["mystery"] });
    expect(failed(processChecks(probeSet(), unknown))).toEqual([
      "every descendant the sampler could not read is a traced exec",
    ]);
  });

  it("fails on a survivor, an unexpected socket or a UDP remote", () => {
    const survivor = probeSet();
    survivor.questions = summary({ aliveAfterStop: ["codex-code-mode-host"] });
    expect(failed(processChecks(probeSet(), survivor))).toContain(
      "no observed process outlived its app-server",
    );
    const sockets =
      "sampled sockets: TCP and UDP only to the loopback provider, unix sockets only in the probe directory";
    for (const overrides of [
      { unixSockets: ["/srv/op/.codex/app-server-control/app-server-control.sock"] },
      { tcpRemotes: ["10.0.0.1:443"] },
      { udpRemotes: ["10.0.0.2:53"] },
    ] satisfies Partial<ProbeSummary>[]) {
      const candidate = probeSet();
      candidate.inventory = summary(overrides);
      expect(failed(processChecks(probeSet(), candidate))).toEqual([sockets]);
    }
  });

  it("compares question events as a multiset", () => {
    const reordered = probeSet();
    reordered.questions = summary({ events: ["b", "a"] });
    expect(failed(probeChecks(probeSet(), reordered))).toEqual([]);
    const duplicated = probeSet();
    duplicated.questions = summary({ events: ["a", "a", "b"] });
    expect(failed(probeChecks(probeSet(), duplicated))).toEqual([
      "question tools: baseline outputs and the same event multiset",
    ]);
  });
});

describe("codex:qualify exec trace", () => {
  const withExecs = (execs: string[], raw = execs) => summary({ trace: traced(execs, { raw }) });
  it("passes when the candidate executes what the baseline executed", () => {
    expect(failed(execChecks(probeSet(), probeSet()))).toEqual([]);
  });

  it("fails on a program the baseline never executed and shows raw and normalized argv", () => {
    const candidate = probeSet();
    const added = exec("<probe>/tool", "tool", "-c", "id");
    const raw = exec("/tmp/humanish-qualify-probe-1/tool", "tool", "-c", "id");
    candidate.denials = withExecs([...HELPERS, added], [...HELPERS, raw]);
    const checks = execChecks(probeSet(), candidate);
    expect(failed(checks)).toEqual([PER_SCENARIO, OVERALL]);
    expect(checks.find((entry) => entry.check === OVERALL)?.detail).toMatchObject({
      added: [{ normalized: added, raw: [raw] }],
    });
  });

  it("fails when a helper moves from the participant to an analyst scenario", () => {
    // Codex's reproduction: pooled across scenarios, this passed.
    const candidate = probeSet();
    candidate.denials = withExecs([...HELPERS, CODE_MODE_HOST]);
    expect(failed(execChecks(probeSet(), candidate))).toEqual([PER_SCENARIO]);
  });

  it("fails when only argv[0] or one argument differs from the baseline", () => {
    const argv0 = probeSet();
    argv0.inventory = withExecs([HELPERS[0]!, exec("/usr/bin/lsb_release", "sh", "-a")]);
    expect(failed(execChecks(probeSet(), argv0))).toEqual([PER_SCENARIO, OVERALL]);
    const argument = probeSet();
    argument.inventory = withExecs([
      HELPERS[0]!,
      exec("/usr/bin/lsb_release", "lsb_release", "-a", "-x"),
    ]);
    expect(failed(execChecks(probeSet(), argument))).toEqual([PER_SCENARIO, OVERALL]);
  });

  it("fails when a model-supplied argument reaches an exec, a trace is missing, or strace outlives the app-server", () => {
    const echo = exec("/bin/echo", "echo", PROBE_CANARY);
    const baseline = probeSet();
    baseline.denials = withExecs([...HELPERS, echo]);
    const canary = probeSet();
    canary.denials = withExecs([...HELPERS, echo]);
    expect(failed(execChecks(baseline, canary))).toEqual([
      "no executed program carries a model-supplied probe argument",
    ]);
    const missing = probeSet();
    missing.inventory = summary({
      trace: traced([], { ok: false, error: "strace is not on PATH" }),
    });
    expect(failed(execChecks(probeSet(), missing))).toContain(
      "process events recorded for every probe (strace -f execve)",
    );
    const survived = probeSet();
    survived.escape = { ...survived.escape, trace: { ...survived.escape.trace, survived: true } };
    expect(failed(execChecks(probeSet(), survived))).toEqual([
      "no traced process outlived the app-server",
    ]);
  });
});

describe("codex:qualify baseline", () => {
  const qualified = ["0.154.0", "0.157.1", "0.159.2"];
  it("requires a release already qualified on this host, other than the candidate", () => {
    expect(selectBaseline("0.160.0", qualified, "0.158.0")).toHaveProperty("error");
    expect(selectBaseline("0.160.0", qualified, "0.160.0")).toHaveProperty("error");
    expect(selectBaseline("0.160.0", [], undefined)).toHaveProperty("error");
    expect(selectBaseline("0.160.0", qualified, "0.157.1")).toEqual({ baseline: "0.157.1" });
  });
  it("defaults to the newest qualified release older than the candidate", () => {
    expect(selectBaseline("0.160.0", qualified)).toEqual({ baseline: "0.159.2" });
    expect(selectBaseline("0.157.1", qualified)).toEqual({ baseline: "0.154.0" });
    expect(selectBaseline("0.150.0", qualified)).toHaveProperty("error");
  });
});

describe("codex:qualify live private work", () => {
  it("follows each launch's own work directory, not a host-wide count", () => {
    const work = "/tmp/humanish-codex-analysis-Ab12Cd";
    expect(privateWorkDir(`${work}/cwd`)).toBe(work);
    expect(privateWorkDir("/tmp/humanish-codex-analysis-Ab12Cd/scratch")).toBeUndefined();
    expect(privateWorkDir("/tmp/other/cwd")).toBeUndefined();
    expect(privateWorkDir(undefined)).toBeUndefined();
    // A directory another process leaves under the same prefix is not one of these launches'.
    expect(privateWorkCheck([work], []).pass).toBe(true);
    expect(privateWorkCheck([work], [work]).pass).toBe(false);
    expect(privateWorkCheck([], []).pass).toBe(false);
  });
});
