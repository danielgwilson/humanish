import { useCallback, useState } from "react";
import { isServedOrigin } from "./live";
import {
  NO_RUN_NOTES,
  saveRunNote,
  type RunNote,
  type RunNotesState,
  type SaveRunNoteResult,
} from "./run-notes";

/**
 * The shown run's reviewer notes, and `save` when the page can add one: a page a loopback server
 * rendered with its token, never a snapshot or a file opened from disk.
 */
export function useRunNotes(
  initial: RunNotesState | undefined,
  runId: string | undefined,
  snapshot: boolean,
): {
  notes: RunNote[];
  unreadable: boolean;
  save?: (note: {
    atMs: number;
    participant: string | null;
    text: string;
  }) => Promise<SaveRunNoteResult>;
} {
  const [state, setState] = useState(() => ({
    runId: runId ?? "",
    ...(initial ?? NO_RUN_NOTES),
  }));
  // The slot holds the notes of the run the page was rendered for, not of a run opened later.
  const current = state.runId === runId ? state : { runId: runId ?? "", ...NO_RUN_NOTES };
  const token = !snapshot && isServedOrigin(window.location.protocol) ? current.token : null;
  const save = useCallback(
    async (note: { atMs: number; participant: string | null; text: string }) => {
      if (token === null || runId === undefined)
        return { ok: false as const, message: "This page cannot save notes." };
      const saved = await saveRunNote((input, init) => window.fetch(input, init), token, {
        runId,
        atMs: Math.round(note.atMs),
        participant: note.participant,
        text: note.text,
      });
      if (saved.ok) setState((value) => ({ ...value, runId, notes: saved.notes }));
      return saved;
    },
    [token, runId],
  );
  return {
    notes: current.notes,
    unreadable: current.unreadable,
    ...(token === null ? {} : { save }),
  };
}
