// Whether a study can run on a remote machine, the runner sandbox, and what the runner needs: how
// long it must live, which files it must receive and which keys it may hold. A pure function of the
// study and its plan, so a refusal happens before anything is created.
import path from "node:path";

import type { SandboxProviderId } from "../run/sandbox-receipts.js";
import type { StudyConfig } from "../study/types.js";
import type { ComputerUsePlan, StudyPlan, TerminalPlan } from "../study/plan-types.js";
import { analysisKeyNames } from "../keys/key-resolution.js";
import { terminalSandboxTimeoutMs } from "../routes/terminal/lifetime.js";
import { TERMINAL_RUNTIME_KEY_NAMES } from "../routes/terminal/credentials.js";
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
  /**
   * Names of which the first one set reaches the runner's run as its value on every provider,
   * never held in an egress proxy.
   */
  readonly plainKeys: readonly string[];
  /** The study's route, which names its run. */
  readonly route: "computer-use" | "terminal";
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
  const route =
    plan.route === "computer-use"
      ? computerUseRoute(config, plan)
      : plan.route === "terminal" && !plan.dryRun
        ? terminalRoute(plan, cwd)
        : `a ${plan.route} study runs on this machine; only computer-use and terminal studies run remotely.`;
  if (typeof route === "string") return refuse(route);
  if (plan.analysis?.config.provider === "codex")
    return refuse("its analysis uses this machine's Codex login.");
  if (config.review?.scorer !== undefined)
    return refuse("it loads a scorer module, which does not run remotely yet.");

  const study = inside(cwd, args.studyPath);
  if (study === undefined) return refuse("the study file is outside the project directory.");
  const files: string[] = [study, ...route.uploads];
  for (const participant of participantList(config) ?? [])
    for (const file of participant.files ?? []) {
      const from = inside(cwd, path.resolve(path.dirname(args.studyPath), file.from));
      if (from === undefined)
        return refuse(`participant file ${file.from} is outside the project directory.`);
      files.push(from);
    }

  if (route.provider === "e2b" && route.sandboxes + 1 > args.concurrentSandboxes)
    return refuse(
      `its ${route.sandboxes} participants at once and the runner need ${route.sandboxes + 1} E2B sandboxes at once, more than the ${args.concurrentSandboxes} your account runs. Lower execution.concurrency to ${args.concurrentSandboxes - 1}.`,
    );
  const runnerMs =
    RUNNER_SETUP_MS + route.studyMs + (plan.analysis?.config.timeoutMs ?? 0) + RUNNER_TEARDOWN_MS;
  if (runnerMs > args.ceilingMs)
    return refuse(
      `the study needs its runner for up to ${minutes(runnerMs)} minutes, longer than the ${minutes(args.ceilingMs)} minutes ${route.provider === "modal" ? "Modal" : "E2B"} keeps a sandbox.`,
    );
  return {
    ok: true,
    plan: {
      provider: route.provider,
      route: route.route,
      runnerMs,
      uploads: [...new Set(files)],
      uploadDirectories: ["humanish/personas", ".humanish/local/personas"],
      envNames: [
        ...new Set([...keyNamesOf(plan), ...PROVIDER_KEYS[route.provider], ...PLAN_SETTINGS]),
      ].sort(),
      alternatives: [...analystKeyNames(plan), ...route.alternatives],
      plainKeys: route.plainKeys,
    },
  };
}

/** What a route adds to the remote plan, or why its study cannot run remotely. */
interface RemoteRoute {
  route: RemotePlan["route"];
  provider: SandboxProviderId;
  /** How many sandboxes the study runs at once, beside the runner. */
  sandboxes: number;
  /** How long the study itself can run: its participants' last end. */
  studyMs: number;
  /** Project-relative files the study reads, beyond the study file and participant files. */
  uploads: string[];
  /** Key names of which the run reads only the first one set. */
  alternatives: (readonly string[])[];
  plainKeys: string[];
}

function computerUseRoute(config: StudyConfig, plan: ComputerUsePlan): RemoteRoute | string {
  const runner = plan.runner;
  if (runner.desktop !== "e2b-desktop")
    return "its participants use this machine's browser, so the study runs here.";
  if (runner.brain.kind !== "provider-key")
    return "its participants are driven by an agent on this machine, which a remote run cannot reach.";
  if (runner.subject.kind !== "app-url")
    return "its subject is built or served from this machine; only app-url subjects run remotely for now.";
  if (servedHere(runner.subject.appUrl))
    return "its app URL points at this machine or a private network, which the runner cannot reach.";
  if (plan.rerun !== undefined) return "a rerun reads a run on this machine.";
  if (config.comms !== undefined)
    return "its email setup reads files and connections on this machine.";
  return {
    route: "computer-use",
    provider: runner.provider,
    sandboxes: plan.concurrency,
    studyMs: plan.arrivals.lastEndMs,
    uploads: [],
    alternatives: [],
    plainKeys: [],
  };
}

/**
 * A terminal study's one shell sandbox. The run in the runner puts the runtime key into that
 * sandbox's own egress rule, or into the codex command, so the runner needs the key's value: a
 * placeholder there would reach OpenAI and be refused. Only the key Codex reads goes as its value.
 */
function terminalRoute(
  plan: Extract<TerminalPlan, { dryRun: false }>,
  cwd: string,
): RemoteRoute | string {
  const uploads: string[] = [];
  const upload = plan.product.upload;
  if (upload !== undefined) {
    // The route resolves the upload against the project, not the study file.
    const from = inside(cwd, upload);
    if (from === undefined)
      return `subject.product.upload ${upload} is outside the project directory.`;
    uploads.push(from);
  }
  return {
    route: "terminal",
    provider: plan.sandboxProvider,
    sandboxes: 1,
    studyMs: terminalSandboxTimeoutMs({
      maxMinutes: plan.caps.maxMinutes,
      productInstall: plan.product.install !== undefined,
    }),
    uploads,
    // Codex reads the first runtime key set. A second one goes to the runner only when the
    // analysis reads it, and is then held as usual.
    alternatives: analysisReads(plan, "OPENAI_API_KEY") ? [] : [TERMINAL_RUNTIME_KEY_NAMES],
    plainKeys: [...TERMINAL_RUNTIME_KEY_NAMES],
  };
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

/** Whether the plan's analysis reads `name`. */
function analysisReads(plan: StudyPlan, name: string): boolean {
  const analyst = plan.analysis?.config.provider;
  return (
    plan.analysis !== undefined &&
    analyst !== "codex" &&
    analysisKeyNames(analyst ?? "openai").includes(name)
  );
}

/** The analyst's key names, when it reads the first one set of several. */
function analystKeyNames(plan: StudyPlan): (readonly string[])[] {
  const analyst = plan.analysis?.config.provider;
  if (analyst === undefined || analyst === "codex") return [];
  const names = analysisKeyNames(analyst);
  return names.length > 1 ? [names] : [];
}
