import { z } from "zod";

/** Native devices admitted before the browser starts. File cameras remain hosted-only. */
export const guestMediaConfigSchema = z.object({
  camera: z.object({ source: z.literal("synthetic") }).strict().optional(),
  microphone: z.object({ source: z.literal("speech") }).strict().optional(),
  permission: z.enum(["prompt", "granted"])
}).strict().refine(value => value.camera !== undefined || value.microphone !== undefined);

export type GuestMediaConfig = z.infer<typeof guestMediaConfigSchema>;
