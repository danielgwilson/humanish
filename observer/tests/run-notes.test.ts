// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { readInlineRunNotes, saveRunNote, RUN_NOTES_PLACEHOLDER } from "../lib/run-notes";

const RUN = "noted-run";
const TOKEN = "t".repeat(43);
const note = {
  id: "note-one",
  atMs: 4500,
  participant: null,
  nearest: null,
  text: "The menu was hidden.",
  author: "you",
  createdAt: "2026-05-01T10:00:00.000Z",
  editedAt: null,
};

function page(slot: unknown): Document {
  const doc = document.implementation.createHTMLDocument("observer");
  const script = doc.createElement("script");
  script.id = "run-notes";
  script.type = "application/json";
  script.textContent = typeof slot === "string" ? slot : JSON.stringify(slot);
  doc.body.appendChild(script);
  return doc;
}

describe("reading the run-notes slot", () => {
  it("reads the run's notes and the token a loopback server put in the page", () => {
    const slot = {
      notes: { schema: "humanish.run-notes.v1", runId: RUN, notes: [note] },
      write: { token: TOKEN },
    };

    expect(readInlineRunNotes(page(slot), RUN)).toEqual({
      notes: [note],
      token: TOKEN,
      unreadable: false,
    });
  });

  it("reads nothing from an unfilled slot, a page without one, or another run's notes", () => {
    const other = {
      notes: { schema: "humanish.run-notes.v1", runId: "other", notes: [note] },
      write: null,
    };

    for (const doc of [
      page(RUN_NOTES_PLACEHOLDER),
      document.implementation.createHTMLDocument(),
      page(other),
    ])
      expect(readInlineRunNotes(doc, RUN)).toEqual({ notes: [], token: null, unreadable: false });
  });

  it("says when a slot's notes cannot be read and drops a malformed token", () => {
    const malformed = {
      notes: { schema: "humanish.run-notes.v1", runId: RUN, notes: [{ ...note, atMs: -1 }] },
      write: { token: "short" },
    };

    expect(readInlineRunNotes(page(malformed), RUN)).toEqual({
      notes: [],
      token: null,
      unreadable: true,
    });
    expect(readInlineRunNotes(page("{ not json"), RUN).unreadable).toBe(true);
  });
});

describe("saving a note", () => {
  it("posts the note with the token and returns the run's notes", async () => {
    const saved = { schema: "humanish.run-notes.v1", runId: RUN, notes: [note] };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, note, notes: saved, scrubbed: false }), {
          status: 201,
        }),
    );

    const result = await saveRunNote(fetchImpl, TOKEN, {
      runId: RUN,
      atMs: 4500,
      participant: null,
      text: "The menu was hidden.",
    });

    expect(result).toEqual({ ok: true, notes: [note], scrubbed: false });
    expect(fetchImpl).toHaveBeenCalledWith("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-humanish-notes-token": TOKEN },
      body: JSON.stringify({
        runId: RUN,
        atMs: 4500,
        participant: null,
        text: "The menu was hidden.",
      }),
    });
  });

  it("returns the server's message when it refuses, and a plain one when it cannot be reached", async () => {
    const refused = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "HUMANISH_NOTES_TOKEN", message: "Reload the page." },
          }),
          { status: 403 },
        ),
    );
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const input = { runId: RUN, atMs: 0, participant: null, text: "x" };

    expect(await saveRunNote(refused, TOKEN, input)).toEqual({
      ok: false,
      message: "Reload the page.",
    });
    expect(await saveRunNote(offline, TOKEN, input)).toEqual({
      ok: false,
      message: expect.stringContaining("could not reach"),
    });
  });
});
