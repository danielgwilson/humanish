import type { LabConfig } from "./lab-config.js";
import type { LabBackend } from "./lab-engine.js";
import type { DetectedLocalAgent } from "./local-agent-cli.js";
import type { DoctorResult } from "./run.js";
import { automaticAnalysisBudget } from "./automatic-analysis-config.js";
import { receivingRequiredKey } from "./comms-setup.js";

type Check = DoctorResult["checks"][number];

/** Setup checks only: no network, provider dispatch, browser or desktop creation. */
export async function labSetupChecks(args: {
  cwd: string; lab: string; env: NodeJS.ProcessEnv; agents: DetectedLocalAgent[];
  keyPresent: (name: string) => boolean;
  /** Internal read-only qualification seam; never a participant/model request. */
  codexAnalysisReadiness?: () => Promise<{ ready: boolean; errorCode: string | null }>;
}): Promise<{ desktop: boolean; keys: string[]; checks: Check[] }> {
  const { resolveLabManifest } = await import("./labs.js");
  const { selectLabBackend, resolveLabDryRun } = await import("./lab-engine.js");
  const resolved = await resolveLabManifest(args.cwd, args.lab);
  if (!resolved.ok) return { desktop: false, keys: [], checks: [{ name: "lab", ok: false, message: resolved.error.message }] };
  const config = resolved.config, backend = selectLabBackend(config);
  const dryRun = resolveLabDryRun(config, undefined, true) === true;
  const checks: Check[] = [{ name: "lab route", ok: true,
    message: `${config.id}: ${config.actors[0]?.type ?? "synthetic"} / ${backend} / ${dryRun ? "dry-run (no live participant)" : "live"}` }];
  if (dryRun) return { desktop: false, keys: [], checks };
  const unsupported = unsupportedCliRoute(config, backend);
  if (unsupported) return { desktop: false, keys: [], checks: [...checks, { name: "live route", ok: false, message: unsupported }] };
  const { desktop, keys } = labKeyRequirements(config, backend, false, args.keyPresent);
  if (config.comms?.email?.kind === "real") {
    const name = await receivingRequiredKey(args.cwd, config.comms.email.connection);
    if (name) keys.push(name);
    checks.push({ name: "real email connection", ok: name !== null && args.keyPresent(name), message: name === null
      ? "The selected email connection is missing or invalid. Open Connections in the TUI."
      : !args.keyPresent(name)
      ? `Missing ${name} for the selected email connection. Provide it through process env or --env-file. Authentication has not been checked.`
      : "Fresh hosted inbox per participant. Local presence only; run humanish comms check --online to authenticate. Provider permissions/capacity and delivery remain untested." });
  }
  if (backend === "terminal") {
    const key = keys.find(name => name !== "E2B_API_KEY")!;
    checks.push({ name: "terminal model authentication", ok: args.keyPresent(key), message:
      "The in-sandbox Codex runtime needs CODEX_API_KEY or OPENAI_API_KEY. Your host's Codex login is not forwarded; credential placement follows execution.runtimeAuth." });
  } else if (backend === "cua" && config.actors[0]?.type === "local-agent") {
    const choice = config.actors[0]?.localAgent ?? "codex";
    const agent = args.agents.find(entry => entry.id === choice);
    checks.push({ name: "local participant authentication", ok: agent?.authStatus === "authenticated", message:
      agent?.authStatus === "authenticated" ? `${agent.label} reports authenticated on the host. E2B supplies the desktop; no OpenAI API key is required for this participant.`
        : agent ? `${agent.label} ${agent.authStatus === "unauthenticated" ? "reports not signed in" : "authentication could not be checked"}. Run \`${choice === "codex" ? "codex login status" : "claude auth status"}\`; sign in or update the CLI before running.`
          : `${choice} is not on this process's PATH. Install and sign in to that CLI, or choose openai-computer-use with OPENAI_API_KEY.` });
  }
  if (backend === "scripted") {
    const { resolveBrowserCommand } = await import("./scripted-browser-actor.js");
    checks.push({ name: "scripted browser", ok: !!await resolveBrowserCommand(), message:
      "Scripted-browser uses local Chrome/Chromium and no participant model. Install Chrome/Chromium or set HUMANISH_BROWSER_COMMAND; a clone subject additionally needs E2B." });
  }
  for (const name of config.subject.env ?? []) {
    checks.push({ name: `subject env ${name}`, ok: !!args.env[name]?.trim() || args.keyPresent(name), message:
      args.env[name]?.trim() || args.keyPresent(name) ? "present; value not shown" : "missing declared subject environment variable; provide it with --env-file" });
  }
  const analysis = automaticAnalysisBudget(config.review?.analysis, backend);
  if (analysis?.provider === "codex") {
    const check = args.codexAnalysisReadiness ?? (async () => (await import("./restricted-codex-analysis.js")).checkRestrictedCodexAnalysisReadiness({ timeoutMs: 5000 }));
    const readiness = await check().catch(() => ({ ready: false, errorCode: "codex_unavailable" }));
    checks.push({ name: "post-run analysis", ok: readiness.ready, message: readiness.ready
      ? "Qualified Codex CLI and ChatGPT account login are ready for a separate restricted analyst. Analysis sends selected evidence to remote inference; model access and account allowance remain untested. Dollar cost and output-token ceilings are unavailable."
      : `Codex account analysis is unavailable (${readiness.errorCode ?? "codex_unavailable"}). Install the qualified CLI and sign in with a ChatGPT account. No API fallback is used; participant readiness is independent.` });
  } else if (analysis) {
    checks.push({ name: "post-run analysis", ok: true, message: args.keyPresent("OPENAI_API_KEY")
      ? `OPENAI_API_KEY is present for the separate automatic analysis request; model access and quota are not tested. Its $${analysis.maxCostUsd} admission estimate limit may decline larger studies before dispatch; it is not a provider billing cap. Participant readiness is independent.`
      : "Will be skipped: OPENAI_API_KEY is missing. The participant may run, but there will be no automatic findings report. Add an OpenAI API key or set review.analysis: false deliberately." });
  }
  checks.push({ name: "check scope", ok: true, message: "Local setup only. Provider credentials are not validated, model access/quota and target reachability are untested, and no paid resources were created." });
  return { desktop, keys, checks };
}

/** Required participant provider keys, shared by doctor and the TUI. Optional analysis is separate. */
export function labKeyRequirements(
  config: LabConfig,
  backend: LabBackend,
  dryRun: boolean,
  keyPresent: (name: string) => boolean
): { desktop: boolean; keys: string[] } {
  if (dryRun || unsupportedCliRoute(config, backend)) return { desktop: false, keys: [] };
  const desktop = backend === "cua" || backend === "terminal" || backend.includes("shared-world")
    || backend === "scripted" && config.subject.source === "clone";
  const keys = desktop ? ["E2B_API_KEY"] : [];
  if (backend === "terminal") keys.push(keyPresent("CODEX_API_KEY") ? "CODEX_API_KEY" : "OPENAI_API_KEY");
  else if ((backend === "cua" && config.actors[0]?.type !== "local-agent") || backend.includes("shared-world")) keys.push("OPENAI_API_KEY");
  return { desktop, keys };
}

function unsupportedCliRoute(config: LabConfig, backend: LabBackend): string | undefined {
  if (config.subject.source === "local-app") return "local-app needs a caller-supplied executor and provider through the library API; the plain CLI cannot run it.";
  if (backend === "meta") return "Live OSS meta-lab execution is disabled pending credential isolation. Use its dry-run or choose a supported actor/subject route.";
  if (backend === "synthetic") return "This route only creates synthetic evidence. Use first-run in dry-run mode or a supported live lab.";
  if (backend.includes("shared-world") && config.actors[0]?.type !== "openai-computer-use") return "Shared-world currently requires openai-computer-use with OPENAI_API_KEY; local-agent is supported on independent desktop lanes.";
  return undefined;
}
