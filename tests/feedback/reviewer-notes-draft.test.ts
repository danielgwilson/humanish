// A feedback draft carries the run's reviewer notes, labelled as notes a person added while
// reviewing, apart from what participants said.
import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { draftFeedback, renderIssueMarkdown, verifyFeedback } from "../../src/feedback/feedback.js";
import { RUN_NOTES_SCHEMA } from "../../src/run/notes.js";
import { runSyntheticLive } from "../helpers/synthetic-live-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "noted-feedback-run";

function note(id: string, atMs: number, participant: string | null, text: string) {
  return {
    id,
    atMs,
    participant,
    nearest: null,
    text,
    author: "you",
    createdAt: "2026-05-01T10:00:00.000Z",
    editedAt: null,
  };
}

async function notedLiveRun(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-notes-feedback-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runSyntheticLive({ cwd, dryRun: true, runId: RUN });
  await writeFile(
    path.join(cwd, ".humanish", "runs", RUN, "notes.json"),
    JSON.stringify({
      schema: RUN_NOTES_SCHEMA,
      runId: RUN,
      notes: [
        note("note-late", 151_000, null, "The whole page went blank."),
        note("note-early", 12_000, "sim-01-ui", "The menu was hidden.\nThey scrolled past it."),
      ],
    }),
  );
  return cwd;
}

describe("reviewer notes in feedback drafts", () => {
  it("lists the notes in run clock order and cites notes.json", async () => {
    const cwd = await notedLiveRun();

    const drafted = await draftFeedback(cwd, RUN);

    expect(drafted.ok).toBe(true);
    expect(drafted.draft?.reviewer_notes).toEqual([
      {
        id: "note-early",
        at: "00:12",
        at_ms: 12_000,
        participant: "sim-01-ui",
        author: "you",
        text: "The menu was hidden.\nThey scrolled past it.",
      },
      {
        id: "note-late",
        at: "02:31",
        at_ms: 151_000,
        participant: null,
        author: "you",
        text: "The whole page went blank.",
      },
    ]);
    expect(drafted.draft?.evidence.map((item) => path.basename(item.path))).toContain("notes.json");
    expect((await verifyFeedback(cwd, RUN)).ok).toBe(true);
  });

  it("renders the notes under their own heading, labelled as reviewer notes", async () => {
    const cwd = await notedLiveRun();

    const rendered = await renderIssueMarkdown(cwd, RUN, "example/app");

    expect(rendered.ok).toBe(true);
    const markdown = rendered.issueMarkdown ?? "";
    const section = markdown.slice(
      markdown.indexOf("## Reviewer notes"),
      markdown.indexOf("## Evidence"),
    );
    expect(section).toBe(
      [
        "## Reviewer notes",
        "",
        "Notes a person added while reviewing the recording. They are not participant feedback.",
        "",
        "- 00:12, sim-01-ui, you: The menu was hidden.",
        "  They scrolled past it.",
        "- 02:31, whole run, you: The whole page went blank.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("leaves the notes out of a draft when the run has none", async () => {
    const cwd = await makeTestTempDir("humanish-notes-feedback-");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runSyntheticLive({ cwd, dryRun: true, runId: RUN });

    const rendered = await renderIssueMarkdown(cwd, RUN, "example/app");

    expect(rendered.draft?.reviewer_notes).toBeUndefined();
    expect(rendered.issueMarkdown).not.toContain("## Reviewer notes");
  });
});
