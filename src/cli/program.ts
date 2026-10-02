import { readFileSync } from "node:fs";
import { formatOrientationHuman, readOrientation } from "./orientation.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { redactText } from "../evidence/redaction.js";
import { PortInUseError } from "../observer/listen.js";
import {
  buildPayload,
  disabledByEnvironment,
  durationBucket,
  readTelemetryState,
  sendTelemetry,
  TELEMETRY_NOTICE,
  writeTelemetryState,
  isOwnCheckoutRun,
} from "./telemetry.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerCodexCommands } from "./commands/codex.js";
import { registerCommsCommands } from "./commands/comms.js";
import { registerFeedbackCommands } from "./commands/feedback.js";
import { registerLabCommands } from "./commands/lab.js";
import { registerObserveCommand, registerServeCommand } from "./commands/observe.js";
import {
  registerCleanupCommand,
  registerExportCommand,
  registerReclaimCommand,
  registerReviewCommand,
  registerRunCommand,
  registerRunsCommand,
  registerRuntimeCommands,
  registerStatsCommand,
  registerVerifyCommand,
} from "./commands/runs.js";
import {
  registerDoctorCommand,
  registerInitCommand,
  registerKeysCommand,
  registerTelemetryCommand,
} from "./commands/setup.js";
import { defaultTuiRuntime, registerTuiCommand, type TuiRuntime } from "./commands/tui.js";
import { registerWatchCommand } from "./commands/watch.js";
import {
  CLI_RESPONSE_SCHEMA,
  CLI_VERSION,
  type CliIo,
  defaultIo,
  invocationEnvelopeAlreadyWritten,
  runFactsFor,
  wantsJson,
} from "./io.js";

// The single structured envelope for errors the command-boundary catch-all
// produces when an action handler throws or rejects unexpectedly (see
// HumanishCommand below). Reuses CLI_RESPONSE_SCHEMA so every humanish.cli-response.v1
// document on stdout, planned or not, carries the same schema string.
interface UnexpectedErrorEnvelope {
  schema: typeof CLI_RESPONSE_SCHEMA;
  ok: false;
  error: {
    /** HUMANISH_PORT_IN_USE: a bind failed because the port is held; every command that
     *  opens a loopback server (watch, observe, run --open, serve) reports it under one code. */
    code: "HUMANISH_UNEXPECTED" | "HUMANISH_PORT_IN_USE";
    message: string;
  };
}

// Command boundary catch-all (fix set point 1): every leaf command is created
// through HumanishCommand.createCommand, and HumanishCommand.action wraps the caller's
// handler so an uncaught throw or promise rejection can never escape as a raw
// Node crash. On failure it emits the same structured envelope --json commands
// already promise (schema humanish.cli-response.v1, ok: false, error.code
// HUMANISH_UNEXPECTED) or a single concise stderr line otherwise, then sets exit
// code 2 through the existing CliIo.setExitCode seam. This is the single seam:
// none of the ~20 .action() handlers below need their own try/catch for this.

/**
 * Print the disclosure the first time humanish would collect anything, and remember that it was
 * shown. Awaited by the caller: if this loses the race with process exit, a default-on collector
 * becomes a silent one.
 */
async function announceTelemetryOnce(command: Command, io: CliIo): Promise<void> {
  try {
    if (commandPath(command).startsWith("telemetry")) return;
    if (disabledByEnvironment(process.env)) return;
    const state = await readTelemetryState();
    if (!state.enabled || state.noticed) return;
    io.writeErr(`${TELEMETRY_NOTICE}\n`);
    await writeTelemetryState({ ...state, noticed: true });
  } catch {
    // Never blocks the command.
  }
}

/** The exit code the most recent command chose through CliIo.setExitCode; 0 until it says otherwise. */
let lastExitCode = 0;

/**
 * Record that a command ran. Anonymous, allowlisted, and unable to affect the command: it is not
 * awaited, it is bounded by its own timeout, and every failure inside it is swallowed.
 */
async function recordCommandTelemetry(
  command: Command,
  ok: boolean,
  durationMs: number,
  exitCode: number,
): Promise<void> {
  try {
    // `telemetry` itself is never measured: instrumenting the opt-out would be indecent.
    const name = commandPath(command);
    if (name.startsWith("telemetry")) return;
    if (disabledByEnvironment(process.env)) return;
    // Our own checkout never reports, from whichever directory the command was started: see
    // isOwnCheckoutRun for the measured reason both walks exist.
    if (
      isOwnCheckoutRun(process.cwd(), dirname(fileURLToPath(import.meta.url)), (p) =>
        readFileSync(p, "utf8"),
      )
    )
      return;
    const state = await readTelemetryState();
    if (!state.enabled) return;
    const payload = buildPayload({
      event: "cli_command",
      anonymousId: state.anonymousId,
      version: CLI_VERSION,
      // The study facts (mode, outcome, starter lab, brain, our own error code) were read off the
      // result document when it was written; see writeResult. Without them every `run` event
      // looked the same whether it was a dry run or the first live study that ever worked.
      properties: {
        ...runFactsFor(command),
        command: name,
        ok: ok && exitCode === 0,
        exitCode,
        durationBucket: durationBucket(durationMs),
      },
    });
    if (
      process.env.HUMANISH_TELEMETRY_DEBUG !== undefined &&
      process.env.HUMANISH_TELEMETRY_DEBUG !== ""
    ) {
      process.stderr.write(`humanish telemetry (debug, not sent): ${JSON.stringify(payload)}\n`);
      return;
    }
    await sendTelemetry(payload);
  } catch {
    // Metrics are our problem, never the operator's.
  }
}

/**
 * HUMANISH_DEBUG_HANDLES=1: after a command's handler settles, name what is still keeping the
 * process alive. A live terminal run wrote its result 64 s in and the CLI stayed up for
 * sixteen more minutes; nothing in the bundle could say what held it, and an in-process probe of
 * the run found nothing of ours. This is the one line that answers it next time: the resource
 * types Node reports, once, to stderr, after one macrotask so settled work has cleared.
 */
function reportActiveHandles(command: Command, io: CliIo): void {
  const flag = process.env.HUMANISH_DEBUG_HANDLES;
  if (flag === undefined || flag === "" || flag === "0") return;
  setImmediate(() => {
    const proc = process as NodeJS.Process & { getActiveResourcesInfo?: () => string[] };
    const resources = proc.getActiveResourcesInfo?.() ?? [];
    const counts = new Map<string, number>();
    for (const resource of resources) counts.set(resource, (counts.get(resource) ?? 0) + 1);
    const summary =
      [...counts.entries()].map(([type, count]) => `${type}×${count}`).join(", ") || "none";
    io.writeErr(
      `humanish debug: active resources after \`${commandPath(command) || "humanish"}\` settled: ${summary}\n`,
    );
  }).unref?.();
}

/** `lab run`, not `run`, so the two are distinguishable, and nothing else from the invocation. */
function commandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current && current.name() !== "humanish") {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(" ");
}

class HumanishCommand extends Command {
  private readonly cliIo: CliIo;

  constructor(name: string | undefined, cliIo: CliIo) {
    super(name);
    this.cliIo = cliIo;
  }

  override createCommand(name?: string): Command {
    return new HumanishCommand(name, this.cliIo);
  }

  override action(fn: (this: this, ...args: any[]) => void | Promise<void>): this {
    const cliIo = this.cliIo;
    const wrapped = function (this: Command, ...args: any[]): void | Promise<void> {
      // One emission point for every command, at the same seam that already catches every throw.
      // Twenty .action() handlers each remembering to record a metric is twenty chances to forget
      // one, and a funnel with a hole in it is worse than no funnel.
      const startedAt = Date.now();
      lastExitCode = 0;
      // The notice is awaited; the send is not. They have opposite requirements: disclosure must
      // never be lost (a silent default-on collector is indefensible), and a metric must never
      // make anyone wait. The first version put both in the fire-and-forget path, and the notice
      // lost the race with process exit: a real participant ran this build and never saw it.
      const noticed = announceTelemetryOnce(this, cliIo);
      const finish = (ok: boolean): void => {
        void recordCommandTelemetry(this, ok, Date.now() - startedAt, lastExitCode);
        reportActiveHandles(this, cliIo);
      };
      try {
        // Reflect.apply (not fn.apply) sidesteps TS's special CallableFunction
        // overload for functions typed with an explicit `this` parameter, which
        // would otherwise reject the plain `Command` thisArg below.
        const result = Reflect.apply(fn, this, args) as void | Promise<void>;
        if (result && typeof result.then === "function") {
          return Promise.all([result, noticed]).then(
            () => {
              finish(true);
            },
            (error: unknown) => {
              reportUnexpectedActionError(this, cliIo, error);
              finish(false);
            },
          );
        }
        // A synchronous action still has to let the disclosure land before the process exits.
        return noticed.then(() => {
          finish(true);
        });
      } catch (error) {
        reportUnexpectedActionError(this, cliIo, error);
        return undefined;
      }
    };
    return super.action(wrapped);
  }
}

function reportUnexpectedActionError(command: Command, io: CliIo, error: unknown): void {
  const message = redactText(error instanceof Error ? error.message : String(error));
  // A taken port is the most expected thing a serving command meets; it gets its own code rather
  // than the catch-all's. The message already names the port and whose it is.
  const code: UnexpectedErrorEnvelope["error"]["code"] =
    error instanceof PortInUseError ? "HUMANISH_PORT_IN_USE" : "HUMANISH_UNEXPECTED";

  if (wantsJson(command)) {
    if (invocationEnvelopeAlreadyWritten(command)) {
      // Some result already went to stdout for this invocation before the
      // failure landed, e.g. `codex app-server --keep-open --json` writes its
      // "running" envelope via writeResult, then a later `await` can still
      // reject (src/actors/codex/app-server-ui.ts's persistState() write can fail on
      // either branch of that command's completion handling). Appending a
      // second JSON document to stdout would break every JSON.parse(stdout)
      // consumer, so this failure goes to stderr instead, same as the non-json
      // branch below.
      io.writeErr(`${code}: ${message}\n`);
      io.setExitCode(2);
      return;
    }

    const envelope: UnexpectedErrorEnvelope = {
      schema: CLI_RESPONSE_SCHEMA,
      ok: false,
      error: {
        code,
        message,
      },
    };
    io.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    io.writeErr(`${code}: ${message}\n`);
  }

  io.setExitCode(2);
}

/** `unknown option '--x'` -> the sibling commands that do declare `--x`. */
function commandsDeclaring(root: Command, flag: string): string[] {
  const found: string[] = [];
  const walk = (command: Command, trail: string[]): void => {
    const names = [...trail, command.name()];
    if (
      trail.length > 0 &&
      command.options.some((option) => option.long === flag || option.short === flag)
    ) {
      found.push(names.slice(1).join(" "));
    }
    for (const child of command.commands) walk(child, names);
  };
  walk(root, []);
  return found;
}

/**
 * Enrich commander's flag rejections with where the flag actually lives. A bare "unknown option"
 * is accurate and unhelpful in the same way `no labs here yet` was: it reports a fact about this
 * command and says nothing the reader can act on. Silence is preserved when no sibling has it:
 * inventing a suggestion would be worse than none.
 */
export function withSiblingFlagHint(text: string, root: Command): string {
  const match = /unknown option '([^']+)'/.exec(text);
  if (match === null) return text;
  const owners = commandsDeclaring(root, match[1]!);
  if (owners.length === 0) return text;
  // Truncation is reported, never silent: a list that quietly drops owners would send a reader
  // looking in the wrong place and think it had answered them.
  const shown = owners.slice(0, 3);
  const list = shown.map((owner) => `\`humanish ${owner}\``).join(", ");
  const rest = owners.length - shown.length;
  const tail = rest > 0 ? ` (and ${rest} more)` : "";
  return `${text.replace(/\n+$/, "")}\n${match[1]} is an option of ${list}${tail}, not of this command.\n`;
}

/** Drop the literal `--` that `pnpm <script> -- <args>` puts before the CLI's own arguments. */
export function normalizeCliArgv(argv: string[]): string[] {
  const [runtime, entrypoint, separator, ...rest] = argv;

  if (runtime && entrypoint && separator === "--") {
    return [runtime, entrypoint, ...rest];
  }

  return argv;
}

/**
 * The root help's examples, in the order a newcomer runs them. Each passes on a freshly
 * initialized project (tests/cli/root-help-examples.test.ts).
 */
export const ROOT_HELP_EXAMPLES = [
  "humanish init --yes",
  "humanish run first-run",
  "humanish observe --run latest --open",
  "humanish doctor --lab try-live",
  "humanish run try-live",
  "humanish verify --json",
] as const;

export function createProgram(
  io: Partial<CliIo> & { tuiRuntime?: Partial<TuiRuntime> } = {},
): Command {
  const given: CliIo = { ...defaultIo, ...io };
  // Telemetry's `ok` used to mean "the handler did not throw", which is true of nearly every
  // failure: commands report failure through their envelope and setExitCode(2), not by throwing.
  // 1,359 study events in two days and every one said ok. Record the exit code the command chose.
  const cliIo: CliIo = {
    ...given,
    setExitCode: (code) => {
      lastExitCode = code;
      given.setExitCode(code);
    },
  };
  const program = new HumanishCommand(undefined, cliIo);

  // Bare `humanish` orients instead of printing sixteen subcommands. --help is untouched;
  // this is only what happens when no command was chosen at all. A word that names no command
  // (`humanish verfy`) lands here too, and gets the closest command in place of the help dump.
  program.action(async (options: { json?: boolean }) => {
    const [word] = program.args;
    if (word !== undefined) {
      const suggestion = closestCommand(
        word,
        program.commands.map((command) => command.name()),
      );
      cliIo.writeErr(
        suggestion === undefined
          ? `error: unknown command '${word}'. humanish --help lists the commands.\n`
          : `error: unknown command '${word}'. Did you mean '${suggestion}'?\n`,
      );
      cliIo.setExitCode(1);
      return;
    }
    const state = await readOrientation(".");
    if (options.json === true) {
      cliIo.writeOut(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      cliIo.writeOut(formatOrientationHuman(state));
    }
    cliIo.setExitCode(0);
  });

  program
    .name("humanish")
    .description("Open-source-safe persona simulation CLI and proof harness.")
    .version(CLI_VERSION)
    .showHelpAfterError()
    .option("--json", "Print machine-readable JSON responses where supported.")
    .configureOutput({
      writeOut: (text) => cliIo.writeOut(text),
      writeErr: (text) => cliIo.writeErr(text),
      // A rejected flag should name the command that would have taken it. Found by a real
      // first-contact study (labs/first-contact.yaml): a participant reached for
      // `humanish run --no-open` by analogy with `lab run`, got a bare "unknown option", and
      // filed it as a documentation mismatch. The flag is genuinely absent (`run` opens
      // nothing), but "unknown" says that badly, because the reader's actual question is
      // "then where does it live?".
      outputError: (text, write) => write(withSiblingFlagHint(text, program)),
    })
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        ...ROOT_HELP_EXAMPLES.map((example) => `  ${example}`),
        "",
        "Public-safety boundary:",
        "  humanish must not commit or emit PII, PHI, secrets, keys, raw private transcripts,",
        "  private screenshots, or private upstream artifacts.",
      ].join("\n"),
    );

  registerInitCommand(program, cliIo);
  registerDoctorCommand(program, cliIo);
  registerTuiCommand(program, cliIo, { ...defaultTuiRuntime, ...io.tuiRuntime });
  registerTelemetryCommand(program, cliIo);
  registerKeysCommand(program, cliIo);
  registerRunCommand(program, cliIo);
  registerVerifyCommand(program, cliIo);
  registerCleanupCommand(program, cliIo);
  registerReviewCommand(program, cliIo);
  registerAnalyzeCommand(program, cliIo);
  registerRunsCommand(program, cliIo);
  registerStatsCommand(program, cliIo);
  registerExportCommand(program, cliIo);
  registerCommsCommands(program, cliIo);
  registerRuntimeCommands(program, cliIo);
  registerReclaimCommand(program, cliIo);
  registerWatchCommand(program, cliIo);
  registerObserveCommand(program, cliIo);
  registerServeCommand(program, cliIo);
  registerCodexCommands(program, cliIo);
  registerLabCommands(program, cliIo);
  registerFeedbackCommands(program, cliIo);
  // Only the root takes a stray word, so the action above can name the command it meant. Set after
  // registration: commander copies this setting into each subcommand when it is created.
  program.allowExcessArguments(true);

  return program;
}

/** The registered command closest to a mistyped word, or undefined when none is close. */
function closestCommand(word: string, names: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(word.toLowerCase(), name);
    if (distance <= Math.max(1, Math.floor(name.length / 3)) && (!best || distance < best.distance))
      best = { name, distance };
  }
  return best?.name;
}

/** Levenshtein distance, with an adjacent transposition counted as one edit. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
    }
  return rows[a.length]![b.length]!;
}
