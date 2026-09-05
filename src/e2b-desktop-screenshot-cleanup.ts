import { AsyncLocalStorage } from "node:async_hooks";

import type { E2BDesktopSandbox } from "./e2b-desktop-launch.js";

type FileOperation = (path: string, ...args: unknown[]) => Promise<unknown>;
type ScreenshotFiles = { read?: FileOperation; remove?: FileOperation };

const guarded = new WeakSet<object>();
const failureCounts = new WeakMap<object, number>();

/** Runtime diagnostic only; no provider errors, file paths, or image contents are retained. */
export function desktopScreenshotCleanupFailures(desktop: object): number {
  return failureCounts.get(desktop) ?? 0;
}

/**
 * @e2b/desktop 2.3.3 screenshot() awaits capture and files.read(path), then discards the
 * files.remove(path) promise. A removal that races sandbox teardown can therefore crash Node
 * AFTER valid bytes were returned. Installed-SDK conformance tests pin that behavior (#662).
 *
 * Observe only removal of a file successfully read within THIS screenshot invocation. The
 * exact path comes from the SDK, not a guessed filename pattern. AsyncLocalStorage isolates
 * concurrent screenshots and unrelated file operations without changing SDK method receivers.
 * The ORIGINAL removal promise is returned: an SDK version (or caller) that awaits it still
 * receives the original rejection. No process-wide rejection handler or filesystem retry.
 */
export function protectDesktopScreenshotCleanup<T extends E2BDesktopSandbox>(desktop: T): T {
  if (guarded.has(desktop)) return desktop;
  const files = desktop.files as ScreenshotFiles;
  const read = files.read;
  const remove = files.remove;
  if (typeof read !== "function" || typeof remove !== "function") return desktop;

  const screenshot = desktop.screenshot;
  const scope = new AsyncLocalStorage<Set<string>>();
  files.read = function (path, ...args) {
    const pending = read.call(this, path, ...args);
    const paths = scope.getStore();
    if (paths === undefined) return pending;
    return pending.then((value) => {
      paths.add(path);
      return value;
    });
  };
  files.remove = function (path, ...args) {
    const pending = remove.call(this, path, ...args);
    if (scope.getStore()?.has(path)) {
      // The secondary handler resolves independently. Returning pending (not catch's promise)
      // preserves awaited removal failures while observing the SDK's detached rejection.
      void pending.catch(() => {
        const count = desktopScreenshotCleanupFailures(desktop) + 1;
        failureCounts.set(desktop, count);
        try {
          process.stderr.write(`humanish desktop: screenshot temporary-file cleanup failed (${count}); captured image remains usable. Sandbox teardown reclaims temporary files.\n`);
        } catch {
          // A closed diagnostic stream must not turn this secondary rejection observer into a
          // new unhandled rejection. The per-instance counter remains available.
        }
      });
    }
    return pending;
  };
  desktop.screenshot = function (...args) {
    return scope.run(new Set<string>(), () => screenshot.apply(this, args));
  };
  guarded.add(desktop);
  return desktop;
}
