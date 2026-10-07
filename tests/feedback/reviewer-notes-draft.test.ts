// A feedback draft carries the run's reviewer notes, labelled as notes a person added while
// reviewing, apart from what participants said.
import { cp } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { draftFeedback, renderIssueMarkdown, verifyFeedback } from "../../src/feedback/feedback.js";
import { noteId, writeNoteFile } from "../helpers/note-files.js";
import { runSyntheticLive } from "../helpers/synthetic-live-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "noted-feedback-run";

const EARLY = noteId(2);
const LATE = noteId(1);

async function notedLiveRun(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-notes-feedback-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runSyntheticLive({ cwd, dryRun: true, runId: RUN });
  const runDir = path.join(cwd, ".humanish", "runs", RUN);
  await writeNoteFile(runDir, RUN, { id: LATE, atMs: 151_000, text: "The whole page went blank." });
  await writeNoteFile(runDir, RUN, {
    id: EARLY,
    atMs: 12_000,
    participant: "sim-01-ui",
    text: "The menu was hidden.\nThey scrolled past it.",
  });
  return cwd;
}

describe("reviewer notes in feedback drafts", () => {
  it("lists the notes in run clock order and cites each note's file", async () => {
    const cwd = await notedLiveRun();

    const drafted = await draftFeedback(cwd, RUN);

    expect(drafted.ok).toBe(true);
    expect(drafted.draft?.reviewer_notes).toEqual([
      {
        id: EARLY,
        at: "00:12",
        at_ms: 12_000,
        participant: "sim-01-ui",
        participant_caption: "UI journey",
        author: "you",
        text: "The menu was hidden.\nThey scrolled past it.",
      },
      {
        id: LATE,
        at: "02:31",
        at_ms: 151_000,
        participant: null,
        participant_caption: null,
        author: "you",
        text: "The whole page went blank.",
      },
    ]);
    expect(drafted.draft?.evidence.map((item) => path.basename(item.path))).toEqual(
      expect.arrayContaining([`${EARLY}.json`, `${LATE}.json`]),
    );
    expect((await verifyFeedback(cwd, RUN)).ok).toBe(true);
  });

  it("renders the notes under their own heading, naming participants by caption", async () => {
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
        "- 00:12, UI journey, you: The menu was hidden.",
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
