import liveBundle from "../../tests/golden/labs/live.json";
import type { ActorCompletionReason, ActorStatus } from "../../src/actors/contract";
import { buildObserverData } from "../../src/observer/data";
import { participantCaption } from "../../src/run/participant-caption";
import type { RunBundle } from "../../src/run/bundle";
import { tallyParticipantOutcomes } from "../../src/run/outcomes";
import type { ObserverData } from "../lib/observer-data";

/** The personas the participants take in turn: participant n has persona n mod 3. */
const SCALE_PERSONAS = ["first-time-visitor", "keyboard-first", "impatient-skimmer"];

/** How every ten participants end, in order: six reach the goal, then one of each other ending. */
const ENDINGS: { status: ActorStatus; completionReason: ActorCompletionReason }[] = [
  ...Array.from({ length: 6 }, () => ({
    status: "passed" as const,
    completionReason: "goal_satisfied" as const,
  })),
  { status: "blocked", completionReason: "blocked_approval" },
  { status: "abandoned", completionReason: "gave_up" },
  { status: "incomplete", completionReason: "budget_reached" },
  { status: "failed", completionReason: "harness_error" },
];

/**
 * A finished computer-use run of `count` participants, built by the producer from the recorded
 * one-participant run in tests/golden/labs/live.json. Each participant gets its own ids, its own
 * screenshot folder (as a fan-out run writes them), and a persona and an ending from the lists
 * above, so 100 participants are 60 reported complete and 10 each blocked, gave up, interrupted
 * and failed.
 */
export function scaleFixture(count: number): ObserverData {
  const source = structuredClone(liveBundle) as unknown as RunBundle;
  const template = source.streams[0]!;
  const sim = source.simulations[0]!;
  const runEvents = source.events.filter((event) => event.simId === undefined);
  const participantEvents = source.events.filter((event) => event.simId === sim.id);
  const bundle: RunBundle = {
    ...source,
    simCount: count,
    simulations: [],
    streams: [],
    events: [...runEvents],
    providerResources: [],
  };
  const statuses: ActorStatus[] = [];
  for (let n = 0; n < count; n += 1) {
    const number = String(n + 1).padStart(3, "0");
    const laneId = `lane-${String(n + 1).padStart(2, "0")}`;
    const simId = `sim-${number}`;
    const streamId = `stream-${number}`;
    const personaId = SCALE_PERSONAS[n % SCALE_PERSONAS.length]!;
    const ending = ENDINGS[n % ENDINGS.length]!;
    statuses.push(ending.status);
    const stream = JSON.parse(
      JSON.stringify(template).replaceAll('"screenshots/', `"screenshots/${laneId}/`),
    ) as typeof template;
    bundle.streams.push({
      ...stream,
      id: streamId,
      simId,
      laneId,
      label: participantCaption({ id: laneId, personaId }),
      status: ending.status,
      actor: {
        ...stream.actor!,
        persona: { ...stream.actor!.persona, id: personaId },
        status: ending.status,
        completionReason: ending.completionReason,
      },
    });
    bundle.simulations.push({
      ...sim,
      id: simId,
      index: n + 1,
      personaId,
      status: ending.status,
      streamIds: [streamId],
    });
    bundle.events.push(
      ...participantEvents.map((event) => ({
        ...event,
        id: `${event.id}-${number}`,
        simId,
        streamId,
      })),
    );
  }
  bundle.review = {
    ...source.review,
    verdict: "fail",
    participants: tallyParticipantOutcomes(statuses),
  };
  return buildObserverData(bundle, "2026-10-09T00:00:00.000Z");
}
