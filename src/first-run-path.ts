// What a person — or the coding agent setting humanish up for them — should do NEXT.
//
// WHY: `humanish init` wrote twenty files and stopped. The only lab that could actually run was a
// $0 dry run; the two live ones were templates with `your-org/your-app` in them, so the first live
// run a newcomer tried could not succeed no matter what credentials they had. Three independent
// sources reached the same place — a participant in our own TUI study walked to the Start row and
// found a placeholder URL, an adoption review concluded "the funnel is broken at the first live
// run", and the release-gate participant said, unprompted, "validate one paid live study before
// committing" (#505).
//
// The fix is not more surface. Increasingly the thing running `init` is a coding agent acting for
// someone, and an agent reads stdout and does what it says. So init ends by naming the next
// command — and names the one that will actually work ON THIS MACHINE, because a next step that
// fails is worse than none.

export interface FirstRunEnvironment {
  /** A sandbox to run the study in. Nothing live happens without it. */
  hasE2bKey: boolean;
  /**
   * Whether `@e2b/desktop` resolves from this project. It is an OPTIONAL peer — the no-keys path
   * does not need it — so a fresh `npx humanish` install does not have it, and a live run stops
   * with "install this other package first". Found by running the published artifact cold, after
   * two local runs passed because they resolved the peer from the repo's own node_modules.
   */
  hasDesktopSdk: boolean;
  /**
   * Whether humanish itself is installed in this project rather than running from an npx cache.
   * It changes what advice is TRUE: a one-shot `npx humanish` resolves its optional peer relative
   * to itself, so "install the peer here" cannot work — humanish has to be installed alongside it.
   */
  installedInProject: boolean;
  /** A provider API key for the model. */
  hasProviderKey: boolean;
  /** A coding agent already signed in locally — Codex or Claude Code. */
  localAgents: readonly string[];
}

export type FirstRunActor = "openai-computer-use" | "local-agent";

/**
 * Which brain the starter live lab should be written for. A machine with a signed-in coding agent
 * and no provider key can still do a real live run; writing the lab for the credential the
 * operator DOESN'T have is how a starter file becomes homework.
 */
export function starterActorFor(env: FirstRunEnvironment): FirstRunActor {
  if (!env.hasProviderKey && env.localAgents.length > 0) return "local-agent";
  return "openai-computer-use";
}

export interface FirstRunStep {
  /** The exact command to run. */
  command: string;
  /** Why this one, in the register the rest of the CLI uses. */
  why: string;
}

/**
 * The next one or two commands, in order. Deliberately SHORT: a list of twelve options is the same
 * as no guidance, and the reader here has just been handed twenty files.
 */
export function firstRunSteps(env: FirstRunEnvironment): FirstRunStep[] {
  const steps: FirstRunStep[] = [
    {
      command: "humanish run first-run",
      why: "an evidence preview: no browser or model runs, no keys, no spend"
    }
  ];

  if (!env.hasE2bKey) {
    steps.push({
      command: "humanish keys set e2b",
      why: "a live study needs a sandbox to run in; this is the only credential it always needs"
    });
    return steps;
  }

  if (env.hasProviderKey || env.localAgents.length > 0) {
    const brain = env.hasProviderKey
      ? "your provider key"
      : `${env.localAgents[0]} (already signed in — no API key needed)`;
    // Everything the step needs, in one line. Splitting it across two commands means the second
    // one fails, which is the same dead end this guidance exists to remove.
    const command = env.hasDesktopSdk
      ? "humanish run try-live"
      : env.installedInProject
        ? "npm i -D @e2b/desktop && humanish run try-live"
        // Running from an npx cache: installing only the peer here would not be found, because
        // Node resolves it relative to humanish. Both, or neither.
        : "npm i -D humanish @e2b/desktop && npx humanish run try-live";
    steps.push({
      command,
      why: `a REAL study: one participant drives a real app in a hosted desktop, using ${brain}`
        + (env.hasDesktopSdk ? "" : " (the desktop SDK is an optional peer, so it installs first)")
    });
    return steps;
  }

  steps.push({
    command: "humanish keys set openai",
    why: "a live study needs a model to think with — or sign in to Codex or Claude Code and humanish will use that instead"
  });
  return steps;
}

/** The block init prints after its changes. */
export function firstRunGuidance(env: FirstRunEnvironment): string[] {
  const steps = firstRunSteps(env);
  return [
    "",
    "next:",
    ...steps.flatMap((step) => [`  ${step.command}`, `      ${step.why}`])
  ];
}

/** Lets init recognise its own section without rewriting a file someone else wrote. */
export const AGENTS_SECTION_MARKER = "<!-- humanish:agents-guide -->";

/**
 * What the NEXT coding agent needs to know about humanish in this project.
 *
 * AGENTS.md is the cross-vendor convention (agents.md) that Codex, Claude Code, Cursor and others
 * read on arrival. Increasingly the thing that ran `humanish init` was itself an agent working for
 * someone, and the agent that shows up tomorrow finds a `humanish/` directory with no idea what it
 * is for. Deliberately SHORT and command-first: an agent acts on commands, not on prose.
 */
export function agentsSection(): string {
  return [
    "",
    `## humanish ${AGENTS_SECTION_MARKER}`,
    "",
    "This project uses humanish: synthetic participants use the product and leave evidence.",
    "",
    "```bash",
    "humanish doctor            # what is configured, and what a live run still needs",
    "humanish lab list --json   # the studies in this project",
    "humanish run first-run     # evidence preview only: no browser, model, keys, or spend",
    "humanish run try-live      # a REAL study against a demo app (needs E2B_API_KEY)",
    "humanish verify --run latest --json   # is the evidence share-safe",
    "```",
    "",
    "- Studies are declared in `humanish/labs/*.yaml`. Edit `try-live.yaml`'s `subject` to point at",
    "  this project's own app once you have seen a run work.",
    "- Evidence lands in gitignored `.humanish/runs/`. Never commit it, and never paste raw run",
    "  bundles into an issue — `humanish feedback issue` produces a redacted, share-safe draft.",
    "- `humanish tui` is a HUMAN surface and refuses to run in an agent session. Use the `--json`",
    "  commands above instead, and tell the person you are working for that `humanish tui` exists.",
    "- A live run spends money. `execution.caps.maxUsd` in each lab is a fail-closed ceiling; do not",
    "  raise it without asking the person you are working for.",
    ""
  ].join("\n");
}
