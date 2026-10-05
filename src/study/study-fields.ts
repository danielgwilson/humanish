// The study's fields, read in one place. Participants are the one read that is not a field: a v3
// study declares them as a count, as `{ count, instruction }` or as a list, and the accessors below
// read each form. tests/surface/study-config-reads.test.ts refuses a direct read of a humanish.lab.v2
// field anywhere outside migrate.

import type { StudyActor, StudyCaps, StudyConfig, StudyParticipantEntry } from "./types.js";

/** The actor that runs. */
export function actorOf(config: StudyConfig): StudyActor | undefined {
  return config.actor;
}

/** The participants listed one by one: a `participants` list. Undefined when none is listed. */
export function participantList(config: StudyConfig): readonly StudyParticipantEntry[] | undefined {
  return Array.isArray(config.participants) ? config.participants : undefined;
}

/** The declared number of identical participants: `participants: <n>` or `participants.count`. */
export function declaredParticipantCount(config: StudyConfig): number | undefined {
  const { participants } = config;
  if (typeof participants === "number") return participants;
  return isGroup(participants) ? participants.count : undefined;
}

/** The steer each of a counted group of participants gets: `participants.instruction`. */
export function participantInstruction(config: StudyConfig): string | undefined {
  return isGroup(config.participants) ? config.participants.instruction : undefined;
}

/** How many scripted surfaces run, 1 for desktop and 2 with mobile. */
export function surfaceCount(config: StudyConfig): number | undefined {
  return config.surfaces?.length;
}

/** The declared run mode. */
export function modeOf(config: StudyConfig): StudyConfig["mode"] {
  return config.mode;
}

/** The scripted route's scenario id or path. */
export function scenarioRefOf(config: StudyConfig): string | undefined {
  return config.scenario;
}

/** The spend caps the route enforces. parseStudy refuses a key the route does not read. */
export function capsOf(config: StudyConfig): StudyCaps | undefined {
  return config.caps;
}

/** True when the participants share one app: `route: shared-world`. */
export function declaresSharedWorld(config: StudyConfig): boolean {
  return config.route === "shared-world";
}

function isGroup(
  participants: StudyConfig["participants"],
): participants is Exclude<StudyConfig["participants"], number | readonly unknown[] | undefined> {
  return typeof participants === "object" && participants !== null && !Array.isArray(participants);
}
