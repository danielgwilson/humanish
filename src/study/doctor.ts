import path from "node:path";
import { isLocalBrowserStudy } from "../substrates/local/runtime-config.js";
import { localRuntimeStatus, type LocalRuntimeStatus } from "../substrates/local/runtime.js";
import type { StudyConfig } from "./types.js";
import type { StudyRoute } from "./plan.js";
import type { PlanResult } from "./plan-types.js";
import { keyNamesOf, requiredKeys, requiredSubjectEnv } from "./requirements.js";
import type { DetectedLocalAgent } from "../actors/local-agent/cli.js";
import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import {
  protocolAdditionsWarning,
  protocolIncompatibilityMessage,
} from "../actors/codex/protocol-compat.js";
import type { DoctorCheckDraft } from "../cli/doctor.js";
import { automaticAnalysisBudget } from "../analysis/automatic-config.js";
import { externalCatchHealthy } from "../comms/sandbox-catch.js";
import { receivingRequiredKey } from "../comms/setup.js";
import {
  classifyCodexInstallation,
  codexInstallAdvice,
  codexVersionRecovery,
  type CodexInstallation,
} from "../actors/codex/codex-admission.js";
import type { RefusedCodexExecutable } from "../actors/codex/restricted-executable.js";

type Check = DoctorCheckDraft;
/**
 * Read-only Codex account readiness. An unadmitted CLI also reports the release it found, and an
 * unavailable one the file humanish found and turned down.
 */
type CodexReadiness = {
  ready: boolean;
  errorCode: string | null;
  detectedCliVersion?: string;
  refusedExecutable?: RefusedCodexExecutable;
  /** Where the `codex` on `PATH` was installed, for the command that replaces it. */
  installation?: CodexInstallation;
  /** How the release's app-server schema differs from the fields humanish reads. */
  protocolIncompatibilities?: readonly string[];
  /** Schema values beyond the baseline, recorded by a launch that passed. */
  protocolAdditions?: readonly string[];
};

/** A ready row's message, with the schema values the launch recorded. */
function readyMessage(
  message: string,
  readiness: CodexReadiness & { cliVersion?: string },
): string {
  const additions = protocolAdditionsWarning(readiness.cliVersion, readiness.protocolAdditions);
  return additions === undefined ? message : `${message} ${additions}`;
}

/** npm's global prefix (`npm prefix -g`), or undefined when npm does not answer. */
async function npmGlobalPrefix(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("npm", ["prefix", "-g"], { env, timeout: 5000 }, (error, stdout) => {
      const prefix = String(stdout).trim();
      resolve(error === null && path.isAbsolute(prefix) ? prefix : undefined);
    });
  });
}

/** Where the `codex` on `PATH` was installed; npm's prefix is read only when not project-local. */
async function codexInstallation(env: NodeJS.ProcessEnv): Promise<CodexInstallation | undefined> {
  const { foundCodexExecutable } = await import("../actors/codex/restricted-executable.js");
  const found = await foundCodexExecutable(env).catch(() => undefined);
  if (found === undefined) return undefined;
  const local = classifyCodexInstallation(found, undefined);
  return local.kind === "project"
    ? local
    : classifyCodexInstallation(found, await npmGlobalPrefix(env));
}

/** The account check doctor and the TUI share: the isolated launch, with recovery details. */
async function codexAccountReadiness(env: NodeJS.ProcessEnv): Promise<CodexReadiness> {
  const checked = await (
    await import("../analysis/restricted-codex.js")
  ).checkRestrictedCodexAnalysisReadiness({ timeoutMs: 5000 }, { env });
  return withCodexRecoveryDetails(env, checked);
}

/** What doctor's hosted Codex participant check found: a readiness result and what it admitted. */
type HostedCodexReadiness = CodexReadiness & {
  cliVersion?: string;
  resolvedModel?: string;
  authentication?: "chatgpt-account" | "api-key";
};

/**
 * The hosted participant check: the operator-auth launch to an ephemeral thread, with no turn,
 * using the study's declared model and reasoning effort as a run would.
 */
async function hostedCodexReadiness(
  env: NodeJS.ProcessEnv,
  actor: { model?: string; reasoningEffort?: ReasoningEffort },
): Promise<HostedCodexReadiness> {
  const { checkRestrictedCodexParticipantReadiness } =
    await import("../actors/codex/restricted-participant.js");
  const checked = await checkRestrictedCodexParticipantReadiness({
    session: { env },
    ...(actor.model === undefined ? {} : { model: actor.model }),
    ...(actor.reasoningEffort === undefined ? {} : { reasoningEffort: actor.reasoningEffort }),
  });
  return checked.ready
    ? checked
    : { ...checked, ...(await withCodexRecoveryDetails(env, checked)) };
}

/**
 * Adds what the recovery line names to a failed check. An unadmitted CLI gets its release, an
 * unavailable one the file humanish turned down, and both where the binary came from.
 */
async function withCodexRecoveryDetails(
  env: NodeJS.ProcessEnv,
  checked: CodexReadiness,
): Promise<CodexReadiness> {
  if (
    checked.errorCode !== "codex_unavailable" &&
    checked.errorCode !== "codex_unsupported_version" &&
    checked.errorCode !== "codex_incompatible_release"
  )
    return checked;
  const installation = await codexInstallation(env);
  const readiness: CodexReadiness =
    installation === undefined ? checked : { ...checked, installation };
  if (readiness.errorCode === "codex_unavailable") {
    const { refusedCodexExecutable } = await import("../actors/codex/restricted-executable.js");
    const refused = await refusedCodexExecutable(env).catch(() => undefined);
    return refused === undefined ? readiness : { ...readiness, refusedExecutable: refused };
  }
  const { detectRestrictedCodexCliVersion } = await import("../actors/codex/restricted-session.js");
  const detected = await detectRestrictedCodexCliVersion({ timeoutMs: 5000 }, { env }).catch(
    () => undefined,
  );
  // An admitted release here means app-server reported a different one; name what --version says.
  const version = detected?.cliVersion ?? detected?.detectedVersion;
  return version === undefined ? readiness : { ...readiness, detectedCliVersion: version };
}

/**
 * What to do about a Codex readiness failure, one line per code: an unadmitted CLI gets its exact
 * install command, a missing login `codex login`, and an unavailable CLI the file humanish turned
 * down and why. Other codes get `fallback`.
 */
function codexRecovery(readiness: CodexReadiness, fallback: string): string {
  switch (readiness.errorCode) {
    case "codex_unsupported_version":
      return codexVersionRecovery(readiness.detectedCliVersion, readiness.installation);
    case "codex_incompatible_release":
      return `${protocolIncompatibilityMessage(readiness.detectedCliVersion, readiness.protocolIncompatibilities ?? [])} ${codexInstallAdvice(readiness.installation)} Then sign in with a ChatGPT account (\`codex login\`).`;
    case "codex_login_required":
      return "Codex is installed but not signed in. Run `codex login` and sign in with a ChatGPT account.";
    case "codex_unsupported_auth":
      return "Codex is signed in without a ChatGPT account, for example with an API key. Run `codex logout`, then `codex login` with a ChatGPT account.";
    case "codex_unavailable": {
      const refused = readiness.refusedExecutable;
      const found =
        refused === undefined
          ? "humanish could not start the Codex CLI."
          : refused.path === undefined
            ? `Codex is unavailable: ${refused.reason}.`
            : `humanish found \`${refused.path}\` and cannot run it: ${refused.reason}.`;
      return `${found} ${codexInstallAdvice(readiness.installation)} Then sign in with a ChatGPT account (\`codex login\`).`;
    }
    default:
      return fallback;
  }
}

/** Shared read-only Codex account check for local participants in doctor and the TUI. */
export async function localCodexParticipantCheck(args: {
  env: NodeJS.ProcessEnv;
  readiness?: (env: NodeJS.ProcessEnv) => Promise<CodexReadiness>;
}): Promise<Check> {
  const readiness: CodexReadiness = await (args.readiness ?? codexAccountReadiness)(args.env).catch(
    () => ({ ready: false, errorCode: "codex_unavailable" }),
  );
  return {
    name: "local participant authentication",
    ok: readiness.ready,
    message: readiness.ready
      ? readyMessage(
          "Codex CLI and ChatGPT login are ready for restricted local browser participants. No E2B or model API key is required; inference is remote, and model access and account quota remain untested.",
          readiness,
        )
      : `Local Codex participant setup is unavailable (${readiness.errorCode}). ${codexRecovery(readiness, "Install the supported Codex CLI version and sign in with a ChatGPT account.")} No API fallback is used.`,
  };
}

/**
 * The discovery and planning functions doctor's study checks use, loaded on first use as
 * studySetupChecks always loaded them, so they stay out of this module's static imports.
 */
async function studyLoaders() {
  const discover = await import("./discover.js");
  const plan = await import("./plan.js");
  return {
    listStudies: discover.listStudyManifests,
    resolveStudy: discover.resolveStudyManifest,
    resolveDryRun: plan.resolveStudyDryRun,
    routeOf: plan.routeOf,
  };
}

export interface StudySetupCheckArgs {
  cwd: string;
  study: string;
  env: NodeJS.ProcessEnv;
  agents: DetectedLocalAgent[];
  keyPresent: (name: string) => boolean;
  /** Internal read-only qualification seam; never a participant/model request. */
  localRuntimeReadiness?: () => Promise<LocalRuntimeStatus>;
  codexAnalysisReadiness?: (env: NodeJS.ProcessEnv) => Promise<CodexReadiness>;
  /** The hosted Codex participant's operator handshake; tests replace it. */
  codexParticipantReadiness?: typeof hostedCodexReadiness;
}

type AccountReadiness = () => Promise<CodexReadiness>;
type AnalysisBudget = NonNullable<ReturnType<typeof automaticAnalysisBudget>>;

/**
 * Setup checks only: no model turn, browser or desktop creation. CLI startup may use the network.
 * `keys` are the keys a live run requires. `reads` are the provider keys the study is known to read,
 * required or not; it is undefined when that is unknown: the study does not plan, or a declared
 * scorer's host code may read any key.
 */
export async function studySetupChecks(args: StudySetupCheckArgs): Promise<{
  desktop: boolean;
  keys: string[];
  reads?: ReadonlySet<string>;
  checks: Check[];
}> {
  const { resolveStudy, resolveDryRun, routeOf } = await studyLoaders();
  const resolved = await resolveStudy(args.cwd, args.study);
  if (!resolved.ok)
    return {
      desktop: false,
      keys: [],
      checks: [{ name: "study", ok: false, message: resolved.error.message }],
    };
  const config = resolved.config,
    route = routeOf(config);
  const dryRun = resolveDryRun(config, undefined, true) === true;
  const checks: Check[] = [
    {
      name: "study route",
      ok: true,
      message: `${config.id}: ${config.actors[0]?.type ?? "synthetic"} / ${route} / ${dryRun ? "dry-run (no live participant)" : "live"}`,
    },
  ];
  if (dryRun) return { desktop: false, keys: [], reads: new Set(), checks };
  const unsupported = unsupportedCliRoute(config, route);
  if (unsupported)
    return {
      desktop: false,
      keys: [],
      checks: [...checks, { name: "live route", ok: false, message: unsupported }],
    };
  const planned = await planCliRun(config, args.cwd);
  if (!planned.ok)
    return {
      desktop: false,
      keys: [],
      checks: [...checks, { name: "live route", ok: false, message: planned.refusal.message }],
    };
  const requirements = planned.planned.plan.requirements;
  const keys = requiredKeys(requirements, args.keyPresent);
  // This flag controls the hosted desktop SDK check as well as its API key.
  const desktop = keys.includes("E2B_API_KEY");
  const local = isLocalBrowserStudy(config);
  // One account check, shared by the local participant row and the Codex analysis row.
  let accountReadiness: Promise<CodexReadiness> | undefined;
  const checkAccount: AccountReadiness = () =>
    (accountReadiness ??= (args.codexAnalysisReadiness ?? codexAccountReadiness)(args.env).catch(
      () => ({ ready: false, errorCode: "codex_unavailable" }),
    ));
  if (local) checks.push(...(await localBrowserChecks(config, args)));
  if (config.comms?.email?.kind === "real")
    checks.push(await realEmailCheck(config.comms.email.connection, keys, args));
  checks.push(...(await participantChecks(config, route, keys, local, args, checkAccount)));
  if (route === "scripted") checks.push(await scriptedBrowserCheck());
  checks.push(...subjectEnvChecks(requiredSubjectEnv(requirements), args));
  const analysis = automaticAnalysisBudget(config.review?.analysis, route);
  if (analysis) checks.push(await analysisCheck(analysis, args, checkAccount));
  checks.push(checkScope(analysis));
  const reads =
    config.review?.scorer === undefined
      ? new Set([...keyNamesOf(planned.planned.plan), ...keys])
      : undefined;
  return { desktop, keys, ...(reads === undefined ? {} : { reads }), checks };
}

/** A local browser study's runtime and, with an external catch, its captured inbox. */
async function localBrowserChecks(
  config: StudyConfig,
  args: StudySetupCheckArgs,
): Promise<Check[]> {
  const checks: Check[] = [];
  const runtime = await (
    args.localRuntimeReadiness ??
    (() =>
      localRuntimeStatus({
        env: args.env,
        media:
          config.execution?.desktop?.media !== undefined ||
          config.execution?.desktop?.recording !== undefined,
      }))
  )();
  checks.push({ name: "local browser runtime", ok: runtime.ok, message: runtime.message });
  const email = config.comms?.email;
  if (email?.kind === "fake" && email.external) {
    const healthy = await externalCatchHealthy(email.external, { timeoutMs: 5000 });
    checks.push({
      name: "local captured inbox",
      ok: healthy,
      message: healthy
        ? "Recipient inbox routes are ready. Point your app's email sends at this catch; delivery remains untested. No mailbox-provider credentials are needed, and this does not receive arbitrary internet mail."
        : "Captured inbox is unavailable or outdated. Start or upgrade and restart humanish comms catch, then check comms.email.external.catchBaseUrl (and inboxBaseUrl if set). No participant was allocated.",
    });
  }
  return checks;
}

/** The saved real email connection. Adds the key it needs to `keys`. */
async function realEmailCheck(
  connection: string,
  keys: string[],
  args: StudySetupCheckArgs,
): Promise<Check> {
  const name = await receivingRequiredKey(args.cwd, connection);
  if (name) keys.push(name);
  return {
    name: "real email connection",
    ok: name !== null && args.keyPresent(name),
    message:
      name === null
        ? "The selected email connection is missing or invalid. Open Connections in the TUI."
        : !args.keyPresent(name)
          ? `Missing ${name} for the selected email connection. Provide it through process env or --env-file. Authentication has not been checked.`
          : "Fresh hosted inbox per participant. Local presence only; run humanish comms check --online to authenticate. Provider permissions/capacity and delivery remain untested.",
  };
}

/** How the participant authenticates: the terminal model key, or a local agent's login. */
async function participantChecks(
  config: StudyConfig,
  route: StudyRoute,
  keys: string[],
  local: boolean,
  args: StudySetupCheckArgs,
  checkAccount: AccountReadiness,
): Promise<Check[]> {
  if (route === "terminal") {
    const key = keys.find((name) => name !== "E2B_API_KEY")!;
    return [
      {
        name: "terminal model authentication",
        ok: args.keyPresent(key),
        message:
          "The in-sandbox Codex runtime needs CODEX_API_KEY or OPENAI_API_KEY. Your host's Codex login is not forwarded; credential placement follows execution.runtimeAuth.",
      },
    ];
  }
  if (
    (route !== "computer-use" && route !== "shared-world") ||
    config.actors[0]?.type !== "local-agent"
  )
    return [];
  const choice = config.actors[0]?.localAgent ?? "codex";
  const agent = args.agents.find((entry) => entry.id === choice);
  if (local) return [await localCodexParticipantCheck({ env: args.env, readiness: checkAccount })];
  // A signed-in hosted Codex gets the operator handshake; its sign-in status alone does not show
  // that the operator's config, release and model admit a launch.
  if (choice === "codex" && agent?.authStatus === "authenticated")
    return [await hostedCodexParticipantCheck(args, config.actors[0])];
  return [
    {
      name: "local participant authentication",
      ok: agent?.authStatus === "authenticated",
      message:
        agent?.authStatus === "authenticated"
          ? `${agent.label} reports authenticated on the host. E2B supplies the desktop; no OpenAI API key is required for this participant.`
          : agent
            ? `${agent.label} ${agent.authStatus === "unauthenticated" ? "reports not signed in" : "authentication could not be checked"}. Run \`${choice === "codex" ? "codex login status" : "claude auth status"}\`; sign in or update the CLI before running.`
            : `${choice} is not on this process's PATH. Install and sign in to that CLI, or choose openai-computer-use with OPENAI_API_KEY.`,
    },
  ];
}

/** The hosted Codex participant row: what the operator handshake admitted, or how to fix it. */
async function hostedCodexParticipantCheck(
  args: StudySetupCheckArgs,
  actor: { model?: string; reasoningEffort?: ReasoningEffort } | undefined,
): Promise<Check> {
  const declared = {
    ...(actor?.model === undefined ? {} : { model: actor.model }),
    ...(actor?.reasoningEffort === undefined ? {} : { reasoningEffort: actor.reasoningEffort }),
  };
  const readiness: HostedCodexReadiness = await (
    args.codexParticipantReadiness ?? hostedCodexReadiness
  )(args.env, declared).catch(() => ({ ready: false, errorCode: "codex_unavailable" }));
  const account =
    readiness.authentication === "api-key"
      ? "an API key, which bills its usage to that key"
      : "a ChatGPT account";
  return {
    name: "local participant authentication",
    ok: readiness.ready,
    message: readiness.ready
      ? readyMessage(
          `Codex CLI ${readiness.cliVersion ?? "(unknown release)"} passed the operator handshake without a turn (initialize, config/read, account/read and an ephemeral thread/start): model ${readiness.resolvedModel ?? "(not reported)"} on ${account}. E2B supplies the desktop; no OpenAI API key is required for this participant.`,
          readiness,
        )
      : `Hosted Codex participant setup is unavailable (${readiness.errorCode}). ${codexRecovery(readiness, "Check `codex login status` and the operator's Codex configuration, then rerun doctor.")} No API fallback is used.`,
  };
}

/** The local Chrome/Chromium the scripted-browser route drives. */
async function scriptedBrowserCheck(): Promise<Check> {
  const { resolveBrowserCommand } = await import("../actors/scripted-browser/browser-command.js");
  return {
    name: "scripted browser",
    ok: !!(await resolveBrowserCommand()),
    message:
      "Scripted-browser uses local Chrome/Chromium and no participant model. Install Chrome/Chromium or set HUMANISH_BROWSER_COMMAND; a clone subject additionally needs E2B.",
  };
}

/** One row per subject env name the plan requires: present or missing, never the value. */
function subjectEnvChecks(names: readonly string[], args: StudySetupCheckArgs): Check[] {
  return names.map((name) => ({
    name: `subject env ${name}`,
    ok: !!args.env[name]?.trim() || args.keyPresent(name),
    message:
      args.env[name]?.trim() || args.keyPresent(name)
        ? "present; value not shown"
        : "missing declared subject environment variable; provide it with --env-file",
  }));
}

/** The post-run analysis: the Codex account, or the OpenAI key and the analysis cost limit. */
async function analysisCheck(
  analysis: AnalysisBudget,
  args: StudySetupCheckArgs,
  checkAccount: AccountReadiness,
): Promise<Check> {
  if (analysis.provider === "codex") {
    const readiness = await checkAccount();
    const recovery =
      readiness.errorCode === "codex_unsupported_platform"
        ? "Use Linux x64 or the Apple Silicon Mac with a supported Codex CLI, or explicitly select provider: openai with an API key."
        : readiness.errorCode === "codex_busy"
          ? "Another restricted Codex analyst or setup check is active in this process. Wait for it to finish, then retry."
          : codexRecovery(readiness, "Install the Codex CLI and sign in with a ChatGPT account.");
    return {
      name: "post-run analysis",
      ok: readiness.ready,
      message: readiness.ready
        ? readyMessage(
            "Codex CLI and ChatGPT account login are ready for a separate restricted analyst. Analysis sends selected evidence to remote inference; model access and account allowance remain untested. Dollar cost and output-token ceilings are unavailable.",
            readiness,
          )
        : `Codex account analysis is unavailable (${readiness.errorCode ?? "codex_unavailable"}). ${recovery} No API fallback is used; participant readiness is independent.`,
    };
  }
  const keyed = args.keyPresent("OPENAI_API_KEY");
  return {
    name: "post-run analysis",
    ok: true,
    ...(keyed ? {} : { status: "note" as const }),
    message: keyed
      ? `OPENAI_API_KEY is present for the separate automatic analysis request; model access and quota are not tested. The analysis is refused before it starts if its estimate is over $${analysis.maxCostUsd}; this is not a billing cap. Participant readiness is independent.`
      : "Will be skipped: OPENAI_API_KEY is missing. The participant may run, but there will be no automatic findings report. Add an OpenAI API key or set review.analysis: false deliberately.",
  };
}

/** What doctor checked and what it did not. */
function checkScope(analysis: ReturnType<typeof automaticAnalysisBudget>): Check {
  return {
    name: "check scope",
    ok: true,
    message:
      analysis?.provider === "codex"
        ? "The Codex setup check inspects local login and configuration without a model turn or participant resources. Remote account validity, model access, quota and target reachability remain untested; CLI startup may use the network."
        : "Local setup only. Provider credentials are not validated, model access/quota and target reachability are untested, and no paid resources were created.",
  };
}

/**
 * The ids of the project's labs that need each provider key for a live run, from the same plan
 * `doctor --study` reads. Each listed manifest resolves by its path, since a file name need not match
 * the id inside. A study that runs dry, that the plain CLI cannot run, or that does not plan needs
 * none.
 */
export async function studiesByRequiredKey(
  cwd: string,
  keyPresent: (name: string) => boolean,
): Promise<Map<string, string[]>> {
  const { listStudies, resolveStudy, resolveDryRun, routeOf } = await studyLoaders();
  const users = new Map<string, Set<string>>();
  for (const entry of (await listStudies(cwd)).studies) {
    const resolved = await resolveStudy(cwd, entry.path);
    if (!resolved.ok || resolveDryRun(resolved.config, undefined, true) === true) continue;
    if (unsupportedCliRoute(resolved.config, routeOf(resolved.config))) continue;
    const planned = await planCliRun(resolved.config, cwd);
    if (!planned.ok) continue;
    for (const key of requiredKeys(planned.planned.plan.requirements, keyPresent))
      users.set(key, (users.get(key) ?? new Set()).add(entry.id));
  }
  return new Map([...users].map(([key, ids]) => [key, [...ids]]));
}

/**
 * The study planned with no run options, so its own scenario mode decides dry or live. Doctor and the
 * TUI read a live run's keys and subject env from this plan's requirements.
 */
export async function planCliRun(config: StudyConfig, cwd: string): Promise<PlanResult> {
  return (await import("./plan.js")).planStudy(config, { cwd });
}

function unsupportedCliRoute(config: StudyConfig, route: StudyRoute): string | undefined {
  if (config.subject.source === "local-app")
    return "local-app needs a caller-supplied executor and provider through the library API; the plain CLI cannot run it.";
  if (route === "preview")
    return "This route only creates synthetic evidence. Use first-run in dry-run mode or a supported live study.";
  return undefined;
}
