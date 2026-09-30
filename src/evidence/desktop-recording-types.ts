import { z } from "zod";

/** Leaves room for Chromium on the local guest's shared 512 MiB state disk. */
export const DESKTOP_RECORDING_MAX_BYTES = 128 * 1024 * 1024;

export const desktopRecordingMetadataSchema = z.strictObject({
  mimeType: z.literal("video/mp4"),
  startedAt: z.iso.datetime(),
  durationMs: z.number().finite().positive(),
  bytes: z.number().int().positive().max(DESKTOP_RECORDING_MAX_BYTES),
  audioSources: z
    .array(z.enum(["microphone-input", "speaker-output"]))
    .max(2)
    .refine((values) => new Set(values).size === values.length),
  complete: z.boolean(),
});

export type DesktopRecordingMetadata = z.infer<typeof desktopRecordingMetadataSchema>;

/** A desktop recording as recorded in run.json: its metadata and the run-relative MP4 path. */
export interface RunDesktopRecording extends DesktopRecordingMetadata {
  schema: "humanish.desktop-recording.v1";
  path: string;
}

export const desktopRecordingConfigSchema = z.strictObject({ audio: z.boolean() });
export type DesktopRecordingConfig = z.infer<typeof desktopRecordingConfigSchema>;
