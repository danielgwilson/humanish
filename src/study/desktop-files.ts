// Files a participant's hosted desktop receives before it starts (`participants[].files`), so a
// browser upload dialog can find them. The parser checks the declared paths; readDesktopFiles reads
// the files from the study's folder on this machine before any sandbox exists.

import { scanEncodedText } from "../evidence/encoded-text.js";
import { isRecord } from "../run/type-guards.js";
import { invalid, str } from "./parse/values.js";
import type { StudyParseFailure, StudyParticipantFile } from "./types.js";

/**
 * Where `participants[].files` act: the hosted desktop of an independent computer-use participant.
 * The parser's unread-field check and the route planners give this reason.
 */
export const DESKTOP_FILES_ROUTE_REASON =
  "files are copied onto a hosted computer-use desktop; needs route: computer-use with execution.target: e2b-desktop";

/** The most files one participant's desktop receives. */
const MAX_FILES = 20;

/** A participant's `files` list: each entry's `from` and `as`. */
export function parseParticipantFiles(
  raw: unknown,
  field: string,
): { ok: true; value: StudyParticipantFile[] | undefined } | StudyParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  const listReason = `\`${field}\` must be a list of 1 to ${MAX_FILES} { from, as } entries, one per file the participant's desktop receives.`;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES) return invalid(listReason);
  const files: StudyParticipantFile[] = [];
  for (const [index, entry] of raw.entries()) {
    const at = `${field}[${index}]`;
    const from = isRecord(entry) ? str(entry.from) : undefined;
    const as = isRecord(entry) ? str(entry.as) : undefined;
    if (from === undefined || as === undefined) return invalid(listReason);
    if (!isPlainRelativePath(from))
      return invalid(
        `\`${at}.from\` must be a path inside the folder that holds the study file, written relative to it, such as fixtures/insurance-card.png, with / between folders and no empty, . or .. part.`,
      );
    if (!isPlainRelativePath(as) || as.startsWith("~"))
      return invalid(
        `\`${at}.as\` must be a path relative to the desktop user's home folder, such as Downloads/insurance-card.png, with / between folders, no empty, . or .. part, and no leading ~.`,
      );
    // The run records `as`, and redacting it would record a different path.
    if (scanEncodedText(as).sensitive)
      return invalid(
        `\`${at}.as\` looks like a secret or a local path, and the run records it. Name the file plainly, such as Downloads/insurance-card.png.`,
      );
    const clash = files.find(
      (earlier) =>
        earlier.as === as || as.startsWith(`${earlier.as}/`) || earlier.as.startsWith(`${as}/`),
    );
    if (clash !== undefined)
      return invalid(
        clash.as === as
          ? `\`${at}.as\` names ${as}, which another file in this list already uses. Give each file its own path.`
          : `\`${at}.as\` names ${as}, and another file in this list uses ${clash.as}, so one would have to be both a file and a folder. Give each file its own path.`,
      );
    files.push({ from, as });
  }
  return { ok: true, value: files };
}

/**
 * A relative path of plain names joined by `/`. A backslash is refused because the desktop is
 * Linux, where it is part of a name, and on Windows it would be a separator.
 */
function isPlainRelativePath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
