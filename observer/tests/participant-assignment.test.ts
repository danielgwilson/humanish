import { describe, expect, it } from "vitest";
import { recordedParticipantAssignment } from "../lib/participant-assignment";
import type { ObserverStream } from "../lib/observer-data";

const stream = (lane: string, intent: unknown) => ({ actor: { lane }, ui: { intent } }) as unknown as ObserverStream;
describe("retained participant assignment projection", () => {
  it("uses only this scripted participant's retained goal", () => {
    expect(recordedParticipantAssignment(stream("scripted-browser", "Inspect the saved list.")))
      .toEqual({ assignment: { mission: "Inspect the saved list." }, source: "scripted_goal" });
  });
  it.each(["cua", "desktop-cli", "unknown"])("never turns %s display intent into a recorded assignment", (lane) => {
    expect(recordedParticipantAssignment(stream(lane, "Generic display intent."))).toBeNull();
  });
  it.each([undefined, null, "", "  "])("keeps missing/empty scripted goals explicit", (intent) => {
    expect(recordedParticipantAssignment(stream("scripted-browser", intent))).toBeNull();
  });
});
