// The desktop calls of the sandbox port, for a sandbox that has no desktop. A shell sandbox
// satisfies E2BDesktopSandbox with these, so acquire(), release and reclaim treat it as any other.
import type { E2BDesktopSandbox } from "./sdk.js";

type DesktopSurface = Pick<E2BDesktopSandbox, "wait" | "launch" | "screenshot" | "stream">;

/** Desktop calls that reject with `unsupported(what)`; `wait` still waits. */
export function shellOnlySurface(unsupported: (what: string) => Error): DesktopSurface {
  const reject = (what: string) => () => Promise.reject(unsupported(what));
  return {
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    launch: reject("A desktop application launch"),
    screenshot: reject("A desktop screenshot"),
    stream: {
      getAuthKey: () => {
        throw unsupported("A desktop stream");
      },
      getUrl: () => {
        throw unsupported("A desktop stream");
      },
      start: reject("A desktop stream"),
    },
  };
}
