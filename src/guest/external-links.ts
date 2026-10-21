// Links the guest browser hands to another app (mailto:, tel:, sms:). The guest has no email,
// phone or messaging app. The image's stand-ins for xdg-open and xdg-email, first on the guest's
// search path, append each such link to a log in the runtime directory, and every observation the
// executor returns carries the links appended since the previous one.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  EXTERNAL_HANDOFF_LIMITS,
  externalHandoffOf,
  type ExternalHandoff,
} from "../actors/computer-use/external-handoff.js";
import type { CuaExecutor } from "../actors/computer-use/loop.js";
import { externalAppPreferences } from "../evidence/browser-hygiene.js";

/** Where the image keeps the stand-ins. */
export const GUEST_EXTERNAL_LINK_BIN = "/opt/humanish/control/bin";

/**
 * Write the browser profile's Preferences before the first launch, so the initial app's origin
 * opens tel:, sms: and the other app schemes without Chromium's prompt. No initial URL, no file.
 */
export async function prepareGuestBrowserProfile(
  profileDir: string,
  initialUrl: string | undefined,
): Promise<void> {
  const preferences = externalAppPreferences(initialUrl);
  if (preferences === undefined) return;
  await mkdir(`${profileDir}/Default`, { recursive: true, mode: 0o700 });
  await writeFile(`${profileDir}/Default/Preferences`, JSON.stringify(preferences), {
    mode: 0o600,
    flag: "wx",
  });
}

/**
 * The executor with each observation carrying the links appended to `log` since the previous
 * observation, at most EXTERNAL_HANDOFF_LIMITS.perObservation. A line still being written waits
 * for the next observation. Every other property of the executor is kept.
 */
export function withExternalHandoffs(executor: CuaExecutor, log: string): CuaExecutor {
  let consumed = 0;
  return {
    ...executor,
    observe: async () => {
      const observation = await executor.observe();
      const text = await readFile(log, "utf8").catch(() => "");
      const lines = text
        .split("\n")
        .slice(0, -1)
        .slice(consumed, consumed + EXTERNAL_HANDOFF_LIMITS.perObservation);
      consumed += lines.length;
      const externalHandoffs = lines.flatMap((line): ExternalHandoff[] => {
        const handoff = externalHandoffOf(line);
        return handoff === undefined ? [] : [handoff];
      });
      return externalHandoffs.length === 0 ? observation : { ...observation, externalHandoffs };
    },
  };
}
