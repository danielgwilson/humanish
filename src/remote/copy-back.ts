// Copying a remote run's evidence from its runner to this machine: while the run goes on, what has
// settled, and when it ends, everything else, each file checked against the runner's digest.
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { sha256OfOpenedFile } from "../observer/pinned-files.js";
import {
  openContainedRegularFile,
  prepareContainedOutputFile,
  readContainedRegularFile,
  removeContainedOutputFile,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { pointLatestRunAt } from "../run/run.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../run/sandbox-receipts.js";
import {
  COPY_BATCH_BYTES,
  listRemoteRun,
  listSettledEvidence,
  readRemoteBytes,
  readRemoteFileInRanges,
  readRemoteFiles,
  type RemoteFile,
  type Runner,
} from "./runner.js";

/** How long a screenshot or recording must be unchanged before it is copied mid-run. */
const SETTLED_SECONDS = 10;

/**
 * Copy every file of the runner's run directory into this machine's run directory, each checked
 * against the digest the runner listed. The sandbox journal keeps this machine's lines (the
 * runner's own receipt) and adds the runner's (its participants'). A file copied while the run went
 * on that the runner no longer has, a frame's PNG replaced by its WebP, is removed here too.
 */
export async function copyRunBack(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  copiedWhileRunning: ReadonlyMap<string, number>,
  say: (line: string) => void,
): Promise<{ files: number; alreadyHere: number }> {
  const files = await listRemoteRun(runner, runId);
  let alreadyHere = 0;
  const wanted: RemoteFile[] = [];
  for (const file of files) {
    if (file.path === "owner-key") continue;
    // Already here with the same bytes, copied while the run went on or by an earlier attempt.
    if (file.path !== SANDBOX_RECEIPTS_ARTIFACT && (await localDigest(paths, file)) === file.sha256)
      alreadyHere += 1;
    else wanted.push(file);
  }
  const copiedInRanges = (file: RemoteFile) =>
    file.size > COPY_BATCH_BYTES && file.path !== SANDBOX_RECEIPTS_ARTIFACT;
  await readRemoteFiles(
    runner,
    runId,
    wanted.filter((file) => !copiedInRanges(file)),
    async (file, bytes) => {
      if (file.path !== SANDBOX_RECEIPTS_ARTIFACT)
        return await writeContainedOutputFile(paths, file.path, bytes);
      const local = await readContainedRegularFile(paths, file.path, 16 * 1024 * 1024);
      const mine = local.status === "read" ? Buffer.from(local.bytes).toString("utf8") : "";
      await writeContainedOutputFile(
        paths,
        file.path,
        joinJournals(mine, Buffer.from(bytes).toString("utf8")),
        "utf8",
      );
    },
  );
  for (const file of wanted.filter(copiedInRanges)) {
    say(`Copying ${file.path} (${Math.ceil(file.size / 1024 ** 2)} MiB) from the runner.`);
    await saveInRanges(runner, paths, runId, file);
  }
  const listed = new Set(files.map((file) => file.path));
  for (const file of copiedWhileRunning.keys())
    if (!listed.has(file)) await removeContainedOutputFile(paths, file);
  await pointLatestRunAt(paths, runId);
  return { files: files.length, alreadyHere };
}

/** Writes a large file beside its destination and renames it once its whole digest has matched. */
async function saveInRanges(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  file: RemoteFile,
): Promise<void> {
  const target = await prepareContainedOutputFile(paths, file.path);
  const temporary = await prepareContainedOutputFile(
    paths,
    path.posix.join(path.posix.dirname(file.path), `.copy-${randomUUID()}`),
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await readRemoteFileInRanges(runner, runId, file, (range) => handle.appendFile(range));
    await handle.close();
    if ((await prepareContainedOutputFile(paths, file.path)) !== target)
      throw new Error(`${file.path} changed on this machine while it was copied.`);
    await rename(temporary, target);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Copy the run's screenshots and recordings that have settled and are not here yet, while the run
 * goes on, so the copy at its end is only what is left. Each file the runner sends is an answer, so
 * a long catch-up after a sleep does not count against it. A file too large to read at once waits
 * for the end of the run, since copying it here would hold up following the run for minutes.
 */
export async function copySettledEvidence(
  runner: Runner,
  paths: PreparedRunArtifactPaths,
  runId: string,
  copied: Map<string, number>,
  answered: () => void,
): Promise<void> {
  const settled = await listSettledEvidence(runner, runId, SETTLED_SECONDS);
  answered();
  for (const file of settled) {
    if (copied.get(file.path) === file.size || file.size > COPY_BATCH_BYTES) continue;
    const bytes = await readRemoteBytes(runner, runId, file.path);
    answered();
    await writeContainedOutputFile(paths, file.path, bytes);
    copied.set(file.path, file.size);
  }
}

/** This machine's copy's sha256; a copy of another size is known to differ without reading it. */
async function localDigest(
  paths: PreparedRunArtifactPaths,
  file: RemoteFile,
): Promise<string | undefined> {
  const handle = await openContainedRegularFile(paths, file.path);
  if (handle === null) return undefined;
  try {
    return (await handle.stat()).size === file.size ? await sha256OfOpenedFile(handle) : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Two sandbox journals as one: every line of each, in order, once. A copy that runs again adds
 * nothing it already added.
 */
export function joinJournals(...journals: string[]): string {
  const lines = [
    ...new Set(
      journals.flatMap((journal) => journal.split("\n")).filter((line) => line.trim() !== ""),
    ),
  ];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
