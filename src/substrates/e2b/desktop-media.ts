import { readFile } from "node:fs/promises";
import path from "node:path";
import { startDesktopMedia } from "../../guest-desktop-media.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "./sdk.js";
import type { LabDesktopMedia } from "../../lab/types.js";
import { failureTail, toErrorMessage } from "../../evidence/redaction.js";
import { runOrThrow } from "../shell.js";
import { e2bShell } from "./shell.js";

/** The same worker and conversation contract, transported by the hosted SDK's stdin/stdout. */
export async function startE2BDesktopMedia(options: {
  desktop: E2BDesktopSandbox;
  media: LabDesktopMedia;
  signal: AbortSignal;
  onTerminal(): void;
  requestTimeoutMs: number;
}): Promise<Awaited<ReturnType<typeof startDesktopMedia>>> {
  if (options.media.camera !== undefined)
    throw new Error("Hosted speech cannot be combined with a synthetic camera.");
  let handle: E2BCommandResult | undefined;
  let closing = false;
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/user",
    USER: "user",
    LOGNAME: "user",
    LANG: "C.UTF-8",
    XDG_RUNTIME_DIR: "/tmp/humanish-media-runtime",
  };
  return startDesktopMedia({
    media: options.media,
    env,
    signal: options.signal,
    onTerminal: options.onTerminal,
    transport: {
      async start(callbacks) {
        // A background run returns a process handle and never throws on exit, so it bypasses
        // the Shell: the worker's stdin and lifetime need the handle.
        handle = await options.desktop.commands.run(
          "node /opt/humanish/media/guest-media-worker.js",
          {
            background: true,
            stdin: true,
            envs: { ...callbacks.env },
            timeoutMs: 0,
            requestTimeoutMs: options.requestTimeoutMs,
            onStdout: (data) => callbacks.data(Buffer.from(data)),
            onStderr: () => {},
          },
        );
        if (!handle.sendStdin || !handle.closeStdin || !handle.kill || !handle.wait) {
          await handle.kill?.();
          throw new Error("Hosted speech needs an E2B SDK with streaming command stdin support.");
        }
        void handle.wait().then(
          () => {
            if (!closing) callbacks.exit();
          },
          () => {
            if (!closing) callbacks.exit();
          },
        );
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
          await Promise.race([
            handle.wait?.().catch(() => {}),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                void handle
                  ?.kill?.()
                  .catch(() => {})
                  .finally(resolve);
              }, 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  });
}

export interface DesktopMediaEvidence {
  camera?: { source: "synthetic" | "file"; file: string };
  microphone?: { source: "speech" };
  permission: "prompt" | "granted";
  flags: string[];
}

/** Where a lane's synthetic camera feed lives inside the sandbox: a tmpfs the sandbox user can
 *  write, and a path that contains neither /tmp/ nor /home/, which the public-safety scan reads
 *  as an operator's local path (this one is the harness's own and belongs in the bundle). */
const SANDBOX_MEDIA_DIR = "/dev/shm/humanish-media";

const SANDBOX_CAMERA_PATH = `${SANDBOX_MEDIA_DIR}/camera.y4m`;

/** The synthetic feed: ffmpeg's test pattern, 640x480 at 10 fps, six seconds (about 28 MB of
 *  raw Y4M on the tmpfs), looped by Chrome's fake capture device. */
const SYNTHETIC_CAMERA_COMMAND = `mkdir -p ${SANDBOX_MEDIA_DIR} && ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x480:rate=10 -t 6 -pix_fmt yuv420p ${SANDBOX_CAMERA_PATH}`;

/**
 * Put the declared camera feed in the sandbox and return the Chromium flags that present it as a
 * capture device (#509). Fails CLOSED: a feed that cannot be produced (no ffmpeg on the image, an
 * unreadable host file) is named before the browser launches, because a participant told it has
 * a camera and finds none reports the instrument's gap as the product's.
 */
export async function prepareDesktopMedia(
  desktop: E2BDesktopSandbox,
  media: LabDesktopMedia,
  permission: "prompt" | "granted",
  cwd: string,
  requestTimeoutMs: number,
  readHostFile: (absolutePath: string) => Promise<Buffer> = (absolutePath) =>
    readFile(absolutePath),
): Promise<DesktopMediaEvidence> {
  if (media.microphone !== undefined) {
    if (media.microphone.source !== "speech")
      throw new Error("Microphone source-file injection is unsupported; use source: speech.");
    if (media.camera !== undefined)
      throw new Error("Hosted synthetic cameras cannot be combined with speech.");
    // The lane starts and admits the speech worker before launching the browser.
    return {
      microphone: { source: "speech" },
      permission,
      flags: permission === "granted" ? ["--use-fake-ui-for-media-stream"] : [],
    };
  }
  const flags: string[] = [];
  let camera: DesktopMediaEvidence["camera"];
  const shell = e2bShell(desktop);
  if (media.camera !== undefined) {
    if (media.camera.source === "synthetic") {
      const made = await shell.run(SYNTHETIC_CAMERA_COMMAND, {
        requestTimeoutMs,
        timeoutMs: 60_000,
      });
      if (made.exitCode !== 0) {
        throw new Error(
          `the synthetic camera feed could not be generated on this desktop image (ffmpeg exited ${made.exitCode}: ${failureTail(made.stderr || made.stdout)}); give execution.desktop.media.camera.source a .y4m file instead`,
        );
      }
      camera = { source: "synthetic", file: SANDBOX_CAMERA_PATH };
    } else {
      const absolutePath = path.resolve(cwd, media.camera.source);
      let bytes: Buffer;
      try {
        bytes = await readHostFile(absolutePath);
      } catch (error) {
        throw new Error(
          `execution.desktop.media.camera.source could not be read (${toErrorMessage(error)})`,
        );
      }
      if (bytes.length > 64 * 1024 * 1024) {
        throw new Error(
          `execution.desktop.media.camera.source is ${bytes.length} bytes; the camera feed is capped at 64 MiB`,
        );
      }
      await runOrThrow(shell, `mkdir -p ${SANDBOX_MEDIA_DIR}`, {
        requestTimeoutMs,
        timeoutMs: 15_000,
      });
      const payload = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      // An ArrayBuffer goes to the machine as an octet stream.
      await shell.writeFile(SANDBOX_CAMERA_PATH, payload, { requestTimeoutMs });
      camera = { source: "file", file: SANDBOX_CAMERA_PATH };
    }
    flags.push(
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${SANDBOX_CAMERA_PATH}`,
    );
  }
  if (permission === "granted") flags.push("--use-fake-ui-for-media-stream");
  return { ...(camera === undefined ? {} : { camera }), permission, flags };
}
