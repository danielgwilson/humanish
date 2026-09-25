import { startDesktopMedia } from "./guest-desktop-media.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "./e2b-desktop-launch.js";
import type { LabDesktopMedia } from "./lab-config.js";

/** The same worker and conversation contract, transported by the hosted SDK's stdin/stdout. */
export async function startE2BDesktopMedia(options: {
  desktop: E2BDesktopSandbox;
  media: LabDesktopMedia;
  signal: AbortSignal;
  onTerminal(): void;
  requestTimeoutMs: number;
}): Promise<Awaited<ReturnType<typeof startDesktopMedia>>> {
  if (options.media.camera !== undefined) throw new Error("Hosted speech cannot be combined with a synthetic camera.");
  let handle: E2BCommandResult | undefined;
  let closing = false;
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/user", USER: "user", LOGNAME: "user",
    LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/tmp/humanish-media-runtime" };
  return startDesktopMedia({ media: options.media, env, signal: options.signal, onTerminal: options.onTerminal,
    transport: {
      async start(callbacks) {
        handle = await options.desktop.commands.run("node /opt/humanish/media/guest-media-worker.js", {
          background: true, stdin: true, envs: { ...callbacks.env }, timeoutMs: 0, requestTimeoutMs: options.requestTimeoutMs,
          onStdout: data => callbacks.data(Buffer.from(data)), onStderr: () => {}
        });
        if (!handle.sendStdin || !handle.closeStdin || !handle.kill || !handle.wait) {
          await handle.kill?.();
          throw new Error("Hosted speech needs an E2B SDK with streaming command stdin support.");
        }
        void handle.wait().then(() => { if (!closing) callbacks.exit(); }, () => { if (!closing) callbacks.exit(); });
      },
      async write(data) {
        if (closing || !handle?.sendStdin) throw new Error("The hosted speech worker is closed.");
        await handle.sendStdin(data, { requestTimeoutMs: options.requestTimeoutMs });
      },
      async close() {
        if (closing) return;
        closing = true;
        if (!handle) return;
        await handle.closeStdin?.({ requestTimeoutMs: options.requestTimeoutMs }).catch(() => {});
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([handle.wait?.().catch(() => {}), new Promise<void>(resolve => {
            timer = setTimeout(() => { void handle?.kill?.().finally(resolve); }, 2000);
          })]);
        } finally { clearTimeout(timer); }
      }
    }
  });
}
