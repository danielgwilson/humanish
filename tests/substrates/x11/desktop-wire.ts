import { Sandbox as SdkDesktop } from "@e2b/desktop";
import { PNG } from "pngjs";

import type { CuaExecutor } from "../../../src/actors/computer-use/loop.js";
import { createGuestDesktopExecutor } from "../../../src/guest/desktop-executor.js";
import { createE2BDesktopExecutor } from "../../../src/substrates/e2b/desktop-executor.js";
import type { E2BCommandRunOptions } from "../../../src/substrates/e2b/sdk.js";
import { MODAL_STREAM_PORT, modalDesktopSurface } from "../../../src/substrates/modal/desktop.js";

// Each substrate's executor over a fake of its lowest channel, recording what reaches the desktop
// as one line per native call. E2B is the installed @e2b/desktop Sandbox with its command and file
// channels replaced, so the lines are the SDK's own commands. Modal is the sandbox handle's
// composition (src/substrates/modal/sandbox.ts) over a recording command runner. The guest is
// its executor over a recording GuestDesktopTools.

/** The desktop frame every harness addresses. */
const FRAME = { width: 1440, height: 950 } as const;

const TYPE_DIRECTORY = "/tmp/humanish-type-T1";

/** A wire harness: the executor, the lines it sent, and where the fake pointer is. */
export interface WireDesktop {
  readonly executor: CuaExecutor;
  readonly wire: string[];
  /** Where `xdotool getmouselocation` reports the pointer; tests move it with Object.assign. */
  readonly pointer: { x: number; y: number };
  /** Make the next command matching `pattern` fail as the substrate reports it. */
  failNext(pattern: RegExp, failure: CommandFailure): void;
}

/** How a fake command fails: a thrown exit, or a returned exit with stderr. */
type CommandFailure =
  | { readonly throws: number }
  | { readonly returns: number; readonly stderr: string };

export type SubstrateName = "e2b" | "modal" | "guest";

/** The value every channel of the fake frame holds at (x, y), so a crop can be checked by pixel. */
export function framePixel(x: number, y: number): number {
  return (x * 7 + y * 13) % 256;
}

let frame: Buffer | undefined;

function framePng(): Buffer {
  frame ??= drawFrame();
  return frame;
}

function drawFrame(): Buffer {
  const png = new PNG({ width: FRAME.width, height: FRAME.height });
  for (let y = 0; y < FRAME.height; y++)
    for (let x = 0; x < FRAME.width; x++) {
      const offset = (y * FRAME.width + x) * 4;
      png.data.fill(framePixel(x, y), offset, offset + 3);
      png.data[offset + 3] = 255;
    }
  return PNG.sync.write(png);
}

function exitError(exitCode: number): Error {
  return Object.assign(new Error(`exit ${exitCode}`), { name: "CommandExitError", exitCode });
}

/** A command runner shared by the E2B and Modal harnesses. */
function commandRunner(desktop: Pick<WireDesktop, "wire" | "pointer">) {
  const failures: Array<{ pattern: RegExp; failure: CommandFailure }> = [];
  const run = async (command: string, options?: E2BCommandRunOptions) => {
    desktop.wire.push(options === undefined ? command : `${command} ${JSON.stringify(options)}`);
    const index = failures.findIndex(({ pattern }) => pattern.test(command));
    if (index >= 0) {
      const { failure } = failures.splice(index, 1)[0]!;
      if ("throws" in failure) throw exitError(failure.throws);
      return { exitCode: failure.returns, stdout: "", stderr: failure.stderr };
    }
    if (command === "xdotool getmouselocation")
      return {
        exitCode: 0,
        stdout: `x:${desktop.pointer.x} y:${desktop.pointer.y} screen:0 window:1\n`,
        stderr: "",
      };
    if (command.includes("mktemp")) return { exitCode: 0, stdout: TYPE_DIRECTORY, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const failNext = (pattern: RegExp, failure: CommandFailure) => {
    failures.push({ pattern, failure });
  };
  return { run, failNext };
}

function e2bDesktop(): WireDesktop {
  const harness = { wire: [] as string[], pointer: { x: 1, y: 1 } };
  const { run, failNext } = commandRunner(harness);
  // Direct construction does not allocate or bootstrap a sandbox.
  const sdk = new SdkDesktop({
    sandboxId: "synthetic-local-desktop",
    envdVersion: "0.0.0",
    debug: true,
    apiKey: "synthetic-not-a-provider-key",
  });
  sdk.commands.run = run as unknown as typeof sdk.commands.run;
  sdk.files.write = (async (path: string, data: unknown) => {
    harness.wire.push(`files.write ${path} ${String(data)}`);
    return { name: "text", path, type: "file" };
  }) as unknown as typeof sdk.files.write;
  sdk.files.read = (async (path: string) => {
    harness.wire.push(`files.read ${path}`);
    return framePng();
  }) as unknown as typeof sdk.files.read;
  sdk.files.remove = (async (path: string) => {
    harness.wire.push(`files.remove ${path}`);
  }) as unknown as typeof sdk.files.remove;
  return { ...harness, failNext, executor: createE2BDesktopExecutor(sdk) } as WireDesktop;
}

function modalDesktop(): WireDesktop {
  const harness = { wire: [] as string[], pointer: { x: 1, y: 1 } };
  const { run, failNext } = commandRunner(harness);
  const handle = {
    commands: { run },
    files: {
      write: async (path: string, data: string | ArrayBuffer) => {
        harness.wire.push(`files.write ${path} ${typeof data === "string" ? data : "<bytes>"}`);
      },
    },
    ...modalDesktopSurface(
      run,
      async (path) => {
        harness.wire.push(`readBytes ${path}`);
        return framePng();
      },
      new Map([[MODAL_STREAM_PORT, "ta-01abc-6080.w.modal.host"]]),
    ),
  };
  return { ...harness, failNext, executor: createE2BDesktopExecutor(handle) } as WireDesktop;
}

function guestDesktop(): WireDesktop {
  const harness = { wire: [] as string[], pointer: { x: 1, y: 1 } };
  const failures: Array<{ pattern: RegExp; failure: CommandFailure }> = [];
  const executor = createGuestDesktopExecutor({
    ...FRAME,
    authoritySignal: new AbortController().signal,
    onTerminal: () => harness.wire.push("terminal"),
    tools: {
      async capture() {
        harness.wire.push("capture");
        return framePng();
      },
      async input(args) {
        const line = args.join(" ");
        harness.wire.push(`input ${line}`);
        const index = failures.findIndex(({ pattern }) => pattern.test(line));
        if (index >= 0) {
          failures.splice(index, 1);
          throw exitError(1);
        }
      },
      async readPointer() {
        harness.wire.push("readPointer");
        return { ...harness.pointer };
      },
      async prepareText(text) {
        harness.wire.push(`prepareText ${text}`);
        return {
          paste: async () => void harness.wire.push("paste"),
          close: async () => void harness.wire.push("close"),
        };
      },
    },
  });
  return {
    ...harness,
    executor,
    failNext: (pattern, failure) => void failures.push({ pattern, failure }),
  } as WireDesktop;
}

/** A fresh harness for `substrate`. */
export function wireDesktop(substrate: SubstrateName): WireDesktop {
  if (substrate === "e2b") return e2bDesktop();
  if (substrate === "modal") return modalDesktop();
  return guestDesktop();
}

/** Screenshot paths are random; tests compare them as one placeholder. */
export function normalizeWire(wire: readonly string[]): string[] {
  return wire.map((line) => line.replaceAll(/\/tmp\/screenshot-[A-Za-z0-9]+\.png/g, "<shot>"));
}
