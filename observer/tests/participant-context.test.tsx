import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import type { ObserverStream } from "../lib/observer-data";
import { ParticipantAssignment } from "../components/participant-assignment";

describe("retained participant context", () => {
  it("shows the supplied background separately from assignment and recorded guidance", () => {
    const stream = structuredClone(live.streams[0]) as unknown as ObserverStream;
    stream.actor!.persona.brief = {
      compilerVersion: 2,
      text: "Coordinates volunteers.\nConcerned about public rosters.",
      digest: "synthetic",
      redacted: true,
    };
    stream.assignment = { mission: "Arrange Saturday's event." };
    stream.actor!.items.push({
      id: "hint",
      kind: "notice",
      title: "Participant context hint",
      text: "No visible progress for 3 steps.",
      lifecycle: "completed",
    });
    const html = renderToStaticMarkup(<ParticipantAssignment stream={stream} />);
    expect(html).toContain("Concerned about public rosters.");
    expect(html).toContain("sensitive values removed");
    expect(html).toContain("Session guidance");
    expect(html).toContain("No visible progress for 3 steps.");
    expect(html).toContain("Arrange Saturday");
  });

  it("does not invent background or absence of guidance for old bundles", () => {
    const stream = structuredClone(live.streams[0]) as unknown as ObserverStream;
    delete stream.actor!.persona.brief;
    const html = renderToStaticMarkup(<ParticipantAssignment stream={stream} />);
    expect(html).toContain("Background was not recorded");
    expect(html).not.toContain("Session guidance");
  });
});
