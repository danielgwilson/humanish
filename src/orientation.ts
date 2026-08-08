// What `humanish` says when you run it with no arguments (#367).
//
// It used to print commander's help: sixteen subcommands before any value, identical whether you
// had never run the tool or had a finished study sitting on disk. That is a poor first contact for
// a human, and it is worse for a coding agent, which needs to know WHERE IT IS before it can choose
// a command — help is a menu, not an orientation.
//
// So bare invocation answers three questions instead: what is this, what state is this project in,
// and what should I run next. The answer is derived from the project rather than fixed, so it is
// useful on first contact and still useful on the hundredth run.
//
// Both audiences are served by the same data (docs/principles/three-roles.md). A human on a
// terminal gets prose and an offer to set things up; an agent gets the same facts as stable text,
// or as JSON with `--json`. Neither is a special case of the other bolted on afterwards.

import { listLabManifests } from "./labs.js";
import { listRuns } from "./run.js";

export const ORIENTATION_SCHEMA = "humanish.orientation.v1" as const;

export interface OrientationState {
  schema: typeof ORIENTATION_SCHEMA;
  /** Whether this project has a committed `humanish/` source plane. */
  initialized: boolean;
  /** Committed + gitignored lab manifests discovered in this project. */
  labCount: number;
  /** Ids of a few labs worth naming in a suggestion. */
  labIds: string[];
  /** Runs already on disk, and the most recent one if there is one. */
  runCount: number;
  latestRunId?: string;
  /** The commands that make sense from HERE, most useful first. */
  nextCommands: OrientationCommand[];
}

export interface OrientationCommand {
  command: string;
  why: string;
}

/**
 * Read the project's state. Pure-ish: it only reads, never writes, and never touches the network or
 * a provider — bare invocation must not be able to spend money or mutate a repo.
 */
export async function readOrientation(cwd: string): Promise<OrientationState> {
  const [labs, runs] = await Promise.all([
    listLabManifests(cwd).catch(() => undefined),
    listRuns(cwd).catch(() => undefined)
  ]);

  const labIds = (labs?.labs ?? []).map((lab) => lab.id).filter((id): id is string => typeof id === "string");
  const runIds = (runs?.runs ?? []).map((run) => run.runId).filter((id): id is string => typeof id === "string");
  const latest = typeof runs?.latest === "string" ? runs.latest : runIds[0];
  const initialized = (labs?.labs ?? []).some((lab) => lab.origin === "committed") || labIds.length > 0;

  return {
    schema: ORIENTATION_SCHEMA,
    initialized,
    labCount: labIds.length,
    labIds: labIds.slice(0, 3),
    runCount: runIds.length,
    ...(latest === undefined ? {} : { latestRunId: latest }),
    nextCommands: nextCommandsFor({ initialized, labIds, hasRun: runIds.length > 0 })
  };
}

/**
 * The two or three commands worth running from this state. Deliberately short: a list of everything
 * is what bare invocation used to print, and it is why nobody read it.
 */
function nextCommandsFor(args: { initialized: boolean; labIds: string[]; hasRun: boolean }): OrientationCommand[] {
  if (!args.initialized) {
    return [
      { command: "humanish init", why: "create humanish/ with a starter lab and persona" },
      { command: "humanish run first-run", why: "a synthetic run with no keys and no spend, to see the shape of the evidence" }
    ];
  }

  const suggestedLab = args.labIds[0];
  const commands: OrientationCommand[] = [
    {
      command: suggestedLab ? `humanish watch ${suggestedLab}` : "humanish watch",
      why: "run a lab and open the Observer while it goes"
    }
  ];
  if (args.hasRun) {
    commands.push({ command: "humanish verify --run latest", why: "check the last run's evidence and public-safety gates" });
    commands.push({ command: "humanish observe --run latest", why: "reopen the last run's Observer" });
  } else {
    commands.push({ command: "humanish lab list", why: "see the labs this project declares" });
    commands.push({ command: "humanish doctor", why: "check what this project still needs before a live run" });
  }
  return commands;
}

/**
 * The human rendering. Says where you are before it says what to do, because "what should I run"
 * has no answer that is true in every project.
 */
export function formatOrientationHuman(state: OrientationState): string {
  const lines: string[] = [
    "humanish — run realistic synthetic personas against your app and keep the evidence.",
    ""
  ];

  if (!state.initialized) {
    lines.push("This project is not set up yet.");
  } else {
    const labs = state.labCount === 1 ? "1 lab" : `${state.labCount} labs`;
    const runs = state.runCount === 0 ? "no runs yet" : state.runCount === 1 ? "1 run" : `${state.runCount} runs`;
    lines.push(`This project has ${labs} and ${runs}${state.latestRunId ? ` (latest: ${state.latestRunId})` : ""}.`);
  }

  lines.push("");
  for (const next of state.nextCommands) {
    lines.push(`  ${next.command}`);
    lines.push(`      ${next.why}`);
  }
  lines.push("");
  lines.push("`humanish --help` lists every command.");
  return `${lines.join("\n")}\n`;
}
