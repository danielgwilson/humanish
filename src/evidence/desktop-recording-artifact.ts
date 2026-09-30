import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  desktopRecordingMetadataSchema,
  DESKTOP_RECORDING_MAX_BYTES,
  type DesktopRecordingMetadata,
  type RunDesktopRecording,
} from "./desktop-recording-types.js";
import {
  assertSafeOutputPathSegment,
  prepareContainedOutputFile,
  type PreparedOutputDirectory,
} from "../run/selected-output-paths.js";

/** Both providers stream into the same bounded artifact writer before desktop teardown. */
export async function collectDesktopRecording(
  root: PreparedOutputDirectory,
  laneId: string,
  receive: (destination: Writable) => Promise<DesktopRecordingMetadata>,
): Promise<RunDesktopRecording> {
  assertSafeOutputPathSegment(laneId, "Recording lane");
  const path = `recordings/${laneId}/desktop.mp4`;
  const target = await prepareContainedOutputFile(root, path);
  const temporary = await prepareContainedOutputFile(
    root,
    `recordings/${laneId}/.recording-${randomUUID()}.mp4`,
  );
  const handle = await open(temporary, "wx", 0o600);
  let bytes = 0;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (bytes + chunk.length > DESKTOP_RECORDING_MAX_BYTES) {
        callback(new Error("Recording exceeds the size limit."));
        return;
      }
      // FileHandle.write can write fewer bytes than requested.
      void (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw new Error("Recording write made no progress.");
          offset += result.bytesWritten;
        }
        bytes += chunk.length;
      })().then(() => callback(), callback);
    },
  });
  const completed = finished(destination);
  void completed.catch(() => {});
  try {
    const metadata = desktopRecordingMetadataSchema.parse(await receive(destination));
    await completed;
    if (bytes !== metadata.bytes)
      throw new Error("Recording transfer size does not match its metadata.");
    await handle.close();
    if ((await prepareContainedOutputFile(root, path)) !== target)
      throw new Error("Recording output changed.");
    await rename(temporary, target);
    return { schema: "humanish.desktop-recording.v1", path, ...metadata };
  } finally {
    destination.destroy();
    await completed.catch(() => {});
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
