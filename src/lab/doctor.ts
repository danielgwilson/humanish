import { isLocalBrowserLab } from "../substrates/local/runtime-config.js";
import { localRuntimeStatus, type LocalRuntimeStatus } from "../substrates/local/runtime.js";
import type { LabConfig } from "./types.js";
import type { LabRoute } from "./plan.js";
import type { DetectedLocalAgent } from "../actors/local-agent/cli.js";
import type { DoctorResult } from "../cli/doctor.js";
import { automaticAnalysisBudget } from "../analysis/automatic-config.js";
import { externalCatchHealthy } from "../comms/sandbox-catch.js";
import { receivingRequiredKey } from "../comms/setup.js";
import { codexVersionRecovery } from "../actors/codex/qualified-versions.js";

type Check = DoctorResult["checks"][number];
/** Read-only Codex account readiness. An unadmitted CLI also reports the release it found. */
type CodexReadiness = { ready: boolean; errorCode: string | null; detectedCliVersion?: string };

/** The account check doctor and the TUI share; the version probe runs only for an unadmitted CLI. */
async function codexAccountReadiness(env: NodeJS.ProcessEnv): Promise<CodexReadiness> {
  const readiness = await (
    await import("../analysis/restricted-codex.js")
  ).checkRestrictedCodexAnalysisReadiness({ timeoutMs: 5000 }, { env });
  if (readiness.errorCode !== "codex_unsupported_version") return readiness;
  const { detectRestrictedCodexCliVersion } = await import("../actors/codex/restricted-session.js");
  const detected = await detectRestrictedCodexCliVersion({ timeoutMs: 5000 }, { env }).catch(
    () => undefined,
  );
  // An admitted release here means app-server reported a different one; name what --version says.
  const version = detected?.cliVersion ?? detected?.detectedVersion;
  return version === undefined ? readiness : { ...readiness, detectedCliVersion: version };
}

/** What to do about a Codex readiness failure; an unadmitted CLI gets its exact install command. */
function codexRecovery(readiness: CodexReadiness, fallback: string): string {
  return readiness.errorCode === "codex_unsupported_version"
    ? codexVersionRecovery(readiness.detectedCliVersion)
    : fallback;
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
      ? "Qualified Codex CLI and ChatGPT login are ready for restricted local browser participants. No E2B or model API key is required; inference is remote, and model access and account quota remain untested."
      : `Local Codex participant setup is unavailable (${readiness.errorCode}). ${codexRecovery(readiness, "Install the supported Codex CLI version and sign in with a ChatGPT account.")} No API fallback is used.`,
  };
}

interface LabSetupCheckArgs {
  cwd: string;
  lab: string;
  env: NodeJS.ProcessEnv;
  agents: DetectedLocalAgent[];
  keyPresent: (name: string) => boolean;
  /** Internal read-only qualification seam; never a participant/model request. */
  localRuntimeReadiness?: () => Promise<LocalRuntimeStatus>;
  codexAnalysisReadiness?: (env: NodeJS.ProcessEnv) => Promise<CodexReadiness>;
}

type AccountReadiness = () => Promise<CodexReadiness>;
type AnalysisBudget = NonNullable<ReturnType<typeof automaticAnalysisBudget>>;

/** Setup checks only: no model turn, browser or desktop creation. CLI startup may use the network. */
export async function labSetupChecks(
  args: LabSetupCheckArgs,
): Promise<{ desktop: boolean; keys: string[]; checks: Check[] }> {
  const { resolveLabManifest } = await import("./discover.js");
  const { resolveLabDryRun, routeOf } = await import("./plan.js");
  const resolved = await resolveLabManifest(args.cwd, args.lab);
  if (!resolved.ok)
    return {
      desktop: false,
      keys: [],
      checks: [{ name: "lab", ok: false, message: resolved.error.message }],
    };
  const config = resolved.config,
    route = routeOf(config);
  const dryRun = resolveLabDryRun(config, undefined, true) === true;
  const checks: Check[] = [
    {
      name: "lab route",
      ok: true,
      message: `${config.id}: ${config.actors[0]?.type ?? "synthetic"} / ${route} / ${dryRun ? "dry-run (no live participant)" : "live"}`,
    },
  ];
  if (dryRun) return { desktop: false, keys: [], checks };
  const unsupported = unsupportedCliRoute(config, route);
  if (unsupported)
    return {
      desktop: false,
      keys: [],
      checks: [...checks, { name: "live route", ok: false, message: unsupported }],
    };
  const { desktop, keys } = labKeyRequirements(config, route, false, args.keyPresent);
  const local = isLocalBrowserLab(config);
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
  checks.push(...subjectEnvChecks(config, args));
  const analysis = automaticAnalysisBudget(config.review?.analysis, route);
  if (analysis) checks.push(await analysisCheck(analysis, args, checkAccount));
  checks.push(checkScope(analysis));
  return { desktop, keys, checks };
}

/** A local browser study's runtime and, with an external catch, its captured inbox. */
async function localBrowserChecks(config: LabConfig, args: LabSetupCheckArgs): Promise<Check[]> {
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
  args: LabSetupCheckArgs,
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
  config: LabConfig,
  route: LabRoute,
  keys: string[],
  local: boolean,
  args: LabSetupCheckArgs,
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
  if (route !== "computer-use" || config.actors[0]?.type !== "local-agent") return [];
  const choice = config.actors[0]?.localAgent ?? "codex";
  const agent = args.agents.find((entry) => entry.id === choice);
  if (local) return [await localCodexParticipantCheck({ env: args.env, readiness: checkAccount })];
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

/** One row per declared subject env name: present or missing, never the value. */
function subjectEnvChecks(config: LabConfig, args: LabSetupCheckArgs): Check[] {
  return (config.subject.env ?? []).map((name) => ({
    name: `subject env ${name}`,
    ok: !!args.env[name]?.trim() || args.keyPresent(name),
    message:
      args.env[name]?.trim() || args.keyPresent(name)
        ? "present; value not shown"
        : "missing declared subject environment variable; provide it with --env-file",
  }));
}

/** The post-run analysis: the Codex account, or the OpenAI key and the admission estimate limit. */
async function analysisCheck(
  analysis: AnalysisBudget,
  args: LabSetupCheckArgs,
  checkAccount: AccountReadiness,
): Promise<Check> {
  if (analysis.provider === "codex") {
    const readiness = await checkAccount();
    const recovery =
      readiness.errorCode === "codex_unsupported_platform"
        ? "Use Linux x64 or the Apple Silicon Mac with a supported Codex CLI, or explicitly select provider: openai with an API key."
        : readiness.errorCode === "codex_busy"
          ? "Another restricted Codex analyst or setup check is active in this process. Wait for it to finish, then retry."
          : codexRecovery(
              readiness,
              "Install the qualified CLI and sign in with a ChatGPT account.",
            );
    return {
      name: "post-run analysis",
      ok: readiness.ready,
      message: readiness.ready
        ? "Qualified Codex CLI and ChatGPT account login are ready for a separate restricted analyst. Analysis sends selected evidence to remote inference; model access and account allowance remain untested. Dollar cost and output-token ceilings are unavailable."
        : `Codex account analysis is unavailable (${readiness.errorCode ?? "codex_unavailable"}). ${recovery} No API fallback is used; participant readiness is independent.`,
    };
  }
  return {
    name: "post-run analysis",
    ok: true,
    message: args.keyPresent("OPENAI_API_KEY")
      ? `OPENAI_API_KEY is present for the separate automatic analysis request; model access and quota are not tested. Its $${analysis.maxCostUsd} admission estimate limit may decline larger studies before dispatch; it is not a provider billing cap. Participant readiness is independent.`
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

/** Required participant provider keys, shared by doctor and the TUI. Optional analysis is separate. */
export function labKeyRequirements(
  config: LabConfig,
  route: LabRoute,
  dryRun: boolean,
  keyPresent: (name: string) => boolean,
): { desktop: boolean; keys: string[] } {
  if (dryRun || unsupportedCliRoute(config, route)) return { desktop: false, keys: [] };
  // This flag controls the hosted desktop SDK check as well as its API key.
  const desktop =
    !isLocalBrowserLab(config) &&
    (route === "computer-use" ||
      route === "terminal" ||
      route === "shared-world" ||
      (route === "scripted" && config.subject.source === "clone"));
  const keys = desktop ? ["E2B_API_KEY"] : [];
  if (route === "terminal")
    keys.push(keyPresent("CODEX_API_KEY") ? "CODEX_API_KEY" : "OPENAI_API_KEY");
  else if (
    (route === "computer-use" && config.actors[0]?.type !== "local-agent") ||
    route === "shared-world"
  )
    keys.push("OPENAI_API_KEY");
  return { desktop, keys };
}

function unsupportedCliRoute(config: LabConfig, route: LabRoute): string | undefined {
  if (config.subject.source === "local-app")
    return "local-app needs a caller-supplied executor and provider through the library API; the plain CLI cannot run it.";
  if (route === "preview")
    return "This route only creates synthetic evidence. Use first-run in dry-run mode or a supported live lab.";
  if (route === "shared-world" && config.actors[0]?.type !== "openai-computer-use")
    return "Shared-world currently requires openai-computer-use with OPENAI_API_KEY; local-agent is supported on independent desktop lanes.";
  return undefined;
}
