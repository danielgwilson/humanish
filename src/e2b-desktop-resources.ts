import type { E2BDesktopSandbox } from "./e2b-desktop-launch.js";
import { isDesktopResources, type DesktopResources } from "./pricing.js";

export type DesktopResourceObservation =
  | { resources: DesktopResources; source: "e2b.getInfo" }
  | { reason: "metadata_unavailable" | "metadata_invalid" | "metadata_timeout" };

/** Called once after the caller owns and journals the handle. Never throws or delays cleanup
 * beyond the bounded wait. Persist only resource quantities, never the raw info/connection. */
export async function observeDesktopResources(
  desktop: Pick<E2BDesktopSandbox, "getInfo">,
  timeoutMs = 1_000
): Promise<DesktopResourceObservation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof desktop.getInfo !== "function") return { reason: "metadata_unavailable" };
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 1_000) : 1_000;
    return await Promise.race([
      Promise.resolve().then(async (): Promise<DesktopResourceObservation> => {
        const info = await desktop.getInfo!({ requestTimeoutMs: waitMs, signal: controller.signal });
        const resources = { cpuCount: info?.cpuCount, memoryMiB: info?.memoryMB };
        return isDesktopResources(resources)
          ? { resources, source: "e2b.getInfo" }
          : { reason: "metadata_invalid" };
      }),
      new Promise<DesktopResourceObservation>((resolve) => {
        timer = setTimeout(() => resolve({ reason: "metadata_timeout" }), waitMs);
      })
    ]);
  } catch {
    return { reason: "metadata_unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
