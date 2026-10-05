// What a person, or the coding agent setting humanish up for them, should do next.
//
// Why: `humanish init` wrote twenty files and stopped. The only study that could actually run was a
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
   * The command that installs `@e2b/desktop` where this humanish resolves it, ahead of
   * `npx humanish`: beside humanish in its project, or humanish and the peer together in this one
   * when humanish runs from an npx cache, a global install or another directory. Undefined where
   * `npm i` would prune a node_modules that no package.json declares.
   */
  desktopPeerCommand: string | undefined;
  /** A provider API key for the model. */
  hasProviderKey: boolean;
  /** The coding agents already signed in locally: Codex, Claude Code, or both. */
  localAgents: readonly SignedInAgent[];
  /**
   * init's quick read of this host for a local browser study: Linux x64 with `/dev/kvm`,
   * `/dev/net/tun` and Docker,
   * or an M3-or-newer Mac. Undefined when it was not read. `doctor --study local-browser` owns the
   * full check.
   */
  localBrowserHost?: LocalBrowserHost;
  /** Host shape only, for the prerequisites a local step names. */
  platform?: NodeJS.Platform;
  /** How a suggested command invokes humanish; `npx humanish` when unset. */
  humanish?: string;
}

/** Whether this host passed init's quick checks for a local browser study, and why not. */
export type LocalBrowserHost = { ok: true } | { ok: false; reason: string };

export type FirstRunActor = "openai-computer-use" | "local-agent";

/**
 * Which brain the starter live study should be written for. A machine with a signed-in coding agent
 * and no provider key can still do a real live run; writing the study for the credential the
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
 * The `localAgent` a local-agent starter study names. Left out, the study would default to Codex and
 * refuse to run on a machine where only Claude Code is signed in.
 */
export function starterLocalAgentFor(env: FirstRunEnvironment): LocalAgentId | undefined {
  return starterActorFor(env) === "local-agent" ? preferredAgent(env)?.id : undefined;
}

/** Host shapes the local browser route is built for: Linux x64 and Apple Silicon Macs. */
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
 * The next two or three commands, in order: the dry run, the hosted try-live study when keys or a
 * signed-in agent allow it, and the local browser study where this host passed its quick checks.
 * Deliberately short: a list of twelve options is the same as no guidance, and the reader here has
 * just been handed a directory of new files.
 */
export function firstRunSteps(env: FirstRunEnvironment): FirstRunStep[] {
  const humanish = env.humanish ?? "npx humanish";
  const steps: FirstRunStep[] = [
    {
      command: `${humanish} run first-run`,
      why: "a dry run: no browser or model runs, no keys, no spend",
    },
  ];
  const local = localBrowserStep(env, humanish);
  const hostedRunnable = env.hasE2bKey && (env.hasProviderKey || env.localAgents.length > 0);
  if (hostedRunnable) {
    steps.push(hostedStep(env, humanish, ""));
    if (local !== undefined) steps.push(local);
  } else if (local !== undefined) {
    steps.push(local);
  } else {
    steps.push(hostedStep(env, humanish, localUnavailableNote(env)));
  }
  return steps;
}

/** The local browser step, where the host passed init's checks and Codex is signed in. */
function localBrowserStep(env: FirstRunEnvironment, humanish: string): FirstRunStep | undefined {
  if (env.localBrowserHost?.ok !== true) return undefined;
  if (!env.localAgents.some((agent) => agent.id === "codex")) return undefined;
  const prerequisites =
    env.platform === "darwin"
      ? "native ARM64 Node, Lima 2.2+, and a supported signed-in Codex CLI"
      : "local rootful Docker, KVM, TUN, and a supported signed-in Codex CLI";
  return {
    command: `${humanish} doctor --study local-browser`,
    why: `check the local browser study (${prerequisites}); no resources or quota used. Run \`${humanish} runtime setup\` to prepare it, then start your app and run \`${humanish} run local-browser\`; no E2B or model API key`,
  };
}

/** Why the local route is not offered, appended to a key step so the reader knows it was considered. */
function localUnavailableNote(env: FirstRunEnvironment): string {
  const host = env.localBrowserHost;
  if (host === undefined) return "";
  if (!host.ok) return ` Local browser studies are unavailable on this host: ${host.reason}.`;
  return " A local browser study also runs on this host once Codex is signed in (`codex login`).";
}

/** The hosted try-live step, or the key or setup step it still needs. */
function hostedStep(env: FirstRunEnvironment, humanish: string, note: string): FirstRunStep {
  if (!env.hasE2bKey) {
    return {
      command: `${humanish} keys set e2b`,
      why: `the hosted starter needs an E2B desktop.${note}`,
    };
  }
  if (!env.hasProviderKey && env.localAgents.length === 0) {
    return {
      command: `${humanish} keys set openai`,
      why:
        "openai-computer-use needs an API key; to use a Codex or Claude Code login instead, sign in and change the study to actor.type: local-agent." +
        note,
    };
  }
  const brain = env.hasProviderKey
    ? "your provider key"
    : `${preferredAgent(env)?.label} (already signed in, so no API key is needed)`;
  // Everything the step needs, in one line. Splitting it across two commands means the second
  // one fails, which is the same dead end this guidance exists to remove.
  if (!env.hasDesktopSdk && env.desktopPeerCommand === undefined) {
    return {
      command: `${humanish} doctor`,
      why: "the hosted starter needs the desktop SDK, and installing it from here would remove what this directory's node_modules holds; doctor names the command to run from your project's directory",
    };
  }
  // After the peer install, humanish is a dependency of this project, where `npx humanish` finds it.
  const command = env.hasDesktopSdk
    ? `${humanish} run try-live`
    : `${env.desktopPeerCommand} && npx humanish run try-live`;
  return {
    command,
    why:
      `a live study: one participant drives a real app in a hosted desktop, using ${brain}` +
      (env.hasDesktopSdk ? "" : " (the desktop SDK is an optional peer, so it installs first)") +
      (!env.hasProviderKey
        ? "; automatic findings analysis is skipped without OPENAI_API_KEY"
        : "") +
      note,
  };
}

/** The block init prints after its changes. */
export function firstRunGuidance(env: FirstRunEnvironment): string[] {
  const steps = firstRunSteps(env);
  return ["", "next:", ...steps.flatMap((step) => [`  ${step.command}`, `      ${step.why}`])];
}

/** Starts humanish's section of `AGENTS.md`, on its heading line. */
export const AGENTS_SECTION_MARKER = "<!-- humanish:agents-guide -->";

/** Ends humanish's section, so init can replace the section and nothing after it. */
export const AGENTS_SECTION_END_MARKER = "<!-- /humanish:agents-guide -->";

/**
 * What the next coding agent needs to know about humanish in this project.
 *
 * `AGENTS.md` is the cross-vendor convention (agents.md) that Codex, Claude Code, Cursor and others
 * read on arrival. Increasingly the thing that ran `humanish init` was itself an agent working for
 * someone, and the agent that shows up tomorrow finds a `humanish/` directory with no idea what it
 * is for. Deliberately short and command-first, because an agent acts on the commands it is given.
 * Commands use `humanish`, the prefix init chose for where humanish is installed.
 */
export function agentsSection(humanish = "npx humanish"): string {
  const commands: Array<[string, string]> = [
    ["study list --json", "the studies in this project"],
    ["run first-run --no-open", "dry run: no browser, model, keys, or spend"],
    ["doctor --study try-live", "what the hosted starter study still needs"],
    [
      "run try-live --no-open",
      "demo app study: E2B plus the selected participant's authentication",
    ],
    ["doctor --study local-browser", "local Docker/Firecracker + Codex-account readiness"],
    ["run local-browser --no-open", "your loopback app; no E2B or model API key"],
    ["verify --run <id> --json", "is the evidence share-safe"],
    ["review --run <id>", "the run's outcome and its analysis findings"],
  ];
  const width = Math.max(...commands.map(([command]) => command.length));
  return [
    "",
    `## humanish ${AGENTS_SECTION_MARKER}`,
    "",
    "This project uses humanish: synthetic participants use the product and leave evidence.",
    "",
    "```bash",
    ...commands.map(([command, why]) => `${humanish} ${command.padEnd(width)}  # ${why}`),
    "```",
    "",
    `- After a live run, run \`${humanish} review --run <id>\` (or \`--json\`) and report its findings`,
    "  to the person you are working for: each one's title, impact, confidence, recovery and cited",
    "  captures. When it shows no findings, report its message and the command it names. Every run",
    "  prints its id; `latest` moves with each run, dry runs included.",
    "- Studies are declared in `humanish/studies/*.yaml`. Edit `try-live.yaml`'s `subject` to point",
    "  at this project's own app once you have seen a run work.",
    `- Configure the local study without editing YAML: \`${humanish} init --yes --local-browser`,
    '  http://127.0.0.1:3000 --local-mission "Complete the primary flow"` on first setup.',
    "- Evidence lands in gitignored `.humanish/runs/`. Never commit it, and never paste raw run",
    `  bundles into an issue; \`${humanish} feedback issue\` writes a redacted, share-safe draft.`,
    `- \`${humanish} tui\` is for people and refuses to run in an agent session. Use the commands`,
    "  above instead, and tell the person you are working for that the TUI exists.",
    "- A live run spends money. `caps.maxUsd` in each study caps estimated model spend: the run",
    "  stops before its next request once the estimate passes it, so the last request can go over, and",
    "  hosted desktop time is billed on top. Do not raise it without asking the person you are working for.",
    `- \`${humanish} init --yes\` rewrites this section, between its two markers, to match the installed`,
    "  humanish. Write your own notes outside it.",
    "",
    AGENTS_SECTION_END_MARKER,
    "",
  ].join("\n");
}
