import { z } from "zod";
import { MIN_DESKTOP_RENDER_WIDTH } from "../study/device-presets.js";

/** The screen a guest starts when the bootstrap names none. */
export const DEFAULT_GUEST_SCREEN = Object.freeze({ width: 960, height: 720 });

/**
 * The screens a guest admits. The narrowest is the narrowest window Chromium renders; the widest
 * is the widest device preset. At 1920×1200 an uncompressed 24-bit frame is 6.9 MB, so every
 * capture fits the 8 MiB browser-control PNG limit. Below 480 pixels high the page area under
 * Chromium's toolbar is too short to use.
 */
export const GUEST_SCREEN_LIMITS = Object.freeze({
  minWidth: MIN_DESKTOP_RENDER_WIDTH,
  maxWidth: 1920,
  minHeight: 480,
  maxHeight: 1200,
});

const side = (max: number) => z.number().int().min(1).max(max);

/** One participant's Xvfb screen, and the mobile emulation its pages get, if any. */
export const guestDisplayConfigSchema = z
  .object({
    width: z.number().int().min(GUEST_SCREEN_LIMITS.minWidth).max(GUEST_SCREEN_LIMITS.maxWidth),
    height: z.number().int().min(GUEST_SCREEN_LIMITS.minHeight).max(GUEST_SCREEN_LIMITS.maxHeight),
    mobileEmulation: z
      .object({
        width: side(GUEST_SCREEN_LIMITS.maxWidth),
        height: side(GUEST_SCREEN_LIMITS.maxHeight),
        deviceScaleFactor: z.number().positive().max(4),
        touch: z.boolean(),
        // The bootstrap frame is ASCII; a launch flag carries it too.
        userAgent: z.string().regex(/^[\x20-\x7e]{1,512}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GuestDisplayConfig = z.infer<typeof guestDisplayConfigSchema>;
