// Whether a study can run on a remote machine, the runner sandbox, and what the runner needs: how
// long it must live, which files it must receive and which keys it may hold. A pure function of the
// study and its plan, so a refusal happens before anything is created.
import path from "node:path";

import type { SandboxProviderId } from "../run/sandbox-receipts.js";
import type { StudyConfig } from "../study/types.js";
import type { ComputerUsePlan, StudyPlan } from "../study/plan-types.js";
import { analysisKeyNames } from "../keys/key-resolution.js";
import { keyNamesOf } from "../study/requirements.js";
import { participantList } from "../study/study-fields.js";

/** Time the runner needs before the study starts: create, Node and humanish install, uploads. */
const RUNNER_SETUP_MS = 10 * 60_000;
/** Time the runner needs after the study ends: syncing the run back and a margin. */
const RUNNER_TEARDOWN_MS = 15 * 60_000;

/** Settings the plan reads from the environment, which the remote run must read the same way. */
const PLAN_SETTINGS = [
  "HUMANISH_E2B_MAX_SANDBOX_MINUTES",
  "HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES",
  "HUMANISH_CUA_MAX_CONCURRENCY",
  "HUMANISH_E2B_REQUEST_TIMEOUT_MS",
  "E2B_DOMAIN",
] as const;

/** The connection names each provider's runner and participants are reached with. */
const PROVIDER_KEYS: Readonly<Record<SandboxProviderId, readonly string[]>> = {
  e2b: ["E2B_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_ENVIRONMENT"],
};

export interface RemotePlan {
  readonly provider: SandboxProviderId;
  /** The runner's lifetime: setup, the participants' last possible end, analysis and teardown. */
  readonly runnerMs: number;
  /** Paths relative to the project, uploaded to the same place in the runner's project. */
  readonly uploads: readonly string[];
  /** Directories, relative to the project, uploaded whole when they exist. */
  readonly uploadDirectories: readonly string[];
  /** The environment names the runner's run may receive, and nothing else. */
  readonly envNames: readonly string[];
  /** Names of which only the first one set is sent, as the run reads only that one. */
  readonly alternatives: readonly (readonly string[])[];
}

export type RemotePlanResult = { ok: true; plan: RemotePlan } | { ok: false; reason: string };

/**
 * The remote plan for `config`, whose live plan is `plan`, or why it cannot run remotely.
 * `studyPath` is the study file, `cwd` the project it runs in. `ceilingMs` is the longest the
 * provider keeps a sandbox.
 */
export function planRemoteRun(args: {
  config: StudyConfig;
  plan: StudyPlan;
  cwd: string;
  studyPath: string;
  ceilingMs: number;
  /** How many sandboxes the E2B account runs at once; the runner takes one of them. */
  concurrentSandboxes: number;
}): RemotePlanResult {
  const { config, plan, cwd } = args;
  const refuse = (reason: string): RemotePlanResult => ({ ok: false, reason });
  if (plan.route !== "computer-use")
    return refuse(
      `a ${plan.route} study runs on this machine; only computer-use studies run remotely.`,
    );
  const runner = plan.runner;
  if (runner.desktop !== "e2b-desktop")
    return refuse("its participants use this machine's browser, so the study runs here.");
  if (runner.brain.kind !== "provider-key")
    return refuse(
      "its participants are driven by an agent on this machine, which a remote run cannot reach.",
    );
  if (runner.subject.kind !== "app-url")
    return refuse(
      "its subject is built or served from this machine; only app-url subjects run remotely for now.",
    );
  if (servedHere(runner.subject.appUrl))
    return refuse(
      "its app URL points at this machine or a private network, which the runner cannot reach.",
    );
  if (plan.analysis?.config.provider === "codex")
    return refuse("its analysis uses this machine's Codex login.");
  if (config.review?.scorer !== undefined)
    return refuse("it loads a scorer module, which does not run remotely yet.");
  if (plan.rerun !== undefined) return refuse("a rerun reads a run on this machine.");
  if (config.comms !== undefined)
    return refuse("its email setup reads files and connections on this machine.");

  const study = inside(cwd, args.studyPath);
  if (study === undefined) return refuse("the study file is outside the project directory.");
  const files: string[] = [study];
  for (const participant of participantList(config) ?? [])
    for (const file of participant.files ?? []) {
      const from = inside(cwd, path.resolve(path.dirname(args.studyPath), file.from));
      if (from === undefined)
        return refuse(`participant file ${file.from} is outside the project directory.`);
      files.push(from);
    }

  if (runner.provider === "e2b" && plan.concurrency + 1 > args.concurrentSandboxes)
    return refuse(
      `its ${plan.concurrency} participants at once and the runner need ${plan.concurrency + 1} E2B sandboxes at once, more than the ${args.concurrentSandboxes} your account runs. Lower execution.concurrency to ${args.concurrentSandboxes - 1}.`,
    );
  const runnerMs = runnerLifetimeMs(plan);
  if (runnerMs > args.ceilingMs)
    return refuse(
      `the study needs its runner for up to ${minutes(runnerMs)} minutes, longer than the ${minutes(args.ceilingMs)} minutes ${runner.provider === "modal" ? "Modal" : "E2B"} keeps a sandbox.`,
    );
  return {
    ok: true,
    plan: {
      provider: runner.provider,
      runnerMs,
      uploads: [...new Set(files)],
      uploadDirectories: ["humanish/personas", ".humanish/local/personas"],
      envNames: [
        ...new Set([...keyNamesOf(plan), ...PROVIDER_KEYS[runner.provider], ...PLAN_SETTINGS]),
      ].sort(),
      alternatives: analystKeyNames(plan),
    },
  };
}

/** Setup, the participants' last possible end, the analysis's own limit and teardown. */
function runnerLifetimeMs(plan: ComputerUsePlan): number {
  const analysisMs = plan.analysis?.config.timeoutMs ?? 0;
  return RUNNER_SETUP_MS + plan.arrivals.lastEndMs + analysisMs + RUNNER_TEARDOWN_MS;
}

/** `target` relative to `cwd`, or undefined when it is outside it. */
function inside(cwd: string, target: string): string | undefined {
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

const minutes = (ms: number): number => Math.ceil(ms / 60_000);

/** Whether `appUrl` names loopback, a private address, or a name only this machine resolves. */
function servedHere(appUrl: string): boolean {
  let host: string;
  try {
    host = new URL(appUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))
    return host.includes(":");
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** The analyst's key names, when it reads the first one set of several. */
function analystKeyNames(plan: ComputerUsePlan): (readonly string[])[] {
  const analyst = plan.analysis?.config.provider;
  if (analyst === undefined || analyst === "codex") return [];
  const names = analysisKeyNames(analyst);
  return names.length > 1 ? [names] : [];
}
