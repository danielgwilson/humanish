import { useState, type FormEvent } from "react";
import type { RunNote, SaveRunNoteResult } from "@/lib/run-notes";
import { ReviewIcon } from "./review-icon";
import { Popover } from "./ui/popover";
import "@/styles/reviewer-notes.css";
// note-shape.ts and run-clock.ts have no runtime imports, so the artifact stays self-contained
// (observer/tests/contract-lock.test.ts).
import { byRunTime, MAX_NOTE_TEXT } from "../../src/run/note-shape.js";
import { formatRunTime } from "../../src/run/run-clock.js";

/**
 * "Add a note at 02:31": a form for a note at the paused moment of the study timeline, for the
 * open participant or the whole study.
 */
export function AddNote({
  atMs,
  participant,
  onSave,
}: {
  atMs: number;
  /** The open participant's label, or null for a note on the whole study. */
  participant: string | null;
  onSave: (atMs: number, text: string) => Promise<SaveRunNoteResult>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const at = formatRunTime(atMs);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    const saved = await onSave(atMs, text);
    setSaving(false);
    if (saved.ok) {
      setText("");
      setMessage(
        `Note saved at ${at}.${saved.scrubbed ? " Text that looked like a secret or a local path was replaced." : ""}`,
      );
    } else setMessage(saved.message);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMessage("");
      }}
      triggerClassName="add-note"
      label={`Add a note at ${at}`}
      trigger={
        <>
          <ReviewIcon name="note" />
          <span className="add-note-text">Add a note at {at}</span>
        </>
      }
    >
      <form className="note-form" onSubmit={(event) => void submit(event)}>
        <p>
          {participant === null ? "For the whole study" : `For ${participant}`}, at {at} on the
          study timeline. The note is saved with this run and shown as a reviewer note, apart from
          what participants said.
        </p>
        <label>
          <span>Note</span>
          <textarea
            name="note"
            rows={4}
            maxLength={MAX_NOTE_TEXT}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" className="review-tool" disabled={saving || !text.trim()}>
          {saving ? "Saving…" : "Save note"}
        </button>
        <output>{message}</output>
      </form>
    </Popover>
  );
}

/**
 * A mark on the study timeline at each note's time. It sits on the track, which assistive
 * technology does not read; the list of notes is the accessible way to reach them.
 */
export function NoteMarkers({
  notes,
  durationMs,
}: {
  notes: readonly RunNote[];
  durationMs: number;
}) {
  return byRunTime(notes).map((note) => (
    <span
      key={note.id}
      className="scrub-note"
      title={`Reviewer note at ${formatRunTime(note.atMs)}`}
      style={{
        left: `${durationMs ? (Math.min(note.atMs, durationMs) / durationMs) * 100 : 0}%`,
      }}
    />
  ));
}

/** The run's reviewer notes in run clock order, each marked as written by a person. */
export function ReviewerNotes({
  notes,
  labels,
  unreadable,
  writable,
  onOpen,
}: {
  notes: readonly RunNote[];
  labels: Map<string, string>;
  unreadable: boolean;
  writable: boolean;
  onOpen: (note: RunNote) => void;
}) {
  return (
    <section className="reviewer-notes" aria-labelledby="reviewer-notes-heading">
      <h2 id="reviewer-notes-heading">
        Reviewer notes <span>{notes.length}</span>
      </h2>
      <p className="reviewer-notes-intro">
        Written by a person reviewing this run. They are not participant feedback or analysis
        findings.
      </p>
      {unreadable ? (
        <output>
          Some of this run&apos;s note files could not be read. <code>humanish notes</code> names
          them.
        </output>
      ) : null}
      {notes.length === 0 ? (
        <p>
          {writable
            ? "No notes yet. Pause the study timeline and choose Add a note."
            : "No notes on this run."}
        </p>
      ) : (
        <ol>
          {byRunTime(notes).map((note) => (
            <li key={note.id} data-note={note.id}>
              <div className="reviewer-note-head">
                <button
                  type="button"
                  className="review-tool"
                  aria-label={`Open ${formatRunTime(note.atMs)} on the study timeline`}
                  onClick={() => onOpen(note)}
                >
                  {formatRunTime(note.atMs)}
                </button>
                <span>
                  {note.participant === null
                    ? "Whole study"
                    : (labels.get(note.participant) ?? note.participant)}
                </span>
                <span className="reviewer-note-author">
                  <span className="reviewer-note-human">Human</span> {note.author}
                </span>
              </div>
              <p className="reviewer-note-text">{note.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
