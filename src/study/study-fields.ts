// The study's fields, read in one place. StudyConfig still has the humanish.lab.v2 shape
// (`actors[0]`, `execution.caps`, `scenario.mode`), while a humanish.study.v3 file names the same
// values `actor`, `participants`, `surfaces`, `caps`, `mode`, `scenario` and `route`. Code outside
// the parser reads them through these functions, and tests/surface/study-config-reads.test.ts
// refuses a direct read, so the config can take the v3 shape by changing this file.

import type { StudyRoute } from "./routing.js";
import type {
  StudyActor,
  StudyConfig,
  StudyParticipantEntry,
  StudyScenario,
  StudyScenarioCaps,
} from "./types.js";

/** The actor that runs. A v3 file declares it as `actor`. */
export function actorOf(config: StudyConfig): StudyActor | undefined {
  return config.actors[0];
}

/**
 * Every declared actor. parseStudy accepts exactly one; a library config may declare more, and the
 * checks that refuse a second actor's settings read them all.
 */
export function actorsOf(config: StudyConfig): readonly StudyActor[] {
  return config.actors;
}

/** The participants listed one by one: a v3 `participants` list. Undefined when none is listed. */
export function participantList(config: StudyConfig): readonly StudyParticipantEntry[] | undefined {
  return config.actors[0]?.lanes;
}

/** The declared number of identical participants: v3 `participants: <n>` or `participants.count`. */
export function declaredParticipantCount(config: StudyConfig): number | undefined {
  return config.actors[0]?.count;
}

/** The steer each of a counted group of participants gets: v3 `participants.instruction`. */
export function participantInstruction(config: StudyConfig): string | undefined {
  return config.actors[0]?.laneFocus?.instruction;
}

/** How many scripted surfaces run, 1 for desktop and 2 with mobile. A v3 file lists `surfaces`. */
export function surfaceCount(config: StudyConfig): number | undefined {
  return config.actors[0]?.count;
}

/** The declared run mode. A v3 file declares it as `mode`. */
export function modeOf(config: StudyConfig): StudyScenario["mode"] {
  return config.scenario?.mode;
}

/** The scripted route's scenario id or path. A v3 file declares it as `scenario`. */
export function scenarioRefOf(config: StudyConfig): string | undefined {
  return config.scenario?.ref;
}

/**
 * The spend caps a route enforces. A v3 file declares them as `caps`. The v2 shape keeps them in
 * `execution.caps` on computer use and shared world, and in `scenario.caps` on terminal.
 */
export function capsOf(
  config: StudyConfig,
  route: Extract<StudyRoute, "computer-use" | "shared-world" | "terminal">,
): StudyScenarioCaps | undefined {
  return route === "terminal" ? config.scenario?.caps : config.execution?.caps;
}

/** True when the participants share one app. A v3 file declares `route: shared-world`. */
export function declaresSharedWorld(config: StudyConfig): boolean {
  return config.subject.topology === "shared-world";
}
