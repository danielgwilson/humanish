// Files a participant's hosted desktop receives before it starts (`participants[].files`), so a
// browser upload dialog can find them. The parser checks the declared paths; readDesktopFiles reads
// the files from the study's folder on this machine before any sandbox exists.

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { scanEncodedText } from "../evidence/encoded-text.js";
import {
  type ContainedRead,
  type PreparedSelectedOutputDirectory,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
} from "../run/contained-output.js";
import { isRecord } from "../run/type-guards.js";
import { isLocalTreeDenylisted } from "../subject/local-tree-archive.js";
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
    if (isLocalTreeDenylisted(from))
      return invalid(
        `\`${at}.from\` names a file humanish keeps on this machine: a .env file, a key, a credential file, or one under .git, node_modules or .humanish. The local-tree archive leaves the same files out. Copy a synthetic file instead.`,
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

/** One file read on this machine for a participant's desktop. */
export interface DesktopFile {
  /** Where it lands, relative to the desktop user's home folder. */
  readonly as: string;
  readonly bytes: Buffer;
  readonly size: number;
  /** The sha256 of `bytes`, 64 hex characters. */
  readonly sha256: string;
}

const MIB = 1024 * 1024;

/** The most bytes humanish copies for one file. */
const FILE_MAX_BYTES = 10 * MIB;

/** The most bytes one participant's desktop receives, a file counted each time it is placed. */
const PARTICIPANT_MAX_BYTES = 25 * MIB;

/** The most bytes of distinct files a study names: humanish holds them in memory for the run. */
const STUDY_MAX_BYTES = 100 * MIB;

type DesktopFilesRead =
  | { readonly ok: true; readonly files: ReadonlyMap<string, readonly DesktopFile[]> }
  | { readonly ok: false; readonly message: string };

/**
 * Read every participant's declared files from `folder`, the folder that holds the study file, and
 * return them by participant id. Runs before any sandbox exists, so a refusal costs nothing.
 */
export async function readDesktopFiles(
  folder: string,
  participants: readonly {
    readonly id: string;
    readonly files?: readonly StudyParticipantFile[];
  }[],
): Promise<DesktopFilesRead> {
  // A library caller's config skips the parser, so its rules run again here.
  for (const participant of participants) {
    const checked = parseParticipantFiles(
      participant.files,
      `Participant ${participant.id}'s files`,
    );
    if (!checked.ok) return { ok: false, message: checked.error.message };
  }
  const files = new Map<string, DesktopFile[]>();
  if (!participants.some((participant) => participant.files !== undefined))
    return { ok: true, files };
  const root = await bindFolder(folder);
  if (root === undefined)
    return {
      ok: false,
      message:
        "The folder that holds the study file could not be read as a folder, so its participants' files cannot be copied. Run the study from its file, with the folder in place.",
    };
  // One read per distinct `from`: a group of participants shares one file's bytes.
  const sources = new Map<string, Omit<DesktopFile, "as">>();
  let studyBytes = 0;
  for (const participant of participants) {
    const placed: DesktopFile[] = [];
    let participantBytes = 0;
    for (const [index, file] of (participant.files ?? []).entries()) {
      let source = sources.get(file.from);
      if (source === undefined) {
        const read = await readContainedRegularFile(root, file.from, FILE_MAX_BYTES);
        if (read.status !== "read")
          return {
            ok: false,
            message: `Participant ${participant.id}'s files[${index}].from, ${file.from}, ${unreadReason(read)}. Paths in from are relative to the folder that holds the study file.`,
          };
        const sha256 = createHash("sha256").update(read.bytes).digest("hex");
        source = { bytes: read.bytes, size: read.bytes.length, sha256 };
        sources.set(file.from, source);
        studyBytes += source.size;
        if (studyBytes > STUDY_MAX_BYTES)
          return {
            ok: false,
            message: `The files this study's participants receive total more than ${STUDY_MAX_BYTES / MIB} MiB, the most humanish holds in memory for one run. Use smaller files, or give more participants the same file.`,
          };
      }
      participantBytes += source.size;
      if (participantBytes > PARTICIPANT_MAX_BYTES)
        return {
          ok: false,
          message: `Participant ${participant.id}'s files total more than ${PARTICIPANT_MAX_BYTES / MIB} MiB, the most humanish copies onto one desktop. Use smaller or fewer files.`,
        };
      placed.push({ as: file.as, ...source });
    }
    if (placed.length > 0) files.set(participant.id, placed);
  }
  return { ok: true, files };
}

/**
 * The study's folder as a contained-read root, or undefined when it is not an existing folder.
 * prepareSelectedOutputDirectory would create a missing one.
 */
async function bindFolder(folder: string): Promise<PreparedSelectedOutputDirectory | undefined> {
  try {
    if (!(await stat(folder)).isDirectory()) return undefined;
    return await prepareSelectedOutputDirectory(folder, folder);
  } catch {
    return undefined;
  }
}

/** Why a `from` could not be read, as a clause after its path. */
function unreadReason(read: Exclude<ContainedRead, { status: "read" }>): string {
  if (read.status === "missing") return "does not exist in the folder that holds the study file";
  switch (read.reason) {
    case "too-large":
      return `is larger than ${FILE_MAX_BYTES / MIB} MiB, the most humanish copies for one file`;
    case "directory":
      return "is a folder; name a file";
    case "not-regular":
      return "is a symbolic link, a hard link or another kind of file humanish does not copy; put a plain copy of the file in the folder";
    case "unsafe-path":
      return "leaves the folder that holds the study file or passes through a symbolic link; put a plain copy of the file in the folder";
    case "changed":
      return "changed while humanish read it; run the study again";
    case "unreadable":
      return "could not be read; check its permissions";
  }
}
