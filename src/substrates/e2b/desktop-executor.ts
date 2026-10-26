import { shellQuote } from "../shell.js";
import { perceptualSignature } from "../../evidence/frame-signature.js";
import { commandFailureInfo } from "../command-failure.js";

import type { CuaExecutor, CuaObservation } from "../../actors/computer-use/loop.js";
import { ComputerUseExecutorError } from "../../actors/computer-use/executor-error.js";
import type { ExternalHandoff } from "../../actors/computer-use/external-handoff.js";
import {
  executeX11Action,
  parseMouseLocation,
  type X11TextChannel,
  type X11Transport,
} from "../x11/desktop.js";
import { HOSTED_X11_DIALECT, type X11Dialect } from "../x11/translator.js";

// The desktop side of the computer-use loop for a hosted sandbox: a CuaExecutor over any sandbox
// shaped like @e2b/desktop's (an E2B sandbox, or a Modal sandbox's handle in
// src/substrates/modal/sandbox.ts). Actions are translated once, for every X11 desktop, in
// src/substrates/x11/translator.ts; this module is the hosted transport that runs the xdotool
// commands through the sandbox's command channel, types through a private file, and captures with
// the sandbox's screenshot.
//
// Pointer commands run with the channel's default options, as @e2b/desktop's own input methods ran
// them; a synchronized move can wait about 15 s, which a shorter timeout would turn into a failure.
// Key commands run with a 15 s timeout and check xdotool's stderr, since xdotool skips a key name
// it cannot resolve with a warning and still exits 0.
//
// Public-safety: observe() returns the raw screenshot bytes in CuaObservation.screenshot. The
// loop decides what to persist (raw frames, or blurred ones when redactScreenshots is set), so
// this module never redacts and never logs screenshots or actions. The stateSignature is a
// coarse, non-reversible perceptual hash.

/**
 * The slice of the @e2b/desktop Sandbox the executor depends on, a structural subset of the SDK
 * class (checked against 2.5.0), so a Sandbox or a Modal sandbox handle satisfies it with no
 * adapter. screenshot and wait may return synchronously so a plain fake satisfies the port.
 */
export interface E2BDesktopLike {
  /** The sandbox's command channel: every xdotool command runs here. */
  commands: {
    run(
      command: string,
      options?: { requestTimeoutMs?: number; timeoutMs?: number },
    ): Promise<{
      exitCode?: number;
      stderr?: string;
      stdout?: string;
    }>;
  };
  /** The file channel, for handing typed text to xdotool without shell-quoting it. */
  files: {
    write(
      path: string,
      data: string | ArrayBuffer,
      options?: { requestTimeoutMs?: number; useOctetStream?: boolean },
    ): Promise<unknown>;
  };
  /** Capture the current desktop frame as PNG bytes (default/'bytes' overload). */
  screenshot(): Promise<Uint8Array | Buffer> | Uint8Array | Buffer;
  /** Wait for the given number of milliseconds: E2B sleeps in the sandbox, Modal on the host. */
  wait(ms: number): Promise<void> | void;
}

export interface E2BDesktopExecutorOptions {
  /**
   * Pixels of CuaAction scroll dy per wheel step. The executor sends abs(dy) / scrollAmountPerTick
   * steps, rounded and at least 1 for any nonzero scroll. Default 100.
   */
  scrollAmountPerTick?: number;
  /**
   * Optional runtime-only browser state probe. Used for deterministic stopWhen guards. The loop
   * never persists raw URL/title/text; it only uses them in memory to decide whether to stop.
   */
  observeBrowserState?: () => Promise<Pick<CuaObservation, "url" | "title" | "text" | "scrollY">>;
  /**
   * Optional read of the links the browser handed to another app since the last read
   * (desktop-handoff.ts). It runs beside the browser probe and the screenshot; a read that fails
   * leaves its links for the next one.
   */
  readExternalHandoffs?: () => Promise<readonly ExternalHandoff[]>;
}

const TYPE_COMMAND_TIMEOUT_MS = 15_000;
const KEY_COMMAND_TIMEOUT_MS = 15_000;
/** The xdotool commands that press or release keys, which the key-command checks apply to. */
const KEY_COMMANDS: ReadonlySet<string> = new Set(["key", "keydown", "keyup"]);
/** An xdotool word that is safe unquoted in a shell command. */
const XDOTOOL_WORD = /^[\w.+-]+$/;

/** Coerce screenshot bytes (Uint8Array or Buffer) to a Node Buffer without copying when possible. */
function toBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/** The stage of a `type` action that failed. */
export type CuaTypePhase = "text-tempfile" | "text-command";

/**
 * A `type` action that failed. Typed text can be a credential (a login step typing a subject-env
 * password), so the message names the phase and, for xdotool, its exit code only: no text, no
 * temp-file path, no substrate output. The loop records `.name` + `.message` into the actor trace.
 */
export class ComputerUseTypeError extends Error {
  readonly phase: CuaTypePhase;
  readonly exitCode?: number;

  constructor(phase: CuaTypePhase, exitCode?: number) {
    super(`type failed at ${phase}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`);
    this.name = "ComputerUseTypeError";
    this.phase = phase;
    if (exitCode !== undefined) this.exitCode = exitCode;
  }
}

/**
 * A key command xdotool did not complete. The loop reads `exitCode` and `stderr` the way it reads
 * the SDK's CommandExitError, so it records the action as a failed desktop command and skips it.
 */
class ComputerUseKeyError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`key command failed (exit ${exitCode})`);
    this.name = "ComputerUseKeyError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** The pace @e2b/desktop's write typed at, kept so typing keeps it. */
const XDOTOOL_TYPE_DELAY_MS = 75;

const TYPE_DIRECTORY = /^\/tmp\/humanish-type-[A-Za-z0-9]+$/;

/**
 * Stage `text` in a 0600 file in a directory `mktemp -d` makes, for one xdotool command in the
 * UTF-8 locale that reads it by path (never through the shell).
 *
 * The stock desktop runs commands in the C locale, where xdotool types the characters before the
 * first non-ASCII one and then fails; the SDK write split text into 25-unit chunks and failed the
 * same way partway through. Either would leave a prefix typed, so there is one attempt and no
 * retry. close removes the directory and never fails.
 */
async function prepareTypedText(desktop: E2BDesktopLike, text: string): Promise<X11TextChannel> {
  const { commands, files } = desktop;
  const quick = { requestTimeoutMs: TYPE_COMMAND_TIMEOUT_MS, timeoutMs: TYPE_COMMAND_TIMEOUT_MS };
  let directory: string | undefined;
  try {
    const made = await commands.run(
      'umask 077 && d=$(mktemp -d /tmp/humanish-type-XXXXXXXX) && : > "$d/text" && printf \'%s\' "$d"',
      quick,
    );
    directory = made.stdout?.trim();
  } catch {
    throw new ComputerUseTypeError("text-tempfile");
  }
  if (directory === undefined || !TYPE_DIRECTORY.test(directory))
    throw new ComputerUseTypeError("text-tempfile");
  const remove = shellQuote(directory);
  const close = async (): Promise<void> => {
    await commands.run(`rm -rf -- ${remove}`, quick).catch(() => undefined);
  };
  const file = `${directory}/text`;
  try {
    await files.write(file, text, { requestTimeoutMs: TYPE_COMMAND_TIMEOUT_MS });
  } catch {
    await close();
    throw new ComputerUseTypeError("text-tempfile");
  }
  return {
    async paste() {
      // xdotool waits the delay after every character, so a long text needs a longer budget.
      const timeoutMs = TYPE_COMMAND_TIMEOUT_MS + [...text].length * XDOTOOL_TYPE_DELAY_MS;
      let result: { exitCode?: number } | undefined;
      try {
        result = await commands.run(
          `DISPLAY="\${DISPLAY:-:0}" LC_ALL=C.UTF-8 xdotool type --delay ${XDOTOOL_TYPE_DELAY_MS} --file ${shellQuote(file)}`,
          { requestTimeoutMs: timeoutMs, timeoutMs },
        );
      } catch (error) {
        // The SDK throws on a non-zero exit; only its exit code is kept.
        throw new ComputerUseTypeError("text-command", commandFailureInfo(error).exitCode);
      }
      // A structural fake may return a non-zero exit instead of throwing, as the SDK does.
      if (result?.exitCode !== undefined && result.exitCode !== 0)
        throw new ComputerUseTypeError("text-command", result.exitCode);
    },
    close,
  };
}

/** The X11 transport over a hosted sandbox's command, file and screenshot channels. */
function sandboxTransport(desktop: E2BDesktopLike): X11Transport {
  return {
    async input(args) {
      if (!args.every((word) => XDOTOOL_WORD.test(word)))
        throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      const command = `xdotool ${args.join(" ")}`;
      if (!KEY_COMMANDS.has(args[0] ?? "")) {
        await desktop.commands.run(command);
        return;
      }
      const result = await desktop.commands.run(command, {
        requestTimeoutMs: KEY_COMMAND_TIMEOUT_MS,
        timeoutMs: KEY_COMMAND_TIMEOUT_MS,
      });
      const exitCode = result.exitCode ?? 0;
      const stderr = result.stderr ?? "";
      if (exitCode !== 0 || stderr.includes("No such key name"))
        throw new ComputerUseKeyError(exitCode, stderr);
    },
    prepareText: (text) => prepareTypedText(desktop, text),
    async wait(ms) {
      await desktop.wait(ms);
    },
    async capture() {
      return toBuffer(await desktop.screenshot());
    },
    async readPointer() {
      const result = await desktop.commands.run("xdotool getmouselocation");
      return parseMouseLocation(result.stdout ?? "");
    },
  };
}

/**
 * Create a CuaExecutor backed by a hosted desktop sandbox (or any structural E2BDesktopLike,
 * e.g. a CI fake). observe() captures a frame and computes its perceptual signature; execute()
 * runs one CuaAction through the shared X11 translator. No screenshot or action is ever logged.
 */
export function createE2BDesktopExecutor(
  desktop: E2BDesktopLike,
  options: E2BDesktopExecutorOptions = {},
): CuaExecutor {
  const transport = sandboxTransport(desktop);
  const dialect: X11Dialect =
    options.scrollAmountPerTick === undefined
      ? HOSTED_X11_DIALECT
      : {
          ...HOSTED_X11_DIALECT,
          scroll: { kind: "vertical-repeat", pixelsPerStep: options.scrollAmountPerTick },
        };
  return {
    async observe(): Promise<CuaObservation> {
      // Probe browser state before the screenshot so a deterministic stopWhen match
      // and its persisted frame describe the same settled surface as closely as the
      // desktop substrate allows.
      const handoffs = options.readExternalHandoffs?.().catch(() => []);
      const browserState = await options.observeBrowserState?.().catch(() => undefined);
      const screenshot = await transport.capture(NEVER_ABORTED);
      const externalHandoffs = (await handoffs) ?? [];
      return {
        ...(externalHandoffs.length === 0 ? {} : { externalHandoffs }),
        screenshot,
        stateSignature: perceptualSignature(screenshot),
        ...(browserState?.url === undefined ? {} : { url: browserState.url }),
        ...(browserState?.title === undefined ? {} : { title: browserState.title }),
        ...(browserState?.text === undefined ? {} : { text: browserState.text }),
        ...(browserState?.scrollY === undefined ? {} : { scrollY: browserState.scrollY }),
      };
    },
    execute: (action, signal) =>
      executeX11Action(action, { transport, dialect }, signal ?? NEVER_ABORTED),
  };
}

/** The signal for a call that was given none. */
const NEVER_ABORTED = new AbortController().signal;
