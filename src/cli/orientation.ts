// What `humanish` says when you run it with no arguments.
//
// Commander's help would print sixteen subcommands before any value, identical whether you
// had never run the tool or had a finished study sitting on disk. That is a poor first contact for
// a human, and it is worse for a coding agent, which needs to know where it is before it can choose
// a command; help is a menu, not an orientation.
//
// So bare invocation answers three questions instead: what is this, what state is this project in,
// and what should I run next. The answer is derived from the project rather than fixed, so it is
// useful on first contact and still useful on the hundredth run.
//
// Both audiences are served by the same data (docs/principles/three-roles.md). A human on a
// terminal gets prose and an offer to set things up; an agent gets the same facts as stable text,
// or as JSON with `--json`. Neither is a special case of the other bolted on afterwards.

import { listStudyManifests } from "../study/discover.js";
import { listRuns } from "../run/stored-runs.js";
import { plural } from "../run/text.js";
import { supportsLocalBrowser } from "./first-run-path.js";
import { PRODUCT_SENTENCE } from "./product-sentence.js";
import { cli } from "./invocation.js";

export const ORIENTATION_SCHEMA = "humanish.orientation.v1" as const;

export interface OrientationState {
  schema: typeof ORIENTATION_SCHEMA;
  /** Whether this project has a committed `humanish/` source plane. */
  initialized: boolean;
  /** Committed and gitignored study files found in this project. */
  studyCount: number;
  /** Ids of a few studies worth naming in a suggestion. */
  studyIds: string[];
  /** Runs already on disk, and the most recent one if there is one. */
  runCount: number;
  latestRunId?: string;
  /** The commands that make sense from here, most useful first. */
  nextCommands: OrientationCommand[];
}

interface OrientationCommand {
  command: string;
  why: string;
}

/**
 * Read the project's state. Pure-ish: it only reads, never writes, and never touches the network or
 * a provider: bare invocation must not be able to spend money or mutate a repo.
 */
export async function readOrientation(
  cwd: string,
  host: { platform: NodeJS.Platform; arch: string } = process,
): Promise<OrientationState> {
  const [found, runs] = await Promise.all([
    listStudyManifests(cwd).catch(() => undefined),
    listRuns(cwd).catch(() => undefined),
  ]);

  const studyIds = (found?.studies ?? [])
    .map((study) => study.id)
    .filter((id): id is string => typeof id === "string");
  const runIds = (runs?.runs ?? [])
    .map((run) => run.runId)
    .filter((id): id is string => typeof id === "string");
  const latest = typeof runs?.latest === "string" ? runs.latest : runIds[0];
  const retiredFiles = found?.retired ?? [];
  const retired = {
    v2: retiredFiles.filter((file) => file.code === "HUMANISH_STUDY_V2_UNSUPPORTED").length,
    moved: retiredFiles.filter((file) => file.code === "HUMANISH_STUDY_RETIRED_DIRECTORY").length,
  };
  const initialized =
    (found?.studies ?? []).some((study) => study.origin === "committed") ||
    studyIds.length > 0 ||
    retiredFiles.length > 0;

  return {
    schema: ORIENTATION_SCHEMA,
    initialized,
    studyCount: studyIds.length,
    studyIds: studyIds.slice(0, 3),
    runCount: runIds.length,
    ...(latest === undefined ? {} : { latestRunId: latest }),
    nextCommands: nextCommandsFor({
      initialized,
      studyIds,
      retired,
      hasRun: runIds.length > 0,
      host,
    }),
  };
}

/**
 * The two or three commands worth running from this state. Deliberately short: a list of everything
 * is commander's help, which nobody reads.
 */
function nextCommandsFor(args: {
  initialized: boolean;
  studyIds: string[];
  /**
   * Study files humanish no longer reads: humanish.lab.v2 files, which migrate converts, and v3
   * files in a labs/ directory, which migrate skips and the user moves.
   */
  retired: { v2: number; moved: number };
  hasRun: boolean;
  host: { platform: NodeJS.Platform; arch: string };
}): OrientationCommand[] {
  const { v2, moved } = args.retired;
  const fixes: OrientationCommand[] = [
    ...(v2 === 0
      ? []
      : [
          {
            command: cli("migrate --dry-run"),
            why: `${plural(v2, "study file")} ${v2 === 1 ? "uses" : "use"} humanish.lab.v2, which humanish no longer reads; this lists the conversion, and humanish migrate writes it`,
          },
        ]),
    ...(moved === 0
      ? []
      : [
          {
            command: cli("study list"),
            why: `${plural(moved, "study file")} ${moved === 1 ? "is" : "are"} in a labs/ directory, which humanish no longer reads; this names each one and the studies/ directory to move it to`,
          },
        ]),
  ];
  // A fix that is already `study list` replaces the plain suggestion of the same command.
  const named = new Set(fixes.map((fix) => fix.command));
  return [...fixes, ...nextCommandsForStudies(args).filter((next) => !named.has(next.command))];
}

function nextCommandsForStudies(args: {
  initialized: boolean;
  studyIds: string[];
  hasRun: boolean;
  host: { platform: NodeJS.Platform; arch: string };
}): OrientationCommand[] {
  const dryRun = {
    command: cli("run first-run"),
    why: "a dry run: no browser or model runs, no keys, no spend",
  };
  if (!args.initialized) {
    return [
      {
        command: cli("init --yes"),
        why: "write starter studies, personas and an AGENTS.md (--dry-run lists every file first)",
      },
      dryRun,
    ];
  }

  // The starter live study this host can run: the hosted try-live study first, since it needs no
  // local Docker or VM, then the local one where the host shape supports it. The other starter
  // studies are templates whose subject still names your-org/your-app, so they are never suggested.
  const liveStudy = (
    supportsLocalBrowser(args.host.platform, args.host.arch)
      ? ["try-live", "local-browser"]
      : ["try-live"]
  ).find((id) => args.studyIds.includes(id));
  if (!args.hasRun) {
    return [
      dryRun,
      liveStudy === undefined
        ? { command: cli("study list"), why: "see the studies this project declares" }
        : {
            command: cli(`doctor --study ${liveStudy}`),
            why: `check what the ${liveStudy} study still needs before a live run`,
          },
    ];
  }
  return [
    ...(liveStudy === undefined
      ? []
      : [{ command: cli(`run ${liveStudy}`), why: "run a real participant against an app" }]),
    {
      command: cli("verify --run latest"),
      why: "check the last run's evidence and public-safety gates",
    },
    { command: cli("observe --run latest"), why: "reopen the last run's Observer" },
  ];
}

/**
 * The human rendering. Says where you are before it says what to do, because "what should I run"
 * has no answer that is true in every project.
 */
export function formatOrientationHuman(state: OrientationState): string {
  const lines: string[] = [`humanish: ${PRODUCT_SENTENCE}`, ""];

  if (!state.initialized) {
    lines.push("This project is not set up yet.");
  } else {
    const studies = state.studyCount === 1 ? "1 study" : `${state.studyCount} studies`;
    const runs =
      state.runCount === 0
        ? "no runs yet"
        : state.runCount === 1
          ? "1 run"
          : `${state.runCount} runs`;
    lines.push(
      `This project has ${studies} and ${runs}${state.latestRunId ? ` (latest: ${state.latestRunId})` : ""}.`,
    );
  }

  lines.push("");
  for (const next of state.nextCommands) {
    lines.push(`  ${next.command}`);
    lines.push(`      ${next.why}`);
  }
  lines.push("");
  lines.push(`\`${cli("--help")}\` lists every command.`);
  return `${lines.join("\n")}\n`;
}
