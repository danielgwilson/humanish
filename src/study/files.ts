// Where study files live. Discovery reads the three studies/ directories, and looks in the three
// labs/ directories they replace only to refuse a file there with its fix. migrate reads all six.
// Every writer checks a name against all six before it writes, so a new file never shadows another
// study or takes the name migrate needs to move a labs/ file.

import path from "node:path";

/** One directory discovery reads study files from. */
export interface StudyDirectory {
  readonly relativeDir: string;
  /** `committed` is the project's own directory; `ignored` ones are gitignored overlays. */
  readonly origin: "committed" | "ignored";
  /** `labs` is the directory a `studies/` one replaces. */
  readonly family: "studies" | "labs";
}

/** The six directories, in resolution order. */
export const STUDY_DIRECTORIES: readonly StudyDirectory[] = [
  { relativeDir: path.join("humanish", "studies"), origin: "committed", family: "studies" },
  { relativeDir: path.join(".humanish", "studies"), origin: "ignored", family: "studies" },
  { relativeDir: path.join(".humanish", "local", "studies"), origin: "ignored", family: "studies" },
  { relativeDir: path.join("humanish", "labs"), origin: "committed", family: "labs" },
  { relativeDir: path.join(".humanish", "labs"), origin: "ignored", family: "labs" },
  { relativeDir: path.join(".humanish", "local", "labs"), origin: "ignored", family: "labs" },
];

/** A study file's extensions, `.yaml` first. */
const STUDY_EXTENSIONS = [".yaml", ".yml"] as const;

/** One path a study named by its stem can have. */
export interface StudyFileCandidate {
  readonly relativePath: string;
  readonly directory: StudyDirectory;
}

/** Every path a study with this stem can have, in resolution order. */
export function studyFileCandidates(stem: string): StudyFileCandidate[] {
  return STUDY_DIRECTORIES.flatMap((directory) =>
    STUDY_EXTENSIONS.map((extension) => ({
      relativePath: path.join(directory.relativeDir, `${stem}${extension}`),
      directory,
    })),
  );
}

/** A file name's stem when it is a study file name, else undefined. */
export function studyFileStem(name: string): string | undefined {
  const extension = STUDY_EXTENSIONS.find((candidate) => name.endsWith(candidate));
  return extension === undefined ? undefined : name.slice(0, -extension.length);
}

/**
 * The files that already use `stem` in any of the six directories, other than `except`, which is
 * the file the writer is about to replace. `exists` reads through the writer's own contained
 * filesystem checks. A writer skips or refuses when the result is not empty, so no write leaves
 * two files for one study name.
 */
export async function otherStudyFiles(
  stem: string,
  exists: (relativePath: string) => Promise<boolean>,
  except?: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of studyFileCandidates(stem)) {
    if (except !== undefined && path.normalize(candidate.relativePath) === path.normalize(except))
      continue;
    if (await exists(candidate.relativePath)) found.push(candidate.relativePath);
  }
  return found;
}
