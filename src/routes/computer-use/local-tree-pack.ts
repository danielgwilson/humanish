// Packing the project's working tree once per local-tree run, on the host, for every participant to upload.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { LabConfig } from "../../lab/types.js";
import { createLocalTreeArchive, type LocalTreeArchive } from "../../subject/local-tree-archive.js";
import type { LabDeps } from "../../lab/lab-deps.js";

/**
 * Pack the working tree for a local-tree run and report what left the host on stderr, by counts
 * and digest only, never paths or file names.
 */
export async function packRunLocalTree(
  deps: LabDeps,
  config: { readonly subject: Pick<LabConfig["subject"], "localTree"> },
  cwd: string,
): Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }> {
  const packLocalTree = deps.packLocalTree ?? defaultPackLocalTree;
  const packed = await packLocalTree({
    root: cwd,
    ...(config.subject.localTree?.exclude === undefined
      ? {}
      : { extraExclude: config.subject.localTree.exclude }),
    ...(config.subject.localTree?.maxArchiveBytes === undefined
      ? {}
      : { maxArchiveBytes: config.subject.localTree.maxArchiveBytes }),
  });
  process.stderr.write(
    `humanish local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}` +
      `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`,
  );
  return packed;
}

/**
 * Default local-tree packing implementation: createLocalTreeArchive(root, opts) on the host,
 * then a single read of the produced archive file into an ArrayBuffer for upload. The DI seam
 * (LabDeps.packLocalTree) overrides this in deterministic tests so they never require
 * tar/git.
 */
export async function defaultPackLocalTree(args: {
  root: string;
  extraExclude?: string[];
  maxArchiveBytes?: number;
}): Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }> {
  const archive = createLocalTreeArchive(args.root, {
    ...(args.extraExclude === undefined ? {} : { extraExclude: args.extraExclude }),
    ...(args.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: args.maxArchiveBytes }),
  });
  // The archive was written to a fresh mkdtemp dir (no outputPath passed above). Once the bytes
  // are buffered, or the read fails, the on-disk copy is residue, and a packed working tree left
  // in the host tmpdir is itself a small leak surface. Best-effort removal.
  try {
    const bytes = await readFile(archive.archivePath);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return { archive, buffer };
  } finally {
    await rm(path.dirname(archive.archivePath), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
