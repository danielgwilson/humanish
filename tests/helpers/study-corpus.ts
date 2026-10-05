// The study files the StudyConfig pins read: the committed studies, every starter set `humanish
// init` can write, and `humanish study show --json` run in process. The pins in
// tests/study/plan-lab.test.ts, tests/study/summaries.test.ts and
// tests/surface/study-show-roundtrip.test.ts read the same corpus through these.
import { CommanderError, type Command } from "commander";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createProgram } from "../../src/cli/program.js";
import type { StudyInspectResult } from "../../src/study/discover.js";
import {
  DEFAULT_LOCAL_BROWSER_STARTER,
  starterFilesFor,
  type StarterFile,
} from "../../src/study/init-templates.js";

/** Each starter set init can write. The brain init picks decides try-live's actor. */
export const STARTER_VARIANTS: readonly { readonly name: string; readonly files: StarterFile[] }[] =
  [
    { name: "openai-computer-use", files: starterFilesFor("openai-computer-use") },
    {
      name: "local-agent codex",
      files: starterFilesFor("local-agent", DEFAULT_LOCAL_BROWSER_STARTER, "codex"),
    },
    {
      name: "local-agent claude",
      files: starterFilesFor("local-agent", DEFAULT_LOCAL_BROWSER_STARTER, "claude"),
    },
  ];

const STUDY_FILE = /^humanish\/studies\/[^/]+\.yaml$/;

/** The study files of one starter set, sorted by path. */
export function starterStudies(files: readonly StarterFile[]): StarterFile[] {
  return files
    .filter((file) => STUDY_FILE.test(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Write a starter set into `dir`, as init does. */
export async function writeStarterProject(
  dir: string,
  files: readonly StarterFile[],
): Promise<void> {
  for (const file of files) {
    const target = path.join(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }
}

/** The committed study files under `root`, as project-relative paths sorted by name. */
export async function committedStudyPaths(root: string): Promise<string[]> {
  const dir = path.posix.join("humanish", "studies");
  return (await readdir(path.join(root, dir)))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => path.posix.join(dir, name));
}

/**
 * Copy the committed studies and personas from `root` into `dir`. Persona ids with no committed
 * file fall back to .humanish/local/personas, so reading a copy keeps a developer's local files out
 * of the result.
 */
export async function copyCommittedProject(root: string, dir: string): Promise<void> {
  for (const sub of ["studies", "personas"]) {
    const from = path.join(root, "humanish", sub);
    const to = path.join(dir, "humanish", sub);
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (/\.ya?ml$/.test(name)) await copyFile(path.join(from, name), path.join(to, name));
    }
  }
}

/** `humanish study show <study> --cwd <cwd> --json`, run in process. */
export async function studyShowJson(
  cwd: string,
  study: string,
): Promise<{ exitCode: number; json: StudyInspectResult }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", "study", "show", study, "--cwd", cwd, "--json"], {
      from: "node",
    });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, json: JSON.parse(stdout.join("")) as StudyInspectResult };
}
