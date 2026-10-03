// What a person, or the coding agent setting humanish up for them, should do next.
//
// Why: `humanish init` wrote twenty files and stopped. The only lab that could actually run was a
// $0 dry run; the two live ones were templates with `your-org/your-app` in them, so the first live
// run a newcomer tried could not succeed no matter what credentials they had. Three independent
// sources reached the same place: a participant in our own TUI study walked to the Start row and
// found a placeholder URL, an adoption review concluded "the funnel is broken at the first live
// run", and the release-gate participant said, unprompted, "validate one paid live study before
// committing".
//
// The fix is not more surface. Increasingly the thing running `init` is a coding agent acting for
// someone, and an agent reads stdout and does what it says. So init ends by naming the next
// command, and names the one that will actually work on this machine, because a next step that
// fails is worse than none.

import type { LocalAgentId } from "../actors/local-agent/cli.js";

/** A coding agent that reports a signed-in account on this machine. */
interface SignedInAgent {
  id: LocalAgentId;
  label: string;
}

export interface FirstRunEnvironment {
  /** A sandbox to run the study in. Nothing live happens without it. */
  hasE2bKey: boolean;
  /**
   * Whether `@e2b/desktop` resolves from this project. It is an optional peer: the no-keys path
   * does not need it, so a fresh `npx humanish` install does not have it, and a live run stops
   * with "install this other package first". Found by running the published artifact cold, after
   * two local runs passed because they resolved the peer from the repo's own node_modules.
   */
  hasDesktopSdk: boolean;
  /**
   * Whether humanish itself is installed in this project rather than running from an npx cache.
   * It changes what advice is true: a one-shot `npx humanish` resolves its optional peer relative
   * to itself, so "install the peer here" cannot work; humanish has to be installed alongside it.
   */
  installedInProject: boolean;
  /** A provider API key for the model. */
  hasProviderKey: boolean;
  /** The coding agents already signed in locally: Codex, Claude Code, or both. */
  localAgents: readonly SignedInAgent[];
  /** Host shape only; `doctor --lab local-browser` owns exact read-only readiness. */
  platform?: NodeJS.Platform;
  arch?: string;
}

export type FirstRunActor = "openai-computer-use" | "local-agent";

/**
 * Which brain the starter live lab should be written for. A machine with a signed-in coding agent
 * and no provider key can still do a real live run; writing the lab for the credential the
 * operator doesn't have is how a starter file becomes homework.
 */
export function starterActorFor(env: FirstRunEnvironment): FirstRunActor {
  if (!env.hasProviderKey && env.localAgents.length > 0) return "local-agent";
  return "openai-computer-use";
}

/** The signed-in agent a first study uses: Codex when it is signed in, else the one that is. */
function preferredAgent(env: FirstRunEnvironment): SignedInAgent | undefined {
  return env.localAgents.find((agent) => agent.id === "codex") ?? env.localAgents[0];
}

/**
 * The `localAgent` a local-agent starter lab names. Left out, the lab would default to Codex and
 * refuse to run on a machine where only Claude Code is signed in.
 */
export function starterLocalAgentFor(env: FirstRunEnvironment): LocalAgentId | undefined {
  return starterActorFor(env) === "local-agent" ? preferredAgent(env)?.id : undefined;
}

/**
 * How each hint invokes the CLI. \`npx humanish\` works from a project install and from an npx cache;
 * a dev-dependency install puts no \`humanish\` on \`PATH\`, so a bare name can reach a stale global one.
 */
const HUMANISH = "npx humanish";

/** Hosts the local browser lab runs on: Linux x64 and Apple Silicon Macs. */
export function supportsLocalBrowser(
  platform: NodeJS.Platform | undefined,
  arch: string | undefined,
): boolean {
  return (platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64");
}

export interface FirstRunStep {
  /** The exact command to run. */
  command: string;
  /** Why this one, in the register the rest of the CLI uses. */
  why: string;
}

/**
 * The next one or two commands, in order. Deliberately short: a list of twelve options is the same
 * as no guidance, and the reader here has just been handed twenty files.
 */
export function firstRunSteps(env: FirstRunEnvironment): FirstRunStep[] {
  const steps: FirstRunStep[] = [
    {
      command: `${HUMANISH} run first-run`,
      why: "an evidence preview: no browser or model runs, no keys, no spend",
    },
  ];

  if (supportsLocalBrowser(env.platform, env.arch)) {
    const prerequisites =
      env.platform === "darwin"
        ? "M3-or-newer Mac, native ARM64 Node, Lima 2.2+, and a supported signed-in Codex CLI"
        : "local rootful Docker, KVM, TUN, and a supported signed-in Codex CLI";
    steps.push({
      command: `${HUMANISH} doctor --lab local-browser`,
      why: `check the local browser lab (${prerequisites}); no resources or quota used. Run \`${HUMANISH} runtime setup\` to prepare it, then start your app and run \`${HUMANISH} run local-browser\`; no E2B or model API key`,
    });
    return steps;
  }
  const localUnavailable =
    env.platform === undefined
      ? ""
      : " Local browsers are unavailable on this host; they support Linux x64 or M3-or-newer Apple Silicon Macs.";

  if (!env.hasE2bKey) {
    steps.push({
      command: `${HUMANISH} keys set e2b`,
      why: `the hosted starter needs an E2B desktop.${localUnavailable}`,
    });
    return steps;
  }

  if (env.hasProviderKey || env.localAgents.length > 0) {
    const brain = env.hasProviderKey
      ? "your provider key"
      : `${preferredAgent(env)?.label} (already signed in, so no API key is needed)`;
    // Everything the step needs, in one line. Splitting it across two commands means the second
    // one fails, which is the same dead end this guidance exists to remove.
    const command = env.hasDesktopSdk
      ? `${HUMANISH} run try-live`
      : env.installedInProject
        ? `npm i -D @e2b/desktop && ${HUMANISH} run try-live`
        : // Running from an npx cache: installing only the peer here would not be found, because
          // Node resolves it relative to humanish. Both, or neither.
          `npm i -D humanish @e2b/desktop && ${HUMANISH} run try-live`;
    steps.push({
      command,
      why:
        `a live study: one participant drives a real app in a hosted desktop, using ${brain}` +
        (env.hasDesktopSdk ? "" : " (the desktop SDK is an optional peer, so it installs first)") +
        (!env.hasProviderKey
          ? "; automatic findings analysis is skipped without OPENAI_API_KEY"
          : "") +
        localUnavailable,
    });
    return steps;
  }

  steps.push({
    command: `${HUMANISH} keys set openai`,
    why:
      "openai-computer-use needs an API key; to use a Codex or Claude Code login instead, sign in and change the lab to actors[0].type: local-agent" +
      localUnavailable,
  });
  return steps;
}

/** The block init prints after its changes. */
export function firstRunGuidance(env: FirstRunEnvironment): string[] {
  const steps = firstRunSteps(env);
  return ["", "next:", ...steps.flatMap((step) => [`  ${step.command}`, `      ${step.why}`])];
}

/** Lets init recognise its own section without rewriting a file someone else wrote. */
export const AGENTS_SECTION_MARKER = "<!-- humanish:agents-guide -->";

/**
 * What the next coding agent needs to know about humanish in this project.
 *
 * `AGENTS.md` is the cross-vendor convention (agents.md) that Codex, Claude Code, Cursor and others
 * read on arrival. Increasingly the thing that ran `humanish init` was itself an agent working for
 * someone, and the agent that shows up tomorrow finds a `humanish/` directory with no idea what it
 * is for. Deliberately short and command-first, because an agent acts on the commands it is given.
 */
export function agentsSection(): string {
  return [
    "",
    `## humanish ${AGENTS_SECTION_MARKER}`,
    "",
    "This project uses humanish: synthetic participants use the product and leave evidence.",
    "",
    "```bash",
    "humanish doctor --lab try-live  # requirements for the selected participant and analysis",
    "humanish lab list --json   # the labs in this project",
    "humanish run first-run     # evidence preview only: no browser, model, keys, or spend",
    "humanish doctor --lab local-browser  # local Docker/Firecracker + Codex-account readiness",
    "humanish run local-browser # your loopback app; no E2B or model API key",
    "humanish run try-live      # demo app study: E2B plus the selected participant's authentication",
    "humanish verify --run latest --json   # is the evidence share-safe",
    "```",
    "",
    "- Labs are declared in `humanish/labs/*.yaml`. Edit `try-live.yaml`'s `subject` to point at",
    "  this project's own app once you have seen a run work.",
    "- Configure the local lab without editing YAML: `humanish init --yes --local-browser",
    '  http://127.0.0.1:3000 --local-mission "Complete the primary flow"` on first setup.',
    "- Evidence lands in gitignored `.humanish/runs/`. Never commit it, and never paste raw run",
    "  bundles into an issue; `humanish feedback issue` writes a redacted, share-safe draft.",
    "- `humanish tui` is for people and refuses to run in an agent session. Use the `--json`",
    "  commands above instead, and tell the person you are working for that `humanish tui` exists.",
    "- A live run spends money. `execution.caps.maxUsd` in each lab caps estimated model spend: the run",
    "  stops before its next request once the estimate passes it, so the last request can go over, and",
    "  hosted desktop time is billed on top. Do not raise it without asking the person you are working for.",
    "",
  ].join("\n");
}
