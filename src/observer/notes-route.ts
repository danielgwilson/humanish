// POST /api/notes, the one write an Observer server accepts: a reviewer note on a run it serves.
// A server takes it only while it listens on loopback and is not exposed, with the token it put in
// the page it rendered, and from that page's own origin. Every other request is refused before its
// body is read past 16 KiB. A page from another site can send a POST to a loopback port, but it
// cannot read the token from the page or send this origin, and a name rebound to 127.0.0.1 arrives
// with its own Host.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  addRunNote,
  MAX_NOTE_TEXT,
  type RunNoteErrorCode,
  type RunNoteInput,
} from "../run/notes.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { isRecord } from "../run/type-guards.js";
import { hostAllowed } from "./http.js";

export const NOTES_PATH = "/api/notes";
const TOKEN_HEADER = "x-humanish-notes-token";
const MAX_BODY_BYTES = 16 * 1024;

type NotesRefusalCode =
  | RunNoteErrorCode
  | "HUMANISH_RUN_NOT_FOUND"
  | "HUMANISH_NOTES_METHOD"
  | "HUMANISH_NOTES_EXPOSED"
  | "HUMANISH_NOTES_ORIGIN"
  | "HUMANISH_NOTES_TOKEN"
  | "HUMANISH_NOTES_BODY"
  | "HUMANISH_NOTES_TOO_LARGE";

/** The HTTP status for a refusal from the notes store. */
const STORE_STATUS: Record<RunNoteErrorCode, number> = {
  HUMANISH_NOTE_INVALID: 400,
  HUMANISH_NOTE_UNKNOWN_PARTICIPANT: 400,
  HUMANISH_NOTE_OUTSIDE_RUN: 400,
  HUMANISH_NOTE_NO_CLOCK: 409,
  HUMANISH_INVALID_RUN_BUNDLE: 409,
  HUMANISH_NOTES_UNREADABLE: 409,
  HUMANISH_NOTES_FULL: 409,
  HUMANISH_NOTES_BUSY: 409,
};

export interface NotesWriterOptions {
  /** An exposed server refuses every note and gives its pages no token. */
  exposed: boolean;
  /** The port the server listens on, once it does. */
  port(): number;
  /** The run's paths when this server serves it, otherwise null. */
  resolveRun(runId: string): Promise<PreparedRunArtifactPaths | null>;
  /** Renders the run's saved Observer page again after a note is added. */
  refresh(prepared: PreparedRunArtifactPaths): Promise<unknown>;
}

export interface NotesWriter {
  /** The token for a page this server renders for `request`, or undefined when it takes no notes. */
  pageToken(request: Pick<IncomingMessage, "headers">): string | undefined;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Resolves once every saved page a note started rendering again is written. */
  settled(): Promise<void>;
}

/** The Host values a loopback page uses for this port. */
function loopbackHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function reply(response: ServerResponse, status: number, body: unknown, close = false): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(status === 405 ? { allow: "POST" } : {}),
    // A refused request's body is never read, so the connection cannot carry another request.
    ...(close ? { connection: "close" } : {}),
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function refuse(
  response: ServerResponse,
  status: number,
  code: NotesRefusalCode,
  message: string,
): void {
  reply(response, status, { ok: false, error: { code, message } }, true);
}

/** The body, or null once it passes MAX_BODY_BYTES; reading stops there. */
function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.off("data", onData);
        request.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function sameToken(sent: string | string[] | undefined, token: string): boolean {
  if (typeof sent !== "string") return false;
  const left = Buffer.from(sent);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The note in a request body, or null when the body is not one. */
function noteInput(body: Buffer): (RunNoteInput & { runId: string }) | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.atMs !== "number" ||
    typeof value.text !== "string" ||
    !(
      value.participant === undefined ||
      value.participant === null ||
      typeof value.participant === "string"
    )
  )
    return null;
  return {
    runId: value.runId,
    atMs: value.atMs,
    participant: typeof value.participant === "string" ? value.participant : null,
    text: value.text,
  };
}

export function createNotesWriter(options: NotesWriterOptions): NotesWriter {
  const token = randomBytes(32).toString("base64url");
  // Renders run one after another, so an older render cannot overwrite a newer one.
  let refreshes: Promise<void> = Promise.resolve();

  return {
    pageToken(request) {
      return !options.exposed && hostAllowed(request.headers.host, loopbackHosts(options.port()))
        ? token
        : undefined;
    },

    async handle(request, response) {
      if (request.method !== "POST")
        return refuse(response, 405, "HUMANISH_NOTES_METHOD", "Notes are added with POST.");
      if (options.exposed)
        return refuse(
          response,
          403,
          "HUMANISH_NOTES_EXPOSED",
          "This Observer is shared beyond this machine, so it does not take notes. Add notes from an Observer served on 127.0.0.1, or with `humanish notes <run> --add`.",
        );
      const host = request.headers.host?.trim().toLowerCase();
      if (
        host === undefined ||
        !hostAllowed(host, loopbackHosts(options.port())) ||
        request.headers.origin !== `http://${host}`
      )
        return refuse(
          response,
          403,
          "HUMANISH_NOTES_ORIGIN",
          "A note can only come from the Observer page this server rendered, at the address it was opened from. Open the Observer from the address humanish printed and add the note there.",
        );
      if (!sameToken(request.headers[TOKEN_HEADER], token))
        return refuse(
          response,
          403,
          "HUMANISH_NOTES_TOKEN",
          "The request does not carry this server's note token, which changes each time the server starts. Reload the Observer page and add the note again.",
        );
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
        return refuse(
          response,
          415,
          "HUMANISH_NOTES_BODY",
          "A note is sent as JSON with runId, atMs, participant and text.",
        );
      const tooLarge = (): void =>
        refuse(
          response,
          413,
          "HUMANISH_NOTES_TOO_LARGE",
          `The request is larger than ${MAX_BODY_BYTES / 1024} KiB. A note holds at most ${MAX_NOTE_TEXT} characters.`,
        );
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return tooLarge();
      const body = await readBody(request);
      if (body === null) return tooLarge();

      const input = noteInput(body);
      if (input === null)
        return refuse(
          response,
          400,
          "HUMANISH_NOTES_BODY",
          "A note is a JSON object with runId, atMs (milliseconds on the run clock), participant (a stream id or null) and text.",
        );
      const prepared = await options.resolveRun(input.runId).catch(() => null);
      if (prepared === null)
        return refuse(
          response,
          404,
          "HUMANISH_RUN_NOT_FOUND",
          "This server does not serve that run, so it cannot take a note for it.",
        );
      const added = await addRunNote(prepared, input);
      if (!added.ok)
        return refuse(
          response,
          STORE_STATUS[added.error.code],
          added.error.code,
          added.error.message,
        );
      reply(response, 201, added);
      refreshes = refreshes.then(() =>
        options.refresh(prepared).then(
          () => undefined,
          () => undefined,
        ),
      );
    },

    settled() {
      return refreshes;
    },
  };
}
