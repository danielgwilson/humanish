import { existsSync, readFileSync } from "node:fs";
import { formatOrientationHuman, readOrientation } from "./orientation.js";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, Option } from "commander";

import { startCodexAppServerUi } from "./codex-app-server-ui.js";
import type { CodexAppServerUiState } from "./codex-app-server-ui.js";
import { loadEnvFile } from "./env-file.js";
import { discoverProviderKeys, listUserKeys, resolveKeyName, setUserKey, unsetUserKey, userKeyStorePath } from "./key-resolution.js";
import type { EnvFileLoadResult } from "./env-file.js";
import { redactText } from "./redaction.js";
import {
  draftFeedback,
  listFeedback,
  renderIssueMarkdown,
  renderIssueUrl,
  verifyFeedback
} from "./feedback.js";
import type { FeedbackResult } from "./feedback.js";
import { runInit } from "./init.js";
import { computeStats, formatStatsHuman } from "./stats.js";
import { DEFAULT_EXPORT_MAX_BYTES, exportRun, formatExportHuman } from "./export.js";
import {
  buildPayload,
  disabledByEnvironment,
  inHumanishCheckout,
  durationBucket,
  readTelemetryState,
  sendTelemetry,
  telemetryStatePath,
  deriveStudyFacts,
  type TelemetryProperties,
  TELEMETRY_NOTICE,
  writeTelemetryState
} from "./telemetry.js";
import type { InitChange, InitResult } from "./init.js";
import {
  inspectLabManifest,
  listLabManifests,
  resolveLabManifest
} from "./labs.js";
import type {
  LabInspectResult,
  LabListResult,
  LabResolveFailure
} from "./labs.js";
import { runLabPreflight, type LabPreflightReachabilityMode, type LabPreflightResult } from "./lab-preflight.js";
import { runLab, resolveLabDryRun, selectLabBackend } from "./lab-engine.js";
import type { RunLabProvenance } from "./run-status.js";
import { loadAdapterScorer, type AdapterScorerModule } from "./adapter-scorer-loader.js";
import type { LabBackend } from "./lab-engine.js";
import type { RunScorerProvenance } from "./run.js";
import { CUA_ACTOR_LAB_SCHEMA } from "./cua-actor-lab.js";
import type { CuaActorLabErrorCode, CuaActorLabResult } from "./cua-actor-lab.js";
import type { ScriptedBrowserLabResult } from "./scripted-browser-lab.js";
import type { TerminalProductLabResult, TerminalProductLabHooks } from "./e2b-terminal-lab.js";
import type { BrowserLabAdapterHooks } from "./adapter-extension.js";
import type { SharedWorldLabResult } from "./shared-world-lab.js";
import type { ConcurrentSharedWorldLabResult } from "./concurrent-shared-world-lab.js";
import type { LabConfig } from "./lab-config.js";
import { openTarget, renderObserver, serveObserver } from "./observer.js";
import type { ObserverResult, ObserverServer } from "./observer.js";
import { serveObserverStatic } from "./observer-static.js";
import {
  SERVE_SCHEMA,
  serveObserverLibrary
} from "./observer-serve.js";
import type { ServeErrorCode, ServeResult } from "./observer-serve.js";
import { startExposedObserver, validateExposure } from "./serve-exposure.js";
import type { ExposureRequest } from "./serve-exposure.js";
import { ServeTunnelError } from "./serve-tunnel.js";
import type { ServeTunnel } from "./serve-tunnel.js";
import {
  DEFAULT_OSS_REPOS,
  runOssLab
} from "./oss-lab.js";
import type { OssLabResult } from "./oss-lab.js";
import {
  cleanupOssMetaLabSandboxes,
  cleanupStaleOssMetaLabSandboxes,
  runOssMetaLab,
  startOssMetaLabLiveRefresh
} from "./oss-meta-lab.js";
import type { OssMetaLabResult } from "./oss-meta-lab.js";
import {
  cleanupRun,
  doctor,
  listRuns,
  readReview,
  runDryRun,
  verifyRun
} from "./run.js";
import { reclaimRunSandboxes, type ReclaimResult } from "./reclaim.js";
import { RunIndexCache, readRunIndex } from "./run-index.js";
import { readLabSummary } from "./lab-summary.js";
import { readProjectState } from "./tui-project.js";
import { openObserverArtifact, stopRun, TUI_ACTION_SCHEMA } from "./tui-actions.js";
import { readRunDetail } from "./run-detail.js";
import { launchRun, readLaunchLogTail } from "./tui-launch.js";
import { TUI_MIN_NODE_MAJOR, nodeSupportsTui, tuiBundleUrl, type TuiModule} from "./tui-contract.js";
import { forTerminal } from "./terminal-encoding.js";
import { detectAgentSession } from "./agent-session.js";
import { runCommsCatchHost } from "./comms-catch-host.js";
import { DEFAULT_SANDBOX_CATCH_PORT } from "./comms-sandbox-catch.js";
import type {
  DoctorResult,
  CleanupResult,
  RunsResult,
  RunResult,
  VerifyResult
} from "./run.js";

export const CLI_RESPONSE_SCHEMA = "humanish.cli-response.v1";

function readCliVersion(): string {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "0.0.0";
}

const CLI_VERSION = readCliVersion();

export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  setExitCode(code: number): void;
}

// The single structured envelope for errors the command-boundary catch-all
// produces when an action handler throws or rejects unexpectedly (see
// HumanishCommand below). Reuses CLI_RESPONSE_SCHEMA so every humanish.cli-response.v1
// document on stdout, planned or not, carries the same schema string.
export interface UnexpectedErrorEnvelope {
  schema: typeof CLI_RESPONSE_SCHEMA;
  ok: false;
  error: {
    code: "HUMANISH_UNEXPECTED";
    message: string;
  };
}

// Shared so the ~20 leaf commands that declare their own --json flag cannot drift
// from each other in wording.
const JSON_OPTION_DESCRIPTION = "Print a machine-readable JSON response.";

interface LabCommandOptions {
  codexAppServer?: boolean | undefined;
  count?: string | undefined;
  cwd: string;
  detach?: boolean | undefined;
  dryRun?: boolean | undefined;
  envFile?: string | undefined;
  json?: boolean | undefined;
  keep?: boolean | undefined;
  lanes?: string | undefined;
  limit?: string | undefined;
  open?: boolean | undefined;
  port?: string | undefined;
  redactRepos?: boolean | undefined;
  repo?: string[] | undefined;
  repos?: string | undefined;
  rerunFailedFrom?: string | undefined;
  runId?: string | undefined;
  /** #316: repo-relative path to an adopter scorer module; overrides review.scorer.ref when set. */
  scorer?: string | undefined;
  sims?: string | undefined;
  // watch --expose surface (tunnel-edge auth). Only the CUA backend live-serves a run; other
  // backends refuse exposure. See runCuaBackend + validateExposure.
  expose?: boolean | undefined;
  tunnel?: "ngrok" | undefined;
  tunnelDomain?: string | undefined;
  oauth?: "google" | undefined;
  allowEmail?: string[] | undefined;
  allowDomain?: string[] | undefined;
  publicUrl?: string | undefined;
  safe?: boolean | undefined;
}

interface CodexAppServerUiCliResult {
  schema: "humanish.codex-app-server-ui-result.v1";
  ok: boolean;
  cwd: string;
  reason: string;
  stateFile?: string;
  status?: string;
  url?: string;
  error?: {
    code: "HUMANISH_CODEX_APP_SERVER_PROMPT_REQUIRED" | "HUMANISH_INVALID_PORT" | "HUMANISH_INVALID_TIMEOUT";
    message: string;
  };
}

// Transcode ONLY for a terminal. A pipe carries bytes to another program — mangling those would
// corrupt a JSON payload for a reader that handles UTF-8 perfectly well — while a TTY carries them
// to a font, through a locale that may not decode them. See src/terminal-encoding.ts for what a
// participant actually read back off the screen.
const forStream = (stream: NodeJS.WriteStream, text: string): string =>
  stream.isTTY === true ? forTerminal(text) : text;

const defaultIo: CliIo = {
  writeOut: (text) => process.stdout.write(forStream(process.stdout, text)),
  writeErr: (text) => process.stderr.write(forStream(process.stderr, text)),
  setExitCode: (code) => {
    process.exitCode = code;
  }
};

// Command boundary catch-all (fix set point 1): every leaf command is created
// through HumanishCommand.createCommand, and HumanishCommand.action wraps the caller's
// handler so an uncaught throw or promise rejection can never escape as a raw
// Node crash. On failure it emits the same structured envelope --json commands
// already promise (schema humanish.cli-response.v1, ok: false, error.code
// HUMANISH_UNEXPECTED) or a single concise stderr line otherwise, then sets exit
// code 2 through the existing CliIo.setExitCode seam. This is the single seam:
// none of the ~20 .action() handlers below need their own try/catch for this.

/**
 * Record that a command ran. Anonymous, allowlisted, and unable to affect the command: it is not
 * awaited, it is bounded by its own timeout, and every failure inside it is swallowed.
 *
 * The first time it would send anything, it prints the notice first — the convention Next.js and
 * the Vercel CLI set is that collection is default-on but never silent.
 */
/**
 * Print the disclosure the first time humanish would collect anything, and remember that it was
 * shown. AWAITED by the caller: if this loses the race with process exit, a default-on collector
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

async function recordCommandTelemetry(
  command: Command,
  ok: boolean,
  durationMs: number,
  exitCode: number
): Promise<void> {
  try {
    // `telemetry` itself is never measured: instrumenting the opt-out would be indecent.
    const name = commandPath(command);
    if (name.startsWith("telemetry")) return;
    if (disabledByEnvironment(process.env)) return;
    // Our own checkout never reports. See inHumanishCheckout for the measured reason.
    if (inHumanishCheckout(process.cwd(), (p) => readFileSync(p, "utf8"))) return;
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
        ...studyFactsFor(command),
        command: name,
        ok: ok && exitCode === 0,
        exitCode,
        durationBucket: durationBucket(durationMs)
      }
    });
    if (process.env.HUMANISH_TELEMETRY_DEBUG !== undefined && process.env.HUMANISH_TELEMETRY_DEBUG !== "") {
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
 * process alive (#581). A live terminal run wrote its result 64 s in and the CLI stayed up for
 * sixteen more minutes; nothing in the bundle could say what held it, and an in-process probe of
 * the lane found nothing of ours. This is the one line that answers it next time: the resource
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
    const summary = [...counts.entries()].map(([type, count]) => `${type}×${count}`).join(", ") || "none";
    io.writeErr(`humanish debug: active resources after \`${commandPath(command) || "humanish"}\` settled: ${summary}\n`);
  }).unref?.();
}

/** `lab run`, not `run`, so the two are distinguishable — and nothing else from the invocation. */
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
      // ONE emission point for every command, at the same seam that already catches every throw.
      // Twenty .action() handlers each remembering to record a metric is twenty chances to forget
      // one, and a funnel with a hole in it is worse than no funnel.
      const startedAt = Date.now();
      lastExitCode = 0;
      // The NOTICE is awaited; the SEND is not. They have opposite requirements: disclosure must
      // never be lost (a silent default-on collector is indefensible), and a metric must never
      // make anyone wait. The first version put both in the fire-and-forget path, and the notice
      // lost the race with process exit — a real participant ran this build and never saw it.
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
            () => { finish(true); },
            (error: unknown) => {
              reportUnexpectedActionError(this, cliIo, error);
              finish(false);
            }
          );
        }
        // A synchronous action still has to let the disclosure land before the process exits.
        return noticed.then(() => { finish(true); });
        return result;
      } catch (error) {
        reportUnexpectedActionError(this, cliIo, error);
        return undefined;
      }
    };
    return super.action(wrapped);
  }
}

// Fix set point 1 (general guard): writeResult marks its own invocation's root
// command the moment it flushes a result to stdout. Keyed by the root Command
// of the invocation (a fresh object every createProgram() call) rather than a
// module-level boolean, so tests that construct multiple `createProgram()`
// instances in the same process never see one instance's writes bleed into
// another's, and nothing needs explicit cleanup -- the entry is released once
// that Command tree is garbage collected.
const invocationEnvelopeWritten = new WeakSet<Command>();

function rootCommandOf(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function markInvocationEnvelopeWritten(command: Command): void {
  invocationEnvelopeWritten.add(rootCommandOf(command));
}

function invocationEnvelopeAlreadyWritten(command: Command): boolean {
  return invocationEnvelopeWritten.has(rootCommandOf(command));
}

function reportUnexpectedActionError(command: Command, io: CliIo, error: unknown): void {
  const message = redactText(error instanceof Error ? error.message : String(error));

  if (wantsJson(command)) {
    if (invocationEnvelopeAlreadyWritten(command)) {
      // Some result already went to stdout for this invocation before the
      // failure landed -- e.g. `codex app-server --keep-open --json` writes its
      // "running" envelope via writeResult, then a later `await` can still
      // reject (codex-app-server-ui.ts's persistState() write can fail on
      // either branch of that command's completion handling). Appending a
      // second JSON document to stdout would break every JSON.parse(stdout)
      // consumer, so this failure goes to stderr instead, same as the non-json
      // branch below.
      io.writeErr(`HUMANISH_UNEXPECTED: ${message}\n`);
      io.setExitCode(2);
      return;
    }

    const envelope: UnexpectedErrorEnvelope = {
      schema: CLI_RESPONSE_SCHEMA,
      ok: false,
      error: {
        code: "HUMANISH_UNEXPECTED",
        message
      }
    };
    io.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    io.writeErr(`HUMANISH_UNEXPECTED: ${message}\n`);
  }

  io.setExitCode(2);
}


/** `unknown option '--x'` -> the sibling commands that DO declare `--x`. */
function commandsDeclaring(root: Command, flag: string): string[] {
  const found: string[] = [];
  const walk = (command: Command, trail: string[]): void => {
    const names = [...trail, command.name()];
    if (trail.length > 0 && command.options.some((option) => option.long === flag || option.short === flag)) {
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
 * command and says nothing the reader can act on. Silence is preserved when no sibling has it —
 * inventing a suggestion would be worse than none.
 */
export function withSiblingFlagHint(text: string, root: Command): string {
  const match = /unknown option '([^']+)'/.exec(text);
  if (match === null) return text;
  const owners = commandsDeclaring(root, match[1]!);
  if (owners.length === 0) return text;
  // Truncation is REPORTED, never silent: a list that quietly drops owners would send a reader
  // looking in the wrong place and think it had answered them.
  const shown = owners.slice(0, 3);
  const list = shown.map((owner) => `\`humanish ${owner}\``).join(", ");
  const rest = owners.length - shown.length;
  const tail = rest > 0 ? ` (and ${rest} more)` : "";
  return `${text.replace(/\n+$/, "")}\n${match[1]} is an option of ${list}${tail}, not of this command.\n`;
}

export function createProgram(
  io: Partial<CliIo> & { keyDiscovery?: typeof discoverProviderKeys; tuiRuntime?: Partial<TuiRuntime> } = {}
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
    }
  };
  keyDiscoveryFn = io.keyDiscovery ?? discoverProviderKeys;
  tuiRuntime = { ...defaultTuiRuntime, ...io.tuiRuntime };
  const program = new HumanishCommand(undefined, cliIo);

  // Bare `humanish` orients instead of printing sixteen subcommands (#367). --help is untouched;
  // this is only what happens when no command was chosen at all.
  program.action(async (options: { json?: boolean }) => {
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
      // A rejected flag should name the command that WOULD have taken it. Found by a real
      // first-contact study (labs/first-contact.yaml): a participant reached for
      // `humanish run --no-open` by analogy with `lab run`, got a bare "unknown option", and
      // filed it as a documentation mismatch. The flag is genuinely absent — `run` opens
      // nothing — but "unknown" says that badly, because the reader's actual question is
      // "then where does it live?".
      outputError: (text, write) => write(withSiblingFlagHint(text, program))
    })
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish watch",
        "  humanish watch first-run",
        "  humanish watch --lab .humanish/labs/local.yaml",
        "  humanish watch --run latest --detach",
        "  humanish watch --json --no-open",
        "  humanish lab list",
        "  humanish lab run first-run --json --no-open",
        "  humanish verify --run latest --json",
        "",
        "Public-safety boundary:",
        "  Humanish must not commit or emit PII, PHI, secrets, keys, raw private transcripts,",
        "  private screenshots, or private upstream artifacts."
      ].join("\n")
    );

  registerInitCommand(program, cliIo);
  registerDoctorCommand(program, cliIo);
  registerTuiCommand(program, cliIo);
  registerTelemetryCommand(program, cliIo);
  registerKeysCommand(program, cliIo);
  registerRunCommand(program, cliIo);
  registerVerifyCommand(program, cliIo);
  registerCleanupCommand(program, cliIo);
  registerReviewCommand(program, cliIo);
  registerRunsCommand(program, cliIo);
  registerStatsCommand(program, cliIo);
  registerExportCommand(program, cliIo);
  registerCommsCommands(program, cliIo);
  registerReclaimCommand(program, cliIo);
  registerWatchCommand(program, cliIo);
  registerObserveCommand(program, cliIo);
  registerServeCommand(program, cliIo);
  registerCodexCommands(program, cliIo);
  registerLabCommands(program, cliIo);
  registerFeedbackCommands(program, cliIo);

  return program;
}

function registerInitCommand(parent: Command, io: CliIo): void {
  parent
    .command("init")
    .description("Set up committed humanish/ source files and ignored .humanish/ runtime state.")
    .summary("Set up humanish/ source and .humanish/ runtime state.")
    .option("--dry-run", "Print planned changes without writing files.")
    .option("--yes", "Apply safe generated changes without prompting.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; dryRun?: boolean; json?: boolean; yes?: boolean }, command) => {
      const initOptions = {
        cwd: options.cwd,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.yes === undefined ? {} : { yes: options.yes })
      };
      const result = await runInit(initOptions);

      if (wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok) {
        io.writeOut(formatInitHuman(result));
      } else {
        io.writeErr(formatInitHuman(result));
      }

      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerDoctorCommand(parent: Command, io: CliIo): void {
  parent
    .command("doctor")
    .description("Explain project readiness and missing Humanish setup.")
    .summary("Explain project readiness and missing setup.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await doctor(options.cwd);
      writeResult(command, io, result, formatDoctorHuman);
      // Behavioral change: was exit 1, every other structured command uses 2.
      io.setExitCode(result.ok ? 0 : 2);
    });
}

/**
 * The pieces of the outside world the `tui` command touches. Injectable for the same reason
 * `keyDiscovery` is: the refusals ARE the behavior worth testing, and a test cannot make a real
 * TTY, an old Node, or a missing bundle appear.
 */
export interface TuiRuntime {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  nodeVersion: string;
  /** Injected so a test can pose as an agent session without touching the real process env. */
  env: NodeJS.ProcessEnv;
  /** Resolves the bundle, or null when it is not present. */
  loadTui(bundle: URL): Promise<TuiModule | null>;
}

const defaultTuiRuntime: TuiRuntime = {
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  nodeVersion: process.version,
  loadTui: async (bundle) => {
    if (!existsSync(bundle)) return null;
    return (await import(bundle.href)) as TuiModule;
  }
};

let tuiRuntime: TuiRuntime = defaultTuiRuntime;

const TUI_RESULT_SCHEMA = "humanish.tui-result.v1";

interface TuiRefusal {
  schema: typeof TUI_RESULT_SCHEMA;
  ok: false;
  error: {
    code:
      | "HUMANISH_TUI_REQUIRES_TTY"
      | "HUMANISH_TUI_AGENT_SESSION"
      | "HUMANISH_TUI_UNSUPPORTED_NODE"
      | "HUMANISH_TUI_BUNDLE_MISSING";
    message: string;
  };
}

function refuseTui(command: Command, io: CliIo, refusal: TuiRefusal): void {
  if (wantsJson(command)) {
    io.writeOut(`${JSON.stringify(refusal, null, 2)}\n`);
  } else {
    io.writeErr(`${refusal.error.message}\n`);
  }
  markInvocationEnvelopeWritten(command);
  io.setExitCode(2);
}

/**
 * The stakeholder surface (#455). Every other command is written so an agent can drive it; this one
 * is the opposite — it takes the screen and waits for a person.
 *
 * That inversion is why it refuses rather than degrades. An agent that runs `humanish tui` with a
 * piped stdout has asked for something that cannot exist, and the useful answer is a structured
 * error naming the command that WOULD have answered the question. A TUI that quietly rendered
 * frames into a pipe would poison a transcript with escape codes and look like a hang.
 */
/**
 * `humanish telemetry status|enable|disable` — the opt-out the convention requires, plus a `status`
 * that prints the exact document that would be sent. "You can read what we collect" is what makes
 * default-on honest rather than merely lawful.
 */
function registerTelemetryCommand(parent: Command, io: CliIo): void {
  const telemetry = parent
    .command("telemetry")
    .description("Show or change anonymous usage collection.");

  telemetry
    .command("status", { isDefault: true })
    .description("What is collected, and whether it is on.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { json?: boolean }, command) => {
      const state = await readTelemetryState();
      const envOff = disabledByEnvironment(process.env);
      const sample = buildPayload({
        event: "cli_command",
        anonymousId: state.anonymousId,
        version: CLI_VERSION,
        properties: { command: "run", lab: "try-live", mode: "live", outcome: "passed", brain: "provider-key", durationBucket: "1-5m", ok: true }
      });
      const result = {
        schema: "humanish.telemetry-status.v1" as const,
        ok: true as const,
        enabled: state.enabled && !envOff,
        disabledBy: envOff ? "environment" : state.enabled ? undefined : "config",
        statePath: telemetryStatePath(),
        example: sample
      };
      if (options.json === true || wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.writeOut([
          `telemetry: ${result.enabled ? "on" : "off"}${envOff ? " (DO_NOT_TRACK / HUMANISH_TELEMETRY_DISABLED)" : ""}`,
          `state: ${result.statePath}`,
          "",
          "a complete example of what is sent — there are no other fields:",
          JSON.stringify(sample, null, 2),
          "",
          "never sent: labs you wrote, subjects, personas, missions, paths, run evidence, key names or values.",
          "",
          "humanish telemetry disable   turns it off"
        ].join("\n") + "\n");
      }
      markInvocationEnvelopeWritten(command);
    });

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    telemetry
      .command(name)
      .description(`Turn anonymous usage collection ${name === "enable" ? "on" : "off"}.`)
      .action(async (_options: unknown, command: Command) => {
        const state = await readTelemetryState();
        // Writing `noticed` here too: someone who has just made an explicit choice does not need
        // to be told about the choice next time.
        await writeTelemetryState({ ...state, enabled, noticed: true });
        io.writeOut(`telemetry ${enabled ? "enabled" : "disabled"}\n`);
        markInvocationEnvelopeWritten(command);
      });
  }
}

function registerTuiCommand(parent: Command, io: CliIo): void {
  parent
    .command("tui")
    .description("Open the interactive terminal surface for browsing labs and runs (humans only).")
    .summary("Open the interactive terminal surface.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--force", "Open it anyway in a session that looks like an agent's.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; force?: boolean; json?: boolean }, command) => {
      const { stdin, stdout } = tuiRuntime;

      // An agent runner, even with a real terminal. `codex exec` allocates a PTY for the commands
      // it runs, so the TTY check below passes and the surface used to open: a study watched an
      // agent navigate the labs list and start a run it did not mean to start
      // (labs/handed-a-human-surface.yaml). A TTY says a terminal exists, not that anyone is
      // reading it. `--force` is the escape for the person who really is at this keyboard —
      // capturing frames from inside an agent session is exactly that case.
      const agent = options.force === true ? undefined : detectAgentSession(tuiRuntime.env);
      if (agent !== undefined) {
        refuseTui(command, io, {
          schema: TUI_RESULT_SCHEMA,
          ok: false,
          error: {
            code: "HUMANISH_TUI_AGENT_SESSION",
            message:
              `humanish tui is a surface for a person, and ${agent.marker} says this session belongs to ${agent.runner}. `
              + "It renders frames of escape codes into a transcript, and its keys can start runs. "
              + "`humanish runs --json` lists runs, `humanish lab list --json` lists the studies in this project, "
              + "and `humanish lab run <lab> --json` starts one. If you are a person at this keyboard, add --force."
          }
        });
        return;
      }

      if (stdin.isTTY !== true || stdout.isTTY !== true) {
        refuseTui(command, io, {
          schema: TUI_RESULT_SCHEMA,
          ok: false,
          error: {
            code: "HUMANISH_TUI_REQUIRES_TTY",
            message:
              "humanish tui needs an interactive terminal. For scripted or agent use, `humanish runs --json` lists the same runs and `humanish lab run --json` starts one."
          }
        });
        return;
      }

      if (!nodeSupportsTui(tuiRuntime.nodeVersion)) {
        refuseTui(command, io, {
          schema: TUI_RESULT_SCHEMA,
          ok: false,
          error: {
            code: "HUMANISH_TUI_UNSUPPORTED_NODE",
            message: `humanish tui needs Node ${TUI_MIN_NODE_MAJOR} or newer (this is ${tuiRuntime.nodeVersion}). Every other humanish command still works on this runtime.`
          }
        });
        return;
      }

      // The Ink app ships as a pre-built bundle beside the compiled CLI and is loaded ONLY here, so
      // no agent-facing command pays its parse cost.
      const bundle = tuiBundleUrl(import.meta.url);
      const runIndexCache = new RunIndexCache();
      const loaded = await tuiRuntime.loadTui(bundle);
      if (loaded === null) {
        refuseTui(command, io, {
          schema: TUI_RESULT_SCHEMA,
          ok: false,
          error: {
            code: "HUMANISH_TUI_BUNDLE_MISSING",
            message: `The terminal surface bundle is missing at ${bundle.pathname}. In a checkout, run \`pnpm build\`; in an install, this package is incomplete — please report it.`
          }
        });
        return;
      }

      const exitCode = await loaded.startTui({
        cwd: resolve(options.cwd),
        version: { cli: CLI_VERSION },
        capabilities: {
          // One cache for the life of the surface: it refreshes on a cadence, and re-walking every
          // run tree each tick is the cost this index exists to avoid.
          readRunIndex: (target, readOptions) => readRunIndex(target, { ...readOptions, cache: runIndexCache }),
          listLabs: listLabManifests,
          startRun: launchRun,
          readLaunchLog: readLaunchLogTail,
          readRunDetail,
          readLabSummary,
          readProjectState,
          openObserver: openObserverArtifact,
          reclaimRun: (target, runId) => reclaimRunSandboxes(target, runId),
          stopRun,
          initProject: async (target: string) => {
            const result = await runInit({ cwd: target, yes: true });
            return result.ok
              ? {
                  schema: TUI_ACTION_SCHEMA,
                  ok: true as const,
                  message: `set up humanish here — ${result.changes.filter((change) => change.action !== "skip").length} files written`
                }
              : {
                  schema: TUI_ACTION_SCHEMA,
                  ok: false as const,
                  message: result.error?.message ?? "humanish init could not set this directory up"
                };
          }
        },
        stdin,
        stdout
      });
      // The surface owned the screen; it has already told the operator whatever there was to say.
      markInvocationEnvelopeWritten(command);
      io.setExitCode(exitCode);
    });
}

// The discovery fn the env seam calls; injectable via createProgram for hermetic CLI tests.
let keyDiscoveryFn: typeof discoverProviderKeys = discoverProviderKeys;

const KEYS_RESULT_SCHEMA = "humanish.keys-result.v1";

interface KeysResult {
  schema: typeof KEYS_RESULT_SCHEMA;
  ok: boolean;
  action: "set" | "unset" | "list";
  /** The user store path (with values never included anywhere in this envelope). */
  store: string;
  /** `list`: the names present in the store. `set`/`unset`: the affected name. */
  names: string[];
  message: string;
}

function formatKeysHuman(result: KeysResult): string {
  const lines = [`humanish keys ${result.ok ? "ok" : "failed"}`, `store: ${result.store}`, result.message];
  if (result.action === "list" && result.names.length > 0) {
    for (const name of result.names) lines.push(`- ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Read one secret line: from a piped stdin when --stdin, else a hidden TTY prompt. */
async function readSecretValue(useStdin: boolean, promptLabel: string, io: CliIo): Promise<string | null> {
  if (useStdin || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text.length > 0 ? text : null;
  }
  io.writeErr(`${promptLabel} (input hidden): `);
  return await new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (key: string): void => {
      if (key === "\u0003") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        io.writeErr("\n");
        resolve(value.trim().length > 0 ? value.trim() : null);
        return;
      }
      if (key === "\u007f" || key === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += key;
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

function registerKeysCommand(parent: Command, io: CliIo): void {
  const keys = parent
    .command("keys")
    .description("Manage the humanish user-level key store used by provider-key discovery (#436).")
    .summary("Manage the user-level provider key store.");

  keys
    .command("set")
    .argument("<vendor-or-name>", "A vendor alias (openai, e2b, anthropic, github) or a raw ENV_NAME.")
    .description("Store one provider key in the user store (0600), prompted with hidden input.")
    .option("--stdin", "Read the value from stdin instead of prompting (for agents/pipes).")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (vendorOrName: string, options: { stdin?: boolean; json?: boolean }, command) => {
      const name = resolveKeyName(vendorOrName);
      const storePath = userKeyStorePath(process.env);
      if (name === null) {
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA, ok: false, action: "set", store: storePath, names: [],
          message: `Not a vendor alias or valid env name: ${vendorOrName}. Vendors: openai, e2b, anthropic, github.`
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(2);
        return;
      }
      const value = await readSecretValue(options.stdin === true, `Value for ${name}`, io);
      if (value === null) {
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA, ok: false, action: "set", store: storePath, names: [name],
          message: "No value provided; nothing written."
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(2);
        return;
      }
      try {
        const written = setUserKey(name, value, process.env);
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA, ok: true, action: "set", store: written.path, names: [name],
          message: `${name} stored (0600). Live commands resolve it automatically; remove with "humanish keys unset ${name}".`
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(0);
      } catch (error) {
        const result: KeysResult = {
          schema: KEYS_RESULT_SCHEMA, ok: false, action: "set", store: storePath, names: [name],
          message: error instanceof Error ? error.message : "Failed to write the key store."
        };
        writeResult(command, io, result, formatKeysHuman);
        io.setExitCode(2);
      }
    });

  keys
    .command("unset")
    .argument("<vendor-or-name>", "A vendor alias or raw ENV_NAME to remove from the store.")
    .description("Remove one key from the user store.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (vendorOrName: string, _options: { json?: boolean }, command) => {
      const name = resolveKeyName(vendorOrName);
      const storePath = userKeyStorePath(process.env);
      const had = name !== null && unsetUserKey(name, process.env);
      const result: KeysResult = {
        schema: KEYS_RESULT_SCHEMA, ok: name !== null, action: "unset", store: storePath,
        names: name === null ? [] : [name],
        message: name === null
          ? `Not a vendor alias or valid env name: ${vendorOrName}.`
          : had ? `${name} removed from the store.` : `${name} was not in the store; nothing changed.`
      };
      writeResult(command, io, result, formatKeysHuman);
      io.setExitCode(name === null ? 2 : 0);
    });

  keys
    .command("list")
    .description("List the NAMES stored in the user store. Values are never printed.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (_options: { json?: boolean }, command) => {
      const storePath = userKeyStorePath(process.env);
      const names = listUserKeys(process.env);
      const result: KeysResult = {
        schema: KEYS_RESULT_SCHEMA, ok: true, action: "list", store: storePath, names,
        message: names.length === 0
          ? "The store is empty. Add a key with `humanish keys set <vendor>`."
          : `${names.length} key name(s) stored. Values are never printed.`
      };
      writeResult(command, io, result, formatKeysHuman);
      io.setExitCode(0);
    });
}

function registerRunCommand(parent: Command, io: CliIo): void {
  parent
    .command("run")
    .argument("[lab]", "Optional lab id or .yaml path.")
    .description("Run a lab (or a synthetic dry-run bundle). The everyday command.")
    .summary("Run a persona/scenario simulation or dry-run bundle.")
    .option("--dry-run", "Generate contract proof without browser, keys, or provider spend.")
    // `humanish run <lab>` and `humanish lab run <lab>` are the SAME operation on the same
    // dispatcher, but this one used to forward four options while its sibling forwarded all of
    // them — so `humanish run first-run --no-open` failed while `lab run` accepted it. A
    // participant hit exactly that and filed it as a documentation mismatch. Same command, same
    // flags (CLIG: "be consistent across subcommands").
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without an attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--app-url <url>", "Capture live desktop/mobile browser evidence against a running loopback app URL.")
    .addOption(new Option("--actor <actor>", "Explicit live actor to run.").choices(["codex-tui", "codex-exec", "codex-app-server"]))
    .option("--sims <count>", "Simulation count. Codex exec runs requested lanes with bounded concurrency; Codex TUI supports 1.")
    .option("--timeout-ms <ms>", "Local actor timeout in milliseconds.", String(900_000))
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load a local env file for this run without persisting values.")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (lab: string | undefined, options: {
      actor?: string;
      appUrl?: string;
      cwd: string;
      dryRun?: boolean;
      envFile?: string;
      json?: boolean;
      runId?: string;
      sims?: string;
      timeoutMs?: string;
    }, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      if (lab) {
        if (options.appUrl !== undefined || options.actor !== undefined) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_APP_URL_OPTION_CONFLICT",
              message: "Use lab manifests with lab-compatible options only; --app-url and --actor belong to direct `humanish run`."
            }
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        await runLabCommand({
          command,
          io,
          lab,
          mode: "run",
          // Forwarded wholesale, exactly as `lab run` does. Cherry-picking a subset here is what
          // made the two commands disagree in the first place.
          options: options as LabCommandOptions
        });
        return;
      }

      const simCount = options.sims === undefined ? undefined : parsePositiveInteger(options.sims);
      const timeoutMs = options.timeoutMs === undefined ? undefined : parseTimeoutMs(options.timeoutMs);
      if (options.sims !== undefined && simCount === null) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_INVALID_SIM_COUNT",
            message: "--sims must be a positive integer."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (options.timeoutMs !== undefined && timeoutMs === null) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_INVALID_TIMEOUT",
            message: "--timeout-ms must be an integer between 1 and 3600000."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }

      const result = await runDryRun({
        cwd: options.cwd,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(simCount === undefined || simCount === null ? {} : { simCount }),
        ...(timeoutMs === undefined || timeoutMs === null ? {} : { timeoutMs })
      });
      writeResult(command, io, result, formatRunHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerVerifyCommand(parent: Command, io: CliIo): void {
  parent
    .command("verify")
    .description("Validate a run bundle and public-safety gates.")
    .summary("Validate a run bundle and public-safety gates.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await verifyRun(options.cwd, options.run);
      writeResult(command, io, result, formatVerifyHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerCleanupCommand(parent: Command, io: CliIo): void {
  parent
    .command("cleanup")
    .description("Inspect recorded resource evidence and write cleanup.json; stored ids do not authorize provider mutation.")
    .summary("Write a resource cleanup inspection receipt.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await cleanupRun(options.cwd, options.run);
      writeResult(command, io, result, formatCleanupHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerReviewCommand(parent: Command, io: CliIo): void {
  parent
    .command("review")
    .description("Build a review packet from verified run evidence.")
    .summary("Build a review packet from verified run evidence.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await readReview(options.cwd, options.run);
      writeResult(command, io, result, (value) => `${JSON.stringify(value, null, 2)}\n`);
      io.setExitCode("ok" in result && result.ok === false ? 2 : 0);
    });
}

function registerExportCommand(parent: Command, io: CliIo): void {
  parent
    .command("export")
    .description("Write one self-contained .html of a run's Observer with screenshots inlined (#471). Verify and the share_ready gate run inside; a local_only bundle exports only with --local-only, watermarked.")
    .summary("Export one run as a single shareable .html file.")
    .option("--run <id>", "Run id or 'latest'.", "latest")
    .option("--out <path>", "Where to write the file. Defaults to .humanish/exports/<runId>.html.")
    .option("--local-only", "Export a bundle that is not share_ready, with a LOCAL ONLY banner in the file.")
    .option("--max-bytes <n>", "Refuse an export larger than this.", String(DEFAULT_EXPORT_MAX_BYTES))
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string; out?: string; localOnly?: boolean; maxBytes: string }, command) => {
      const maxBytes = Number.parseInt(options.maxBytes, 10);
      const result = await exportRun(options.cwd, options.run, {
        ...(options.out === undefined ? {} : { out: options.out }),
        ...(options.localOnly === undefined ? {} : { localOnly: options.localOnly }),
        ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {})
      });
      writeResult(command, io, result, formatExportHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerStatsCommand(parent: Command, io: CliIo): void {
  parent
    .command("stats")
    .description("Cost, outcome, and duration roll-ups across run history (#472). Estimates stay labelled; unknown costs count as unknown.")
    .summary("Roll up cost, outcomes, and durations across runs.")
    .option("--lab <id>", "Only runs from this lab id.")
    .option("--since <date>", "Only runs that started on or after this ISO date or datetime.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; lab?: string; since?: string }, command) => {
      const result = await computeStats(options.cwd, {
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        ...(options.since === undefined ? {} : { since: options.since })
      });
      writeResult(command, io, result, formatStatsHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerRunsCommand(parent: Command, io: CliIo): void {
  parent
    .command("runs")
    .description("List local Humanish runs and latest pointers.")
    .summary("List local Humanish runs and latest pointers.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await listRuns(options.cwd);
      writeResult(command, io, result, formatRunsHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerCommsCommands(parent: Command, io: CliIo): void {
  const comms = parent
    .command("comms")
    .description("Off-app comms surfaces (email/SMS the app under test sends).")
    .summary("Off-app comms surfaces.");

  comms
    .command("catch")
    .description("Run the email catch on THIS host so humanish can study an app it does not provision (#328). Your app posts its email sends here; the persona opens /inbox; humanish drains GET /deliveries and writes digest-only evidence. Point your lab's comms.email.external.catchBaseUrl at this server.")
    .summary("Run the adopter-hosted email catch.")
    .option("--port <port>", "Port for capture + inbox (default 8025).", String(DEFAULT_SANDBOX_CATCH_PORT))
    .option("--dir <path>", "Directory for the deliveries log and rendered inbox.", ".humanish/comms-catch")
    .option("--token <value>", "Require this bearer token on GET /deliveries (recommended when reachable off-host).")
    .option(
      "--inbox-port <port>",
      "Also serve a READ-ONLY inbox listener on 0.0.0.0:<port>, so a persona on another machine can open /inbox. Without it the catch stays loopback-only."
    )
    .option(
      "--recipient <address>",
      "Only render mail sent to this address (repeatable). Default: render whatever the app actually mailed.",
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .action(async (options: { port: string; dir: string; token?: string; inboxPort?: string; recipient?: string[] }) => {
      const port = Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65_534) {
        io.writeErr("--port must be an integer between 1 and 65534.\n");
        io.setExitCode(2);
        return;
      }
      let inboxPort: number | undefined;
      if (options.inboxPort !== undefined) {
        inboxPort = Number.parseInt(options.inboxPort, 10);
        if (!Number.isInteger(inboxPort) || inboxPort <= 0 || inboxPort > 65_534) {
          io.writeErr("--inbox-port must be an integer between 1 and 65534.\n");
          io.setExitCode(2);
          return;
        }
        if (inboxPort === port) {
          io.writeErr("--inbox-port must differ from --port (the capture listener is loopback-only; the inbox listener is not).\n");
          io.setExitCode(2);
          return;
        }
      }
      await runCommsCatchHost(
        {
          port,
          dir: options.dir,
          ...(options.token ? { token: options.token } : {}),
          ...(inboxPort === undefined ? {} : { inboxPort }),
          ...(options.recipient && options.recipient.length > 0 ? { recipients: options.recipient } : {})
        },
        io
      );
    });
}

function registerReclaimCommand(parent: Command, io: CliIo): void {
  parent
    .command("reclaim")
    .description("Kill an interrupted run's sandboxes by their journaled exact ids (the #358 salvage path — reads the run's sandbox-receipts.ndjson; never enumerates the E2B account). Needs E2B_API_KEY in the environment.")
    .summary("Reclaim an interrupted run's sandboxes by recorded id.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--run <id>", "Run id, or 'latest'.", "latest")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; run: string; json?: boolean }, command) => {
      const result = await reclaimRunSandboxes(options.cwd, options.run);
      writeResult(command, io, result, formatReclaimHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function formatReclaimHuman(result: ReclaimResult): string {
  const lines: string[] = [];
  lines.push(`Reclaim ${result.runId}: ${result.ok ? "ok" : "FAILED"} — ${result.receiptCount} sandbox receipt(s).`);
  for (const outcome of result.outcomes) {
    lines.push(`  ${outcome.sandboxId} (${outcome.laneId}): ${outcome.state}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.error) lines.push(`  error: ${result.error.message}`);
  return lines.join("\n");
}

function registerCodexCommands(parent: Command, io: CliIo): void {
  const codex = parent
    .command("codex")
    .description("Run Codex-native Humanish integration surfaces.")
    .summary("Run Codex-native Humanish integration surfaces.");

  codex
    .command("app-server")
    .description("Run a browser-visible Codex app-server actor surface and write redacted protocol artifacts.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--prompt <text>", "Prompt to submit to Codex app-server.")
    .option("--prompt-file <path>", "Read the Codex app-server prompt from a file.")
    .option("--run-root <path>", "Artifact directory for redacted app-server evidence.")
    .option("--state-file <path>", "State JSON file for external observers.")
    .option("--timeout-ms <ms>", "Actor timeout in milliseconds.", String(900_000))
    .option("--port <port>", "Local browser UI port.", "0")
    .option("--model <model>", "Optional Codex model override.")
    .addOption(new Option("--sandbox <mode>", "Turn sandbox policy.").choices(["read-only", "workspace-write", "danger-full-access"]).default("read-only"))
    .option("--actor-command <command>", "Override app-server command. Defaults to codex app-server --listen stdio://.")
    .option("--keep-open", "Keep the browser UI process alive after the actor finishes.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: {
      actorCommand?: string;
      cwd: string;
      json?: boolean;
      keepOpen?: boolean;
      model?: string;
      port: string;
      prompt?: string;
      promptFile?: string;
      runRoot?: string;
      sandbox: "read-only" | "workspace-write" | "danger-full-access";
      stateFile?: string;
      timeoutMs: string;
    }, command) => {
      const timeoutMs = parseTimeoutMs(options.timeoutMs);
      const port = parseObserverPort(options.port);
      if (timeoutMs === null) {
        const result = codexAppServerUiError(options.cwd, "HUMANISH_INVALID_TIMEOUT", "--timeout-ms must be an integer between 1 and 3600000.");
        writeResult(command, io, result, formatCodexAppServerUiHuman);
        io.setExitCode(2);
        return;
      }
      if (port === null) {
        const result = codexAppServerUiError(options.cwd, "HUMANISH_INVALID_PORT", "--port must be an integer between 0 and 65535.");
        writeResult(command, io, result, formatCodexAppServerUiHuman);
        io.setExitCode(2);
        return;
      }

      const prompt = await readCodexAppServerPrompt(options);
      if (!prompt) {
        const result = codexAppServerUiError(options.cwd, "HUMANISH_CODEX_APP_SERVER_PROMPT_REQUIRED", "Provide --prompt or --prompt-file.");
        writeResult(command, io, result, formatCodexAppServerUiHuman);
        io.setExitCode(2);
        return;
      }

      const controller = await startCodexAppServerUi({
        ...(options.actorCommand === undefined ? {} : { actorCommand: options.actorCommand }),
        cwd: options.cwd,
        keepOpen: options.keepOpen === true,
        ...(options.model === undefined ? {} : { model: options.model }),
        port,
        prompt,
        ...(options.runRoot === undefined ? {} : { runRoot: options.runRoot }),
        sandbox: options.sandbox,
        ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
        timeoutMs
      });

      const initial = {
        schema: "humanish.codex-app-server-ui-result.v1" as const,
        ok: true,
        cwd: resolve(options.cwd),
        stateFile: controller.stateFile,
        url: controller.url,
        status: controller.initialState.status,
        reason: controller.initialState.reason
      };
      if (options.keepOpen === true) {
        writeResult(command, io, initial, formatCodexAppServerUiHuman);
        io.setExitCode(0);
        try {
          // Local hardening for the known double-envelope path: the "running"
          // envelope above has already reached stdout, so a rejection here
          // (codex-app-server-ui.ts's persistState() write can fail on either
          // branch of session completion) must not go through the
          // command-boundary catch-all's --json branch, which would otherwise
          // append a second JSON document to stdout. Handling it here directly
          // means this known path stays correct even if that general guard is
          // ever weakened; it does not replace it.
          await controller.completion;
          await new Promise<void>((resolveWait) => {
            process.once("SIGINT", () => {
              void controller.close().finally(resolveWait);
            });
          });
        } catch (error) {
          io.writeErr(`HUMANISH_UNEXPECTED: ${redactText(error instanceof Error ? error.message : String(error))}\n`);
          io.setExitCode(2);
        }
        return;
      }

      const completed = await controller.completion;
      const output = codexAppServerUiResultFromState(completed);
      writeResult(command, io, output, formatCodexAppServerUiHuman);
      io.setExitCode(output.ok ? 0 : 2);
    });
}

function registerWatchCommand(parent: Command, io: CliIo): void {
  parent
    .command("watch")
    .argument("[lab]", "Optional lab id or .yaml path to run and observe.")
    .description("Run sims, open the observer, and keep the shell attached.")
    .summary("Run sims, open the observer, keep the shell attached.")
    .option("--lab <id-or-path>", "Explicit lab id or .yaml path.")
    .option("--run <id>", "Watch an existing run id or latest pointer.")
    .option("--dry-run", "Lab only: render contract evidence without live provider spend.")
    .option("--codex-app-server", "Lab only: use Codex app-server client mode for OSS headed desktops.")
    .option("--sims <count>", "Start a fresh synthetic run with this many sims before rendering. Defaults to 4 when --run is omitted.")
    .option("--count <count>", "Lab only: override headed desktop lane count.")
    .option("--limit <count>", "Lab only: override smoke lab repo limit.")
    .option("--repo <owner/repo>", "Lab only: GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--repos <owner/repo,...>", "Lab only: comma-separated GitHub repo slugs.")
    .option("--redact-repos", "Lab only: redact repo labels in durable artifacts.")
    .option("--no-redact-repos", "Lab only: persist repo labels. Use only for public-safe runs.")
    .option("--keep", "Lab only: keep disposable clone sandbox for debugging.")
    .option("--scorer <path>", "Terminal/computer-use/shared-world labs only: repo-relative adopter scorer module (.mjs). Overrides review.scorer.ref. Executable code — review it as code.")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load a local env file for this watch without persisting values.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .addOption(new Option("--follow", "Deprecated; human output follows by default.").hideHelp())
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--expose", "CUA lab only: expose the live run through an authenticated edge so you can watch from a phone. Requires edge auth.")
    .addOption(new Option("--tunnel <provider>", "Spawn the external tunnel binary against the loopback port.").choices(["ngrok"]))
    .option("--tunnel-domain <domain>", "Reserved domain passed to ngrok as --url (e.g. observer.example.com). Requires --tunnel.")
    .addOption(new Option("--oauth <provider>", "Turn on ngrok edge OAuth. Requires --tunnel.").choices(["google"]))
    .option("--allow-email <addr>", "Edge OAuth allow rule: permit this email. Repeatable. Requires --oauth.", collectRepeated, [])
    .option("--allow-domain <domain>", "Edge OAuth allow rule: permit this domain. Repeatable. Requires --oauth.", collectRepeated, [])
    .option("--public-url <origin>", "Bring-your-own authed edge (Cloudflare Access/Tailscale/manual). Binds loopback and trusts your edge. Requires --expose.")
    .option("--safe", "Not applicable to watch: a live run is never share_ready, so --safe (a `serve` library filter) is rejected here. Restrict viewers with edge auth (--allow-email/--allow-domain).")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Happy path:",
        "  humanish watch",
        "  humanish watch first-run",
        "  humanish watch --lab .humanish/labs/local.yaml",
        "",
        "Watch a live CUA run from your phone (tunnel-edge auth):",
        "  humanish watch my-cua-lab --expose --tunnel ngrok --oauth google --allow-email you@example.com",
        "",
        "Agent/CI path:",
        "  humanish watch --json --no-open",
        "",
        "Existing evidence:",
        "  humanish watch --run latest --detach"
      ].join("\n")
    )
    .action(async (labArg: string | undefined, options: {
      cwd: string;
      count?: string;
      codexAppServer?: boolean;
      detach?: boolean;
      dryRun?: boolean;
      envFile?: string;
      follow?: boolean;
      json?: boolean;
      keep?: boolean;
      lab?: string;
      limit?: string;
      open?: boolean;
      port: string;
      redactRepos?: boolean;
      repo: string[];
      repos?: string;
      run?: string;
      runId?: string;
      scorer?: string;
      sims?: string;
      expose?: boolean;
      tunnel?: "ngrok";
      tunnelDomain?: string;
      oauth?: "google";
      allowEmail: string[];
      allowDomain: string[];
      publicUrl?: string;
      safe?: boolean;
    }, command) => {
      const lab = options.lab ?? labArg;
      if (options.lab !== undefined && labArg !== undefined) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_WATCH_OPTION_CONFLICT",
            message: "Use either positional lab or --lab, not both."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }

      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      if (lab) {
        if (options.run !== undefined) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_WATCH_OPTION_CONFLICT",
              message: "Use either a lab to start evidence or --run to watch existing evidence, not both."
            }
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        await runLabCommand({
          command,
          io,
          lab,
          mode: "watch",
          options: {
            cwd: options.cwd,
            ...(options.count === undefined ? {} : { count: options.count }),
            ...(options.codexAppServer === undefined ? {} : { codexAppServer: options.codexAppServer }),
            ...(options.detach === undefined ? {} : { detach: options.detach }),
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
            ...(options.keep === undefined ? {} : { keep: options.keep }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.open === undefined ? {} : { open: options.open }),
            port: options.port,
            ...(options.redactRepos === undefined ? {} : { redactRepos: options.redactRepos }),
            repo: options.repo,
            ...(options.repos === undefined ? {} : { repos: options.repos }),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
            ...(options.sims === undefined ? {} : { sims: options.sims }),
            ...(options.expose === undefined ? {} : { expose: options.expose }),
            ...(options.tunnel === undefined ? {} : { tunnel: options.tunnel }),
            ...(options.tunnelDomain === undefined ? {} : { tunnelDomain: options.tunnelDomain }),
            ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
            allowEmail: options.allowEmail,
            allowDomain: options.allowDomain,
            ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
            ...(options.safe === undefined ? {} : { safe: options.safe }),
            ...(options.json === undefined ? {} : { json: options.json })
          }
        });
        return;
      }

      // Exposure is only meaningful for a live CUA lab run (it serves the live desktop). The
      // non-lab watch path (existing evidence, or a fresh synthetic run) has no live desktop to
      // stream, so exposure flags there are refused rather than silently ignored — use `serve`.
      if (watchExposeRequested(options)) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_WATCH_OPTION_CONFLICT",
            message: "--expose/--tunnel/--oauth apply only to a live CUA lab run; to expose finished evidence use `humanish serve --expose`."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }

      const runOptionSource = typeof command.getOptionValueSource === "function"
        ? command.getOptionValueSource("run")
        : undefined;
      const runWasOmitted = runOptionSource === undefined || runOptionSource === "default";
      const simCount = options.sims === undefined ? undefined : parsePositiveInteger(options.sims);
      const port = parseObserverPort(options.port);
      if (options.sims !== undefined && simCount === null) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_INVALID_SIM_COUNT",
            message: "--sims must be a positive integer."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (!runWasOmitted && options.sims !== undefined) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_WATCH_OPTION_CONFLICT",
            message: "Use either --run to watch existing evidence or --sims to start a fresh run, not both."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (!runWasOmitted && options.runId !== undefined) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_WATCH_OPTION_CONFLICT",
            message: "--run-id only applies to fresh watch runs; remove --run or remove --run-id."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (port === null) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_INVALID_PORT",
            message: "--port must be an integer between 0 and 65535."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      const requestedSimCount = simCount ?? (runWasOmitted ? 4 : undefined);

      let runInput = options.run ?? "latest";
      if (requestedSimCount !== undefined && requestedSimCount !== null) {
        const runResult = await runDryRun({
          cwd: options.cwd,
          dryRun: true,
          simCount: requestedSimCount,
          ...(options.runId === undefined ? {} : { runId: options.runId })
        });

        if (!runResult.ok || !runResult.runId) {
          writeResult(command, io, runResult, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        runInput = runResult.runId;
      }

      const wantsMachine = wantsJson(command);
      const shouldOpen = options.open === false ? false : options.open === true ? true : !wantsMachine && process.stdout.isTTY === true;
      const wantsFollow = !wantsMachine && options.detach !== true && (options.follow !== false);
      const rendered = await renderObserver(options.cwd, runInput, { open: wantsFollow ? false : shouldOpen });
      let server: ObserverServer | null = null;
      let result = rendered;
      if (rendered.ok && wantsFollow) {
        server = await serveObserver(rendered, { open: shouldOpen, port });
        result = {
          ...rendered,
          observerUrl: server.url,
          serverUrl: server.url,
          opened: server.opened,
          ...(server.openCommand ? { openCommand: server.openCommand } : {}),
          warnings: [
            ...rendered.warnings,
            "Live observer server is polling observer-data.json with no-store caching.",
            ...(server.warning ? [server.warning] : [])
          ]
        };
      }
      writeResult(command, io, result, formatObserverHuman);
      io.setExitCode(result.ok ? 0 : 2);

      if (result.ok && server) {
        await followObserver(io, result, server);
      }
    });
}

function registerObserveCommand(parent: Command, io: CliIo): void {
  parent
    .command("observe")
    .description("Serve a finished run's Observer over loopback http://127.0.0.1 instead of a file:// path.")
    .summary("Serve a finished run's Observer over loopback http.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--port <port>", "Loopback port to bind on 127.0.0.1. Defaults to an ephemeral port.", "0")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Serve without opening a browser.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish observe",
        "  humanish observe --run latest",
        "  humanish observe --run <runId> --port 8732",
        "  humanish observe --no-open --json",
        "",
        "The server binds 127.0.0.1 only and exposes just the run's bundle directory.",
        "It stays attached until Ctrl-C; file:// security policy and live refresh are why",
        "loopback http is preferred over opening the index.html path directly."
      ].join("\n")
    )
    .action(async (options: {
      cwd: string;
      json?: boolean;
      open?: boolean;
      port: string;
      run: string;
    }, command) => {
      const port = parseObserverPort(options.port);
      if (port === null) {
        const result: RunResult = {
          schema: "humanish.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "HUMANISH_INVALID_PORT",
            message: "--port must be an integer between 0 and 65535."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }

      const rendered = await renderObserver(options.cwd, options.run, { open: false });
      if (!rendered.ok || !rendered.observerPath) {
        writeResult(command, io, rendered, formatObserverHuman);
        io.setExitCode(2);
        return;
      }

      // Serve the run's bundle directory so the Observer's relative artifact
      // links (../run.json, ../review.json, ../events.ndjson) resolve, then land
      // visitors on observer/index.html. The loopback root is the run dir; the
      // traversal guard still refuses anything above it (sibling runs, the
      // .humanish/runs/ parent, etc.).
      const observerIndexAbs = join(resolve(options.cwd), rendered.observerPath);
      const runDir = dirname(dirname(observerIndexAbs));

      const wantsMachine = wantsJson(command);
      const shouldOpen = options.open === false
        ? false
        : options.open === true
          ? true
          : !wantsMachine && process.stdout.isTTY === true;

      const server = await serveObserverStatic({ root: runDir, port, entryPath: "observer/index.html" });
      const openResult: { opened: boolean; command?: string; warning?: string } =
        shouldOpen ? openTarget(server.url) : { opened: false };

      const result: ObserverResult = {
        ...rendered,
        observerUrl: server.url,
        serverUrl: server.url,
        opened: openResult.opened,
        ...(openResult.command ? { openCommand: openResult.command } : {}),
        warnings: [
          ...rendered.warnings,
          "Observer is served read-only over loopback http on 127.0.0.1; only this run's bundle directory is exposed.",
          ...(openResult.warning ? [openResult.warning] : [])
        ]
      };

      writeResult(command, io, result, formatObserverHuman);
      io.setExitCode(0);

      await serveObserveUntilSignal(io, server, { json: wantsMachine });
    });
}

async function serveObserveUntilSignal(
  io: CliIo,
  server: { close: () => Promise<void>; url: string },
  options: { json: boolean }
): Promise<void> {
  // Keep the JSON envelope on stdout clean: route attach/stop chatter to stderr
  // for machine output, and to stdout for humans.
  const note = options.json ? io.writeErr : io.writeOut;
  note(`serving: ${server.url}\n`);
  note("serving: press Ctrl-C to stop\n");
  await new Promise<void>((resolveWait) => {
    const signals: WatchStopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<WatchStopSignal, () => void>();
    let stopping = false;

    const stop = (signal: WatchStopSignal) => {
      if (stopping) {
        return;
      }

      stopping = true;
      for (const [registeredSignal, handler] of handlers.entries()) {
        process.removeListener(registeredSignal, handler);
      }
      io.setExitCode(exitCodeForSignal(signal));

      void (async () => {
        try {
          await server.close();
        } catch (error: unknown) {
          io.writeErr(`observe cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }

        note("observe stopped\n");
        resolveWait();
      })();
    };

    for (const signal of signals) {
      const handler = () => stop(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

function registerServeCommand(parent: Command, io: CliIo): void {
  parent
    .command("serve")
    .description("Serve the local run library over loopback http, with optional tunnel-edge authenticated exposure.")
    .summary("Serve the run library; optional tunnel-edge exposure.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--port <port>", "Loopback port to bind on 127.0.0.1. Defaults to an ephemeral port.", "0")
    .option("--run <id>", "Land on this run id (or latest) instead of the library index.")
    .option("--safe", "Serve only runs whose verify shareSafety is share_ready; everything else is absent (fail-closed).")
    .option("--expose", "Declare exposure intent. Requires edge auth (--oauth or --public-url) OR --safe.")
    .addOption(new Option("--tunnel <provider>", "Spawn the external tunnel binary against the loopback port.").choices(["ngrok"]))
    .option("--tunnel-domain <domain>", "Reserved domain passed to ngrok as --url (e.g. observer.example.com). Requires --tunnel.")
    .addOption(new Option("--oauth <provider>", "Turn on ngrok edge OAuth. Requires --tunnel.").choices(["google"]))
    .option("--allow-email <addr>", "Edge OAuth allow rule: permit this email. Repeatable. Requires --oauth.", collectRepeated, [])
    .option("--allow-domain <domain>", "Edge OAuth allow rule: permit this domain. Repeatable. Requires --oauth.", collectRepeated, [])
    .option("--public-url <origin>", "Bring-your-own authed edge (e.g. https://observer.example.com). Requires --expose; never affects binding.")
    .option("--open", "Open the library in the default browser.")
    .option("--no-open", "Serve without opening a browser.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Happy path:",
        "  humanish serve",
        "  humanish serve --expose --tunnel ngrok --oauth google --allow-email you@example.com",
        "  humanish serve --safe --expose --tunnel ngrok",
        "  humanish serve --expose --public-url https://observer.example.com",
        "",
        "Agent/CI path:",
        "  humanish serve --json --no-open",
        "",
        "The server always binds 127.0.0.1; exposure only ever happens through an authenticated",
        "edge (ngrok --oauth google, or an operator --public-url you secure) forwarding to the",
        "loopback port. humanish carries no in-process auth — the gate lives at the edge. Live",
        "desktop stream URLs are never served here; remote viewers see persisted evidence only.",
        "--safe composes with any exposure for defense in depth."
      ].join("\n")
    )
    .action(async (options: {
      cwd: string;
      expose?: boolean;
      json?: boolean;
      open?: boolean;
      port: string;
      publicUrl?: string;
      run?: string;
      safe?: boolean;
      tunnel?: "ngrok";
      tunnelDomain?: string;
      oauth?: "google";
      allowEmail: string[];
      allowDomain: string[];
    }, command) => {
      const wantsMachine = wantsJson(command);
      const fail = (code: ServeErrorCode, message: string): void => {
        const result: ServeResult = {
          schema: SERVE_SCHEMA,
          ok: false,
          cwd: options.cwd,
          mode: "loopback",
          safe: options.safe === true,
          host: "127.0.0.1",
          runsListed: 0,
          warnings: [],
          error: { code, message }
        };
        writeResult(command, io, result, formatServeHuman);
        io.setExitCode(2);
      };

      const port = parseObserverPort(options.port);
      if (port === null) {
        fail("HUMANISH_INVALID_PORT", "--port must be an integer between 0 and 65535.");
        return;
      }

      // Fail-closed exposure matrix (shared validator; tunnel-edge auth only). All guards run before
      // any bind/spawn.
      const exposeValidation = validateExposure("serve", {
        expose: options.expose === true,
        ...(options.tunnel === undefined ? {} : { tunnel: options.tunnel }),
        ...(options.tunnelDomain === undefined ? {} : { tunnelDomain: options.tunnelDomain }),
        ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
        allowEmails: options.allowEmail,
        allowDomains: options.allowDomain,
        ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
        safe: options.safe === true
      });
      if (!exposeValidation.ok) {
        fail(exposeValidation.error.code, exposeValidation.error.message);
        return;
      }
      const plan = exposeValidation.plan;

      const started = await serveObserverLibrary(options.cwd, {
        port,
        safe: options.safe === true,
        expose: plan.exposed,
        edgeAuthed: plan.edgeAuthed,
        ...(plan.publicOrigin ? { publicOrigin: plan.publicOrigin.origin } : {}),
        ...(options.run ? { entryRunId: options.run } : {})
      });
      if (!started.ok) {
        fail(started.error.code, started.error.message);
        return;
      }
      const server = started.server;

      let tunnel: ServeTunnel | undefined;
      let publicUrl: string | undefined;
      const warnings: string[] = [];
      if (plan.exposed) {
        try {
          const exposeResult = await startExposedObserver(server, plan);
          tunnel = exposeResult.tunnel;
          publicUrl = exposeResult.publicUrl;
          warnings.push(...exposeResult.warnings);
        } catch (error: unknown) {
          await server.close();
          if (error instanceof ServeTunnelError) {
            fail(error.code, error.message);
          } else {
            fail(
              "HUMANISH_SERVE_TUNNEL_START_FAILED",
              `Tunnel startup failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          return;
        }
      }

      if (server.mode === "exposed" && options.safe !== true) {
        warnings.push(
          `edge-authed exposure grants read access to all ${server.runsListed} local runs, including any not verified share_ready (local_only raw screenshots, blocked bundles); anyone who clears the edge auth can view them; add --safe to restrict to share_ready`
        );
      }
      if (server.mode === "exposed" && options.safe === true) {
        warnings.push(
          `edge-authed exposure grants read access to ${server.shareReadyCount ?? 0} share_ready runs; non-share_ready runs are absent even behind the edge`
        );
      }
      if (server.mode === "share-safe-open") {
        warnings.push(
          `serving ${server.shareReadyCount ?? 0} share_ready runs to anyone who can reach ${publicUrl ?? server.url}; non-share_ready runs are absent and their URLs 404`
        );
      }
      warnings.push(
        "live desktop stream URLs are never served here; remote viewers see persisted evidence (screenshots, events, terminal tails) only"
      );

      // Auto-open is suppressed under --expose so the public URL is not shoved into a local opener's
      // argv unasked — the exposure target is a remote device anyway. Explicit --open still honors
      // intent and opens the loopback library.
      const shouldOpen = options.open === false
        ? false
        : options.open === true
          ? true
          : !wantsMachine && process.stdout.isTTY === true && plan.exposed !== true;
      const openResult: { opened: boolean; command?: string; warning?: string } =
        shouldOpen ? openTarget(server.url) : { opened: false };
      if (openResult.warning) {
        warnings.push(openResult.warning);
      }

      const result: ServeResult = {
        schema: SERVE_SCHEMA,
        ok: true,
        cwd: options.cwd,
        mode: server.mode,
        safe: options.safe === true,
        host: "127.0.0.1",
        port: server.port,
        url: server.url,
        ...(publicUrl ? { publicUrl } : {}),
        ...(tunnel ? { tunnel: { provider: "ngrok", url: tunnel.url } } : {}),
        ...(plan.oauth ? { oauth: { provider: plan.oauth.provider, allowEmails: plan.oauth.allowEmails, allowDomains: plan.oauth.allowDomains } } : {}),
        runsListed: server.runsListed,
        ...(server.shareReadyCount !== undefined ? { shareReadyCount: server.shareReadyCount } : {}),
        ...(server.entryRunId ? { entryRunId: server.entryRunId } : {}),
        opened: openResult.opened,
        ...(openResult.command ? { openCommand: openResult.command } : {}),
        warnings
      };

      writeResult(command, io, result, formatServeHuman);
      io.setExitCode(0);

      await serveObserveUntilSignal(io, {
        url: server.url,
        close: async () => {
          if (tunnel) {
            await tunnel.close();
          }
          await server.close();
        }
      }, { json: wantsMachine });
    });
}

function formatServeHuman(result: ServeResult): string {
  if (!result.ok) {
    return [
      "humanish serve failed",
      ...(result.error ? [`error: ${result.error.code} ${result.error.message}`] : []),
      ...result.warnings.map((warning) => `warning: ${warning}`)
    ].join("\n") + "\n";
  }

  const modeSuffix = result.safe ? " (share_ready only)" : "";
  const lines = [
    "humanish serve",
    `mode: ${result.mode}${modeSuffix}`,
    `library: ${result.url ?? ""}`,
    `runs: ${result.runsListed}`
  ];
  if (result.publicUrl) {
    lines.push(`public: ${result.publicUrl}`);
  }
  if (result.tunnel) {
    lines.push(`tunnel: ${result.tunnel.provider} ${result.tunnel.url}`);
  }
  if (result.oauth) {
    const rules = [...result.oauth.allowEmails, ...result.oauth.allowDomains];
    lines.push(`edge auth: ${result.oauth.provider} oauth${rules.length > 0 ? ` (allow: ${rules.join(", ")})` : " (no allow rule — any Google account)"}`);
  }
  if (result.entryRunId) {
    lines.push(`entry: ${result.entryRunId}`);
  }
  lines.push(`opened: ${result.opened === true ? "yes" : "no"}`);
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join("\n") + "\n";
}

function registerFeedbackCommands(parent: Command, io: CliIo): void {
  const feedback = parent
    .command("feedback")
    .description("Create public-safe feedback drafts without GitHub API mutation.")
    .summary("Create public-safe feedback drafts, no GitHub API.");

  feedback
    .command("list")
    .description("List feedback draft state for a run.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await listFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("draft")
    .description("Generate a public-safe feedback draft from verified evidence.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await draftFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("verify")
    .description("Verify the feedback draft for public issue eligibility.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await verifyFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("issue")
    .description("Print Markdown for a public GitHub issue. Does not mutate GitHub.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .requiredOption("--repo <owner/repo>", "Repository slug used in rendered filing instructions.")
    .option("--format <format>", "Output format.", "markdown")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; format: string; json?: boolean; repo: string; run: string }, command) => {
      const result = await renderIssueMarkdown(options.cwd, options.run, options.repo);

      if (wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else if (options.format !== "markdown") {
        io.writeErr("Only --format markdown is supported.\n");
        io.setExitCode(2);
        return;
      } else if (result.ok && result.issueMarkdown) {
        io.writeOut(result.issueMarkdown);
      } else {
        io.writeErr(formatFeedbackHuman(result));
      }

      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("issue-url")
    .description("Print a prefilled public issue URL. Does not mutate GitHub.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .requiredOption("--repo <owner/repo>", "Repository slug used in the generated URL.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; repo: string; run: string }, command) => {
      const result = await renderIssueUrl(options.cwd, options.run, options.repo);

      if (wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok && result.issueUrl) {
        io.writeOut(`${result.issueUrl}\n`);
      } else {
        io.writeErr(formatFeedbackHuman(result));
      }

      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerLabCommands(parent: Command, io: CliIo): void {
  const lab = parent
    .command("lab")
    .description("List, inspect, and run Humanish lab manifests.")
    .summary("List, inspect, and run Humanish lab manifests.");

  lab
    .command("list")
    .description("List committed and ignored Humanish lab manifests.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await listLabManifests(options.cwd);
      writeResult(command, io, result, formatLabListHuman);
      io.setExitCode(0);
    });

  lab
    .command("inspect")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Inspect a Humanish lab manifest without running it.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (labName: string, options: { cwd: string; json?: boolean }, command) => {
      const result = await inspectLabManifest(options.cwd, labName);
      writeResult(command, io, result, formatLabInspectHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  lab
    .command("preflight")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Check a lab manifest and optional target reachability before actor/model spend.")
    .option("--cwd <path>", "Target project directory.", ".")
    .addOption(new Option("--reachability <mode>", "Reachability mode.").choices(["metadata", "public-preview", "sandbox-loopback", "prepared-host"]).default("metadata"))
    .option("--timeout-ms <ms>", "Target reachability timeout.", String(30_000))
    .option("--env-file <path>", "Load a local env file for this preflight without persisting values.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (labName: string, options: { cwd: string; envFile?: string; json?: boolean; reachability: LabPreflightReachabilityMode; timeoutMs: string }, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      const timeoutMs = parsePositiveInteger(options.timeoutMs);
      if (timeoutMs === null) {
        const result: LabPreflightResult = {
          schema: "humanish.lab-preflight-result.v1",
          ok: false,
          cwd: resolve(options.cwd),
          lab: labName,
          reachability: options.reachability,
          checks: [{ name: "timeout", ok: false, message: "--timeout-ms must be a positive integer." }],
          targets: [],
          sandbox: { created: false },
          spend: { e2bDesktop: false, model: false },
          warnings: [],
          error: {
            code: "HUMANISH_LAB_PREFLIGHT_INVALID_OPTION",
            message: "--timeout-ms must be a positive integer."
          }
        };
        writeResult(command, io, result, formatLabPreflightHuman);
        io.setExitCode(2);
        return;
      }

      const result = await runLabPreflight({
        cwd: options.cwd,
        lab: labName,
        reachability: options.reachability,
        timeoutMs
      });
      writeResult(command, io, result, formatLabPreflightHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  lab
    .command("cleanup")
    .argument("[lab]", "Provider-backed lab to clean up.", "oss")
    .description("Sweep stale provider resources from a crashed prior process, by provider metadata, without printing provider ids. humanish never enumerates an account by default: set HUMANISH_OSS_META_ALLOW_PROVIDER_LIST=1 to opt in for this maintainer-only sweep.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (labName: string, _options: { json?: boolean }, command) => {
      if (labName !== "oss") {
        const result = {
          schema: "humanish.oss-meta-lab-cleanup-result.v1" as const,
          ok: false,
          lab: labName,
          cleanup: { killed: 0, skipped: 0, errors: [`Unsupported cleanup lab '${labName}'.`] }
        };
        writeResult(command, io, result, formatOssMetaLabCleanupHuman);
        io.setExitCode(2);
        return;
      }

      const cleanup = await cleanupStaleOssMetaLabSandboxes();
      const result = {
        schema: "humanish.oss-meta-lab-cleanup-result.v1" as const,
        ok: cleanup.errors.length === 0,
        lab: "oss",
        cleanup
      };
      writeResult(command, io, result, formatOssMetaLabCleanupHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  lab
    .command("run")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Run a Humanish lab manifest. Same as `humanish run <lab>`, grouped under `lab`.")
    .option("--env-file <path>", "Load a local env file for this lab without persisting values.")
    .option("--dry-run", "Render contract evidence without live provider spend. The bundled OSS lab defaults to this mode.")
    .option("--codex-app-server", "Meta only: use Codex app-server client mode for headed desktop actor surfaces.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--sims <count>", "Override synthetic sims or headed desktop lanes.")
    .option("--count <count>", "CUA/meta only: override headed desktop lane count.")
    .option("--rerun-failed-from <run>", "CUA fan-out only: create a new run for failed lanes from a prior run.")
    .option("--lanes <lane-ids>", "CUA rerun only: comma-separated lane ids to rerun from the source run.")
    .option("--limit <count>", "Smoke labs only: override repo limit.")
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--repo <owner/repo>", "Smoke/meta only: GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--repos <owner/repo,...>", "Smoke/meta only: comma-separated GitHub repo slugs.")
    .option("--redact-repos", "Meta only: redact repo labels in durable lab artifacts.")
    .option("--no-redact-repos", "Meta only: persist repo labels in durable lab artifacts. Use only for public-safe runs.")
    .option("--keep", "Smoke labs only: keep disposable clone sandbox for debugging.")
    .option("--scorer <path>", "Terminal/computer-use/shared-world labs only: repo-relative adopter scorer module (.mjs). Overrides review.scorer.ref. Executable code — review it as code.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish lab run first-run",
        "  humanish lab run fanout-demo --rerun-failed-from latest --lanes lane-02,lane-04",
        "  humanish lab run oss --dry-run --json --no-open",
        "  humanish lab run my-terminal-lab --scorer scorers/product.mjs",
        "  humanish lab run .humanish/labs/private-dogfood.yaml --env-file .humanish/local/provider.env",
        "",
        "Human watch path:",
        "  humanish watch first-run",
        "  humanish watch --lab .humanish/labs/local.yaml",
        "",
        "OSS safety:",
        "  Live OSS meta-lab manifests fail closed pending credential isolation."
      ].join("\n")
    )
    .action(async (labName: string, options: LabCommandOptions, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      await runLabCommand({
        command,
        io,
        lab: labName,
        mode: "run",
        options
      });
    });

  lab
    .command("oss", { hidden: true })
    .description("Alias: run the bundled OSS meta-lab dry-run contract.")
    .option("--env-file <path>", "Load a local env file for this lab without persisting values.")
    .option("--repos <owner/repo,...>", "Comma-separated GitHub repo slugs.")
    .option("--repo <owner/repo>", "GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--count <count>", "Number of contract lanes to assign.", String(DEFAULT_OSS_REPOS.length))
    .option("--sims <count>", "Alias for --count.")
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Host directory for ignored .humanish lab report.", ".")
    .option("--dry-run", "Render the Observer-of-Observers contract without provider spend or live E2B launch (default).")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--redact-repos", "Redact repo labels in durable lab artifacts.")
    .option("--no-redact-repos", "Persist repo labels in durable lab artifacts. Defaults to redacted when a GitHub token is present.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--smoke", "Run the disposable local clone smoke harness instead of headed meta-sims.")
    .option("--limit <count>", "Smoke mode only: number of selected repos to trial.", String(DEFAULT_OSS_REPOS.length))
    .option("--keep", "Smoke mode only: keep disposable clone sandbox for debugging.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Preferred paths:",
        "  humanish watch oss",
        "  humanish lab run oss --dry-run",
        "",
        "Repo selection:",
        "  humanish watch --lab .humanish/labs/local-oss.yaml",
        "  humanish lab run oss --repos CorentinTh/it-tools,drawdb-io/drawdb,maciekt07/TodoApp,lissy93/dashy",
        "  humanish lab run oss --repo CorentinTh/it-tools --repo drawdb-io/drawdb --count 4",
        "",
        "Agent/CI path:",
        "  humanish lab run oss --dry-run --json --no-open",
        "",
        "Disposable clone smoke:",
        "  humanish lab run oss-smoke --limit 1 --keep",
        "  humanish lab oss-smoke --limit 1 --keep",
        "",
        "Shape:",
        "  The top-level Observer shows contract-only lanes for the selected repo labels.",
        "  No repo clone, provider sandbox, credential forwarding, or Codex actor runs.",
        "",
        "Safety:",
        "  Only GitHub owner/repo slugs are accepted. Live OSS meta-lab execution",
        "  fails closed pending credential isolation. Repo labels are redacted by",
        "  default when overridden; use --no-redact-repos only for public-safe repos."
      ].join("\n")
    )
    .action(async (options: {
      count: string;
      codexAppServer?: boolean;
      cwd: string;
      detach?: boolean;
      dryRun?: boolean;
      envFile?: string;
      json?: boolean;
      keep?: boolean;
      limit: string;
      open?: boolean;
      port: string;
      redactRepos?: boolean;
      repo: string[];
      repos?: string;
      runId?: string;
      sims?: string;
      smoke?: boolean;
    }, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      if (options.smoke) {
        await runOssSmokeAction({ command, io, options });
        return;
      }

      const countInput = options.sims ?? options.count;
      const count = parsePositiveInteger(countInput);
      const dryRun = options.dryRun ?? true;
      const port = parseObserverPort(options.port);
      if (port === null) {
        const result: OssMetaLabResult = {
          schema: "humanish.oss-meta-lab-result.v1",
          ok: false,
          assignments: [],
          cwd: options.cwd,
          dryRun,
          error: {
            code: "HUMANISH_META_RUN_FAILED",
            message: "--port must be an integer between 0 and 65535."
          },
          liveRequested: !dryRun,
          repos: [...options.repo, ...(options.repos ? [options.repos] : [])],
          sandboxes: [],
          warnings: []
        };
        writeResult(command, io, result, formatOssMetaLabHuman);
        io.setExitCode(2);
        return;
      }

      const wantsMachine = wantsJson(command);
      const shouldOpen = options.open === false ? false : options.open === true ? true : !wantsMachine && process.stdout.isTTY === true;
      const wantsFollow = !wantsMachine && options.detach !== true && !dryRun;
      const repoOverrideRequested = options.repo.length > 0 || options.repos !== undefined;
      const redactRepoNames = options.redactRepos ?? (repoOverrideRequested ? true : undefined);
      let server: ObserverServer | null = null;
      let liveRefresh = null as ReturnType<typeof startOssMetaLabLiveRefresh>;
      let result: OssMetaLabResult;
      try {
        result = await runOssMetaLab({
          ...(wantsFollow ? { completionTimeoutMs: 0 } : {}),
          ...(options.codexAppServer === undefined ? {} : { codexAppServer: options.codexAppServer }),
          cwd: options.cwd,
          ...(wantsFollow
            ? {
                onObserverReady: async (observer) => {
                  if (!server) {
                    server = await serveObserver(observer, { open: shouldOpen, port });
                  }
                }
              }
            : {}),
          open: wantsFollow ? false : shouldOpen,
          ...(redactRepoNames === undefined ? {} : { redactRepoNames }),
          repos: [...options.repo, ...(options.repos ? [options.repos] : [])],
          ...(count === null ? { count: Number.NaN } : { count }),
          dryRun,
          ...(options.runId === undefined ? {} : { runId: options.runId })
        });
      } catch (error) {
        const earlyServer = server as ObserverServer | null;
        await earlyServer?.close().catch((cleanupError: unknown) => {
          io.writeErr(`watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
        });
        server = null;
        throw error;
      }

      let output = result;
      if (server && shouldServeOssMetaLabObserver(result, { wantsFollow: true })) {
        liveRefresh = startOssMetaLabLiveRefresh(result);
        output = withOssMetaLabServer(result, server);
      } else if (shouldServeOssMetaLabObserver(result, { wantsFollow })) {
        server = await serveObserver(result.observer, { open: shouldOpen, port });
        liveRefresh = startOssMetaLabLiveRefresh(result);
        output = withOssMetaLabServer(result, server);
      } else {
        const earlyServer = server as ObserverServer | null;
        await earlyServer?.close().catch((error: unknown) => {
          io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
        server = null;
      }

      const exitCode = exitCodeForOssMetaLab(output);
      writeResult(command, io, output, formatOssMetaLabHuman);
      io.setExitCode(exitCode);

      if (shouldForceExitAfterOssMetaLab(output, { detach: options.detach === true, wantsMachine })) {
        // The E2B SDK keeps local handles open after stream URL creation. Detach should
        // return the user's shell, and JSON mode should exit after printing the result.
        setTimeout(() => process.exit(exitCode), 50);
      }

      if (server && output.observer?.ok) {
        await followObserver(io, output.observer, server, output.liveRequested
          ? {
	          onStop: async () => {
	            const cleanup = liveRefresh
	              ? await liveRefresh.cleanup()
	              : await cleanupOssMetaLabSandboxes(output);
	            return [
	              `E2B sandbox cleanup killed ${cleanup.killed}, skipped ${cleanup.skipped}.`,
	              ...cleanup.errors.map((error) => `E2B sandbox cleanup error: ${error}`)
                ];
              }
            }
          : {});
      }
    });

  lab
    .command("oss-smoke", { hidden: true })
    .description("Clone lightweight public OSS repos, try Humanish setup/proof, then discard clones.")
    .option("--repos <owner/repo,...>", "Comma-separated public GitHub repo slugs.")
    .option("--repo <owner/repo>", "Public GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--limit <count>", "Number of selected repos to trial.", String(DEFAULT_OSS_REPOS.length))
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Host directory for ignored .humanish lab report.", ".")
    .option("--keep", "Keep disposable clone sandbox for debugging.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish lab oss-smoke",
        "  humanish lab oss-smoke --repos CorentinTh/it-tools,drawdb-io/drawdb",
        "  humanish lab oss-smoke --limit 1 --keep --json",
        "",
        "Safety:",
        "  Only public GitHub owner/repo slugs are accepted. Clones live under ignored .humanish/",
        "  runtime state and are removed by default."
      ].join("\n")
    )
    .action(async (options: {
      cwd: string;
      json?: boolean;
      keep?: boolean;
      limit: string;
      repo: string[];
      repos?: string;
      runId?: string;
    }, command) => {
      await runOssSmokeAction({ command, io, options });
    });
}

async function runOssSmokeAction(args: {
  command: Command;
  io: CliIo;
  options: {
    cwd: string;
    keep?: boolean;
    limit: string;
    repo: string[];
    repos?: string;
    runId?: string;
  };
}): Promise<void> {
  const limit = parsePositiveInteger(args.options.limit);
  const labOptions = {
    cwd: args.options.cwd,
    limit: limit ?? Number.NaN,
    repos: [...args.options.repo, ...(args.options.repos ? [args.options.repos] : [])],
    ...(args.options.keep === undefined ? {} : { keep: args.options.keep }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  };
  const result = await runOssLab(labOptions);
  writeResult(args.command, args.io, result, formatOssLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);
}

/** A CONFIG-DECLARED scorer that resolved + loaded fail-closed, ready to thread into a backend. */
interface LoadedAdapterScorer {
  hooks: AdapterScorerModule;
  provenance: RunScorerProvenance;
}

/**
 * Resolve `review.scorer.ref` (or the `--scorer` override) to a loaded adopter scorer, fail-closed
 * (typed error) PRE-SPEND. Precedence: CLI `--scorer` overrides the manifest; `source` records which
 * won. No scorer declared → `{ ok: true }` with no scorer. A declared scorer on an unsupported
 * backend, or a bad/unreadable/broken ref, → `{ ok: false }` so the caller aborts with exit 2.
 */
async function maybeLoadAdapterScorer(args: {
  cwd: string;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  backend: LabBackend;
  flag: string | undefined;
}): Promise<
  | { ok: true; scorer?: LoadedAdapterScorer }
  | { ok: false; error: NonNullable<RunResult["error"]> }
> {
  const ref = args.flag ?? args.config.review?.scorer?.ref;
  if (ref === undefined) return { ok: true };
  const source = args.flag !== undefined ? "cli-flag" : "manifest";
  const loaded = await loadAdapterScorer({ cwd: args.cwd, ref, backend: args.backend, source });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, scorer: { hooks: loaded.hooks, provenance: loaded.provenance } };
}

/** Terminal route hooks bag from a loaded scorer (deriveArtifacts is browser-only, dropped here). */
function terminalScorerHooks(scorer: LoadedAdapterScorer): TerminalProductLabHooks {
  const { hooks } = scorer;
  return {
    ...(hooks.score ? { score: hooks.score } : {}),
    ...(hooks.deriveFeedback ? { deriveFeedback: hooks.deriveFeedback } : {})
  };
}

/** Browser route hooks bag from a loaded scorer (score + deriveFeedback + deriveArtifacts). */
function browserScorerHooks(scorer: LoadedAdapterScorer): BrowserLabAdapterHooks {
  const { hooks } = scorer;
  return {
    ...(hooks.score ? { score: hooks.score } : {}),
    ...(hooks.deriveFeedback ? { deriveFeedback: hooks.deriveFeedback } : {}),
    ...(hooks.deriveArtifacts ? { deriveArtifacts: hooks.deriveArtifacts } : {})
  };
}

async function runLabCommand(args: {
  command: Command;
  io: CliIo;
  lab: string;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const resolved = await resolveLabManifest(args.options.cwd, args.lab);
  if (!resolved.ok) {
    writeResult(args.command, args.io, resolved, formatLabResolveFailureHuman);
    args.io.setExitCode(2);
    return;
  }

  // Surface forward-declared-field + .yml warnings on run/watch too, not only on inspect.
  // Otherwise a setting that does nothing is silently swallowed on the path users actually run.
  for (const warning of resolved.warnings) {
    args.io.writeErr(`warning: ${warning}\n`);
  }

  const config = resolved.config;
  // The run's identity (#455): which manifest, where it lives, and whether it is committed, a
  // local overlay, or an explicit path. Resolved once here — the only place that knows all three —
  // and carried into the run's status record and bundle so the filesystem can answer "which lab
  // produced this run" without the old `persona.source = "lab:<id>"` string convention.
  const lab: RunLabProvenance = { id: config.id, path: resolved.path, origin: resolved.origin };
  // Named here, once, for every backend: a synthetic or terminal result carries no labId, so the
  // starter lab `first-run` went unnamed in telemetry while the computer-use ones were named.
  noteStudyFacts(args.command, deriveStudyFacts({ labId: config.id }));
  const backend = selectLabBackend(config);
  if (backend !== "cua" && labRerunFlagsRequested(args.options)) {
    writeUnsupportedRerunFlagsResult(args, backend);
    return;
  }
  // Exposure serves a live desktop, which only the computer-use backend produces. Refuse it on any
  // other backend rather than silently ignoring it.
  if (backend !== "cua" && watchExposeRequested(args.options)) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: resolve(args.options.cwd),
      warnings: [],
      error: {
        code: "HUMANISH_WATCH_OPTION_CONFLICT",
        message: `--expose/--tunnel/--oauth stream a live desktop and apply only to computer-use labs; this lab resolved to ${backend}.`
      }
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  // #316: resolve + load a config-declared/CLI-flagged adopter scorer FAIL-CLOSED, before any spend.
  // A declared gate that cannot load (bad ref, not found, load failure, no hooks, unsupported backend)
  // aborts with exit 2 rather than green-passing.
  const scorerLoad = await maybeLoadAdapterScorer({
    cwd: args.options.cwd,
    config,
    backend,
    flag: args.options.scorer
  });
  if (!scorerLoad.ok) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: resolve(args.options.cwd),
      warnings: [],
      error: scorerLoad.error
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }
  const scorer = scorerLoad.scorer;
  if (scorer) {
    // Cross-repo guardrail: `humanish lab run` now import()s host JS named in the manifest. Surface it
    // visibly so the invoker (who may not be the manifest author) knows executable code just ran.
    args.io.writeErr(`warning: review scorer ${scorer.provenance.ref} (${scorer.provenance.source}) is executable host code loaded and run in-process — review it as code, not config.\n`);
  }

  switch (backend) {
    case "synthetic":
      await runSyntheticBackend({ ...args, config, labProvenance: lab });
      return;
    case "meta":
      await runMetaBackend({ ...args, config, labProvenance: lab });
      return;
    case "smoke":
      await runSmokeBackend({ ...args, config, labProvenance: lab });
      return;
    case "cua":
      await runCuaBackend({ ...args, config, labProvenance: lab, ...(scorer ? { scorer } : {}) });
      return;
    case "scripted":
      await runScriptedBackend({ ...args, config, labProvenance: lab });
      return;
    case "terminal":
      await runTerminalBackend({ ...args, config, labProvenance: lab, ...(scorer ? { scorer } : {}) });
      return;
    case "shared-world":
      await runSharedWorldBackend({ ...args, config, labProvenance: lab, ...(scorer ? { scorer } : {}) });
      return;
    case "concurrent-shared-world":
      await runConcurrentSharedWorldBackend({ ...args, config, labProvenance: lab, ...(scorer ? { scorer } : {}) });
      return;
    default:
      // Compile-time exhaustiveness: a future backend must be handled here, not silently no-op.
      throw new Error(`Unhandled lab backend: ${String(backend satisfies never)}`);
  }
}

function labRerunFlagsRequested(options: LabCommandOptions): boolean {
  return options.rerunFailedFrom !== undefined || options.lanes !== undefined;
}

function writeUnsupportedRerunFlagsResult(args: {
  command: Command;
  io: CliIo;
  options: LabCommandOptions;
}, backend: string): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd: resolve(args.options.cwd),
    warnings: [],
    error: {
      code: "HUMANISH_UNSUPPORTED_RERUN_FLAGS",
      message: `--rerun-failed-from/--lanes apply only to CUA fan-out labs; this lab resolved to ${backend}.`
    }
  };
  writeResult(args.command, args.io, result, formatRunHuman);
  args.io.setExitCode(2);
}

async function runSyntheticBackend(args: {
  command: Command;
  io: CliIo;
  lab: string;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const simCount = parseLabCount(args.options.sims, args.config.actors[0]?.count ?? 4);
  if (simCount === null) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: args.options.cwd,
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer."
      }
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    count: simCount,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  });
  if (outcome.backend !== "synthetic") {
    throw new Error(`Expected synthetic backend, got ${outcome.backend}.`);
  }
  const runResult = outcome.result;

  if (args.mode === "run") {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(runResult.ok ? 0 : 2);
    return;
  }

  if (!runResult.ok || !runResult.runId) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const openOverride = args.options.open ?? args.config.defaults?.open;
  await renderAndMaybeFollowObserver({
    command: args.command,
    cwd: args.options.cwd,
    io: args.io,
    port: args.options.port ?? "0",
    runInput: runResult.runId,
    ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
    ...(openOverride === undefined ? {} : { open: openOverride })
  });
}

/**
 * Default browser-open policy for a lab backend run. Mirrors the observe/watch gate:
 * an explicit --open/--no-open wins; --json (machine mode) never auto-opens; otherwise a
 * lab-config `defaults.open` wins, and the final fallback opens only for an interactive
 * `watch` on a real TTY. Extracted so all lab backends share one gate (and one test).
 */
export function resolveBackendShouldOpen(args: {
  optionOpen: boolean | undefined;
  defaultsOpen: boolean | undefined;
  mode: string;
  wantsMachine: boolean;
}): boolean {
  if (args.optionOpen === false) return false;
  if (args.wantsMachine) return args.optionOpen === true;
  return args.optionOpen ?? args.defaultsOpen ?? (process.stdout.isTTY === true && args.mode === "watch");
}

async function runCuaBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine
  });
  const laneIds = parseLaneIds(args.options.lanes);
  if (laneIds.length > 0 && !args.options.rerunFailedFrom) {
    args.io.writeErr("error: --lanes requires --rerun-failed-from.\n");
    args.io.setExitCode(2);
    return;
  }
  const count = parseLabCount(args.options.count ?? args.options.sims, args.config.actors[0]?.count ?? 1);
  if (count === null) {
    args.io.writeErr("error: --count/--sims must be a positive integer.\n");
    args.io.setExitCode(2);
    return;
  }

  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, true) ?? true;
  const port = parseObserverPort(args.options.port ?? "0");
  const wantsFollow = args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;

  const failCua = (code: CuaActorLabErrorCode, message: string): void => {
    const result: CuaActorLabResult = {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd: args.options.cwd,
      labId: args.config.id,
      actor: args.config.actors[0]?.type ?? "",
      appUrl: "",
      dryRun,
      runId: args.options.runId ?? "not-created",
      warnings: [],
      error: { code, message }
    };
    writeResult(args.command, args.io, result, formatCuaLabHuman);
    args.io.setExitCode(2);
  };

  if (port === null) {
    failCua("HUMANISH_WATCH_OPTION_CONFLICT", "--port must be an integer between 0 and 65535.");
    return;
  }

  // Validate exposure up front (fail-closed matrix), before any run/spend. A live CUA watch is the
  // one surface that serves runtime E2B stream URLs, so it MUST sit behind edge auth.
  const exposeValidation = validateExposure("watch", exposureRequestFromOptions(args.options), {
    dryRun,
    detach: args.options.detach === true,
    json: wantsMachine
  });
  if (!exposeValidation.ok) {
    failCua(exposeValidation.error.code as CuaActorLabErrorCode, exposeValidation.error.message);
    return;
  }
  const plan = exposeValidation.plan;
  const exposeRequested = plan.exposed;

  let server: ObserverServer | null = null;
  let attachedObserver: (ObserverResult & { ok: true }) | null = null;
  let tunnel: ServeTunnel | undefined;
  let exposeWarnings: string[] = [];
  let exposePublicTarget: string | undefined;

  let outcome: Awaited<ReturnType<typeof runLab>>;
  try {
    outcome = await runLab(args.config, {
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      // Watch mode opens the served Observer below (or prints the phone target under --expose)
      // instead of the static render — preserved byte-for-byte from the pre-0.18 open policy so a
      // non-follow watch (dry-run/--json) does not double-open. Run mode keeps the static open.
      open: args.mode === "watch" ? false : shouldOpen,
      count,
      dryRun,
      ...(wantsFollow
        ? {
            // Fires INSIDE runLab, before the actor loop and before sandbox creation, so a
            // tunnel-auth failure aborts before any spend and leaves no orphaned sandbox.
            onObserverReady: async (observer) => {
              attachedObserver = observer;
              if (!server) {
                server = await serveObserver(observer, {
                  open: shouldOpen && !exposeRequested,
                  port,
                  exposed: exposeRequested
                });
              }
              if (exposeRequested) {
                const activeServer = server as ObserverServer;
                const exposeResult = await startExposedObserver(activeServer, plan);
                if (exposeResult.tunnel) {
                  tunnel = exposeResult.tunnel;
                }
                exposeWarnings = exposeResult.warnings;
                const phoneTarget = exposeResult.publicUrl ?? activeServer.url;
                exposePublicTarget = phoneTarget;
                args.io.writeOut(`watch: exposed live desktop at ${phoneTarget} (edge-authed; open it on your phone)\n`);
                for (const warning of exposeResult.warnings) {
                  args.io.writeErr(`warning: ${warning}\n`);
                }
              }
            }
          }
        : {}),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      ...(args.scorer ? { cuaHooks: browserScorerHooks(args.scorer), scorerProvenance: args.scorer.provenance } : {}),
      ...(args.options.rerunFailedFrom === undefined
        ? {}
        : {
            rerun: {
              sourceRunId: args.options.rerunFailedFrom,
              ...(laneIds.length === 0 ? {} : { laneIds })
            }
          })
    });
  } catch (error) {
    // Tear down the loopback server and any tunnel started inside onObserverReady before rethrowing
    // (or surfacing a structured tunnel-startup failure). The sandbox is created AFTER
    // onObserverReady returns, so a tunnel failure here cannot orphan one.
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(`watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    });
    server = null;
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
      tunnel = undefined;
    }
    if (error instanceof ServeTunnelError) {
      failCua(error.code, error.message);
      return;
    }
    throw error;
  }

  if (outcome.backend !== "cua") {
    throw new Error(`Expected cua backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;

  // Serving is NOT gated on result.ok: a timed_out/failed run still comes up so the operator can
  // inspect its evidence live (and, under --expose, from a phone). budget_reached now makes a
  // productive open-ended watch result.ok true.
  let output: CuaActorLabResult = result;
  if (server && attachedObserver) {
    const activeServer = server as ObserverServer;
    const attachedResult = result.observer?.ok ? result.observer : attachedObserver;
    output = {
      ...result,
      observer: withObserverServer(attachedResult, activeServer),
      warnings: [
        ...result.warnings,
        "Live CUA server is polling observer-data.json with no-store caching.",
        ...(exposeRequested
          ? [
              `Exposed live desktop stream URLs to an edge-authenticated remote viewer${tunnel ? ` via ${tunnel.url.replace(/\/$/, "")}` : ""}.`,
              `this live run's raw, unverified evidence (screenshots, events) is viewable by anyone who clears the edge auth at ${exposePublicTarget ?? activeServer.url}; only the run being watched is served, not your other runs`
            ]
          : []),
        ...exposeWarnings,
        ...(activeServer.warning ? [activeServer.warning] : [])
      ]
    };
  }
  writeResult(args.command, args.io, output, formatCuaLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (server && (result.observer?.ok || attachedObserver)) {
    const activeServer = server as ObserverServer;
    const followResult = output.observer?.ok ? output.observer : withObserverServer(attachedObserver!, activeServer);
    await followObserver(args.io, followResult, activeServer, {
      onStop: async () => {
        if (tunnel) {
          await tunnel.close();
          return ["closed ngrok tunnel"];
        }
        return [];
      }
    });
  } else if (args.mode === "watch" && result.ok && !wantsMachine) {
    // Non-follow / dry-run watch keeps today's fallback: render the finished bundle and follow it.
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen })
    });
  }
}

// Mirror of runCuaBackend: open semantics from defaults.open/--no-open/watch-mode, writeResult
// with the scripted human formatter, exit code result.ok ? 0 : 2, watch-mode Observer follow.
async function runScriptedBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine
  });

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    // Watch mode opens the served Observer below instead of the static render.
    open: args.mode === "watch" ? false : shouldOpen,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  });
  if (outcome.backend !== "scripted") {
    throw new Error(`Expected scripted backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatScriptedLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  // Watch mode serves the freshly rendered Observer (and opens it unless told not to).
  if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen })
    });
  }
}

// Mirror of runCuaBackend/runScriptedBackend: open semantics from defaults.open/--no-open/watch,
// writeResult with the terminal human formatter, exit code result.ok ? 0 : 2, watch-mode follow.
async function runTerminalBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine
  });

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    open: args.mode === "watch" ? false : shouldOpen,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    ...(args.scorer ? { terminalHooks: terminalScorerHooks(args.scorer), scorerProvenance: args.scorer.provenance } : {})
  });
  if (outcome.backend !== "terminal") {
    throw new Error(`Expected terminal backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatTerminalLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen })
    });
  }
}

async function runSharedWorldBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine
  });

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    open: args.mode === "watch" ? false : shouldOpen,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    ...(args.scorer ? { sharedWorldHooks: browserScorerHooks(args.scorer), scorerProvenance: args.scorer.provenance } : {})
  });
  if (outcome.backend !== "shared-world") {
    throw new Error(`Expected shared-world backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatSharedWorldLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen })
    });
  }
}

function formatSharedWorldLabHuman(result: SharedWorldLabResult): string {
  return [
    `humanish lab shared-world ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId}`,
    `lab: ${result.labId}`,
    `actor: ${result.actor}`,
    `topology: ${result.topology} (${result.roleCount} role${result.roleCount === 1 ? "" : "s"})`,
    `sequence: ${result.sequence.join(" -> ") || "(none)"}`,
    ...(result.subject?.commit ? [`plane: ${result.subject.repo}@${result.subject.commit.slice(0, 12)}`] : []),
    ...result.roles.map((role) =>
      `role ${role.id} (${role.persona}): ${role.status}${role.session ? ` (${role.session.completionReason})` : ""}${role.skippedReason ? ` · ${role.skippedReason}` : ""}`),
    ...(result.sandbox ? [`sandbox: ${result.sandbox.sandboxId} killed=${result.sandbox.killed ? "yes" : "no"}`] : []),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

async function runConcurrentSharedWorldBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, true) ?? true;
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine
  });
  const wantsFollow = args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;
  const port = parseObserverPort(args.options.port ?? "0");
  if (wantsFollow && port === null) {
    const result: ConcurrentSharedWorldLabResult = {
      schema: "humanish.concurrent-shared-world-lab-result.v1",
      ok: false,
      cwd: args.options.cwd,
      labId: args.config.id,
      actor: args.config.actors[0]?.type ?? "",
      topology: "shared-world",
      topologyMode: "concurrent",
      roleCount: args.config.actors[0]?.lanes?.length ?? 0,
      concurrency: args.config.execution?.concurrency ?? 1,
      dryRun,
      runId: args.options.runId ?? "not-created",
      roles: [],
      warnings: [],
      error: {
        code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        message: "--port must be an integer between 0 and 65535."
      }
    };
    writeResult(args.command, args.io, result, formatConcurrentSharedWorldLabHuman);
    args.io.setExitCode(2);
    return;
  }

  let server: ObserverServer | null = null;
  let attachedObserver: (ObserverResult & { ok: true }) | null = null;
  let outcome: Awaited<ReturnType<typeof runLab>>;
  try {
    outcome = await runLab(args.config, {
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      open: wantsFollow ? false : shouldOpen,
      dryRun,
      ...(wantsFollow
        ? {
            onObserverReady: async (observer) => {
              attachedObserver = observer;
              if (!server) {
                server = await serveObserver(observer, { open: shouldOpen, port: port ?? 0 });
              }
            }
          }
        : {}),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      ...(args.scorer ? { sharedWorldHooks: browserScorerHooks(args.scorer), scorerProvenance: args.scorer.provenance } : {})
    });
  } catch (error) {
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(`watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    });
    server = null;
    throw error;
  }
  if (outcome.backend !== "concurrent-shared-world") {
    throw new Error(`Expected concurrent-shared-world backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  let output: ConcurrentSharedWorldLabResult = result;
  if (server && attachedObserver) {
    const activeServer = server as ObserverServer;
    output = {
      ...result,
      observer: result.observer?.ok
        ? withObserverServer(result.observer, activeServer)
        : withObserverServer(attachedObserver, activeServer),
      warnings: [
        ...result.warnings,
        "Live concurrent shared-world server is polling observer-data.json with no-store caching.",
        ...(activeServer.warning ? [activeServer.warning] : [])
      ]
    };
  }
  writeResult(args.command, args.io, output, formatConcurrentSharedWorldLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (server && output.observer?.ok) {
    await followObserver(args.io, output.observer, server);
  } else if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen })
    });
  }
}

function formatConcurrentSharedWorldLabHuman(result: ConcurrentSharedWorldLabResult): string {
  return [
    `humanish lab concurrent-shared-world ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId}`,
    `lab: ${result.labId}`,
    `actor: ${result.actor}`,
    `topology: ${result.topology}/${result.topologyMode} (${result.roleCount} persona${result.roleCount === 1 ? "" : "s"}, concurrency ${result.concurrency})`,
    ...(result.host ? [`host: ${result.host}`] : []),
    ...(result.subject?.commit ? [`plane: ${result.subject.repo}@${result.subject.commit.slice(0, 12)}`] : []),
    ...(result.overlapProven === undefined ? [] : [`overlap: ${result.overlapProven ? "proven" : "not observed"} (this run only; no scale or adoption claim)`]),
    ...result.roles.map((role) =>
      `persona ${role.id} (${role.persona}): ${role.status}${role.session ? ` (${role.session.completionReason})` : ""} ${role.ok ? "ok" : "not-ok"}`),
    ...(result.subjectSandbox ? [`subject sandbox: ${result.subjectSandbox.sandboxId} killed=${result.subjectSandbox.killed ? "yes" : "no"}`] : []),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatTerminalLabHuman(result: TerminalProductLabResult): string {
  return [
    `humanish lab terminal ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId}`,
    `lab: ${result.labId}`,
    `actor: ${result.actor}`,
    `product: ${result.product}`,
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatScriptedLabHuman(result: ScriptedBrowserLabResult): string {
  return [
    `humanish lab scripted ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId}`,
    `lab: ${result.labId}`,
    `actor: ${result.actor}`,
    `subject: ${result.appUrl}`,
    ...(result.scenario
      ? [`scenario: ${result.scenario.id} @ ${result.scenario.sourceDigest.slice(0, 12)} (${result.scenario.source}, ${result.scenario.steps} step${result.scenario.steps === 1 ? "" : "s"})`]
      : []),
    ...result.sessions.map((session) =>
      `session ${session.surface}: ${session.status} (${session.completionReason}) · ${session.reason} [${session.screenshots} screenshot${session.screenshots === 1 ? "" : "s"}]`),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatCuaLabHuman(result: CuaActorLabResult): string {
  return [
    `humanish lab cua ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId}`,
    `lab: ${result.labId}`,
    `actor: ${result.actor}`,
    `subject: ${result.appUrl}`,
    ...(result.subject?.source === "clone"
      ? [`repo: ${result.subject.repo}${result.subject.commit ? `@${result.subject.commit.slice(0, 12)}` : ""}${result.subject.envNames && result.subject.envNames.length > 0 ? ` env=[${result.subject.envNames.join(", ")}]` : ""}`]
      : []),
    ...(result.rerun
      ? [`rerun: ${result.rerun.selectedLaneIds.join(", ")} from ${result.rerun.sourceRunId}`]
      : []),
    ...(result.session
      ? [`session: ${result.session.status} (${result.session.completionReason}) · ${result.session.reason}`,
         `screenshots: ${result.session.screenshots}`]
      : []),
    ...(result.sandbox
      ? [`sandbox: ${result.sandbox.sandboxId} stream=${result.sandbox.streamUrlPresent ? "connected" : "missing"} killed=${result.sandbox.killed ? "yes" : "no"}`]
      : []),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

async function runSmokeBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const fanout = args.config.subject.clone?.fanout ?? args.config.subject.repos?.length ?? DEFAULT_OSS_REPOS.length;
  const limit = parseLabCount(args.options.limit ?? args.options.sims, fanout);
  if (limit === null) {
    const result: OssLabResult = {
      schema: "humanish.oss-lab-result.v1",
      ok: false,
      cleanup: { kept: Boolean(args.options.keep), sandboxRemoved: false },
      completedAt: new Date().toISOString(),
      cwd: args.options.cwd,
      error: {
        code: "HUMANISH_INVALID_OSS_LIMIT",
        message: "--limit must be a positive integer."
      },
      repos: [],
      runId: args.options.runId ?? "not-created",
      sandboxPath: ".humanish/tmp/oss-lab/not-created",
      startedAt: new Date().toISOString(),
      warnings: []
    };
    writeResult(args.command, args.io, result, formatOssLabHuman);
    args.io.setExitCode(2);
    return;
  }

  const repos = labReposOverride(args.options);
  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    count: limit,
    ...(repos === undefined ? {} : { repos }),
    ...(args.options.keep === undefined ? {} : { keep: args.options.keep }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  });
  if (outcome.backend !== "smoke") {
    throw new Error(`Expected smoke backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatOssLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);
}

async function runMetaBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const metaCountDefault = args.config.subject.clone?.fanout ?? args.config.subject.repos?.length ?? DEFAULT_OSS_REPOS.length;
  const count = parseLabCount(args.options.count ?? args.options.sims, metaCountDefault);
  const repos = labReposOverride(args.options);
  const port = parseObserverPort(args.options.port ?? "0");
  if (port === null) {
    const result: OssMetaLabResult = {
      schema: "humanish.oss-meta-lab-result.v1",
      ok: false,
      assignments: [],
      cwd: args.options.cwd,
      dryRun: args.options.dryRun === true,
      error: {
        code: "HUMANISH_META_RUN_FAILED",
        message: "--port must be an integer between 0 and 65535."
      },
      liveRequested: args.options.dryRun !== true,
      repos: repos ?? args.config.subject.repos ?? [],
      sandboxes: [],
      warnings: []
    };
    writeResult(args.command, args.io, result, formatOssMetaLabHuman);
    args.io.setExitCode(2);
    return;
  }

  const wantsMachine = wantsJson(args.command);
  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, undefined);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine
  });
  const wantsFollow = args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;
  const codexAppServer = args.options.codexAppServer ?? args.config.execution?.desktop?.codexAppServer;
  const repoOverrideRequested = (args.options.repo?.length ?? 0) > 0 || args.options.repos !== undefined;
  const defaultRedactRepos = repoOverrideRequested ? true : args.config.policies?.redactRepos;
  const redactRepoNames = args.options.redactRepos ?? defaultRedactRepos;
  let server: ObserverServer | null = null;
  let liveRefresh = null as ReturnType<typeof startOssMetaLabLiveRefresh>;
  let result: OssMetaLabResult;
  try {
    const outcome = await runLab(args.config, {
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      ...(wantsFollow ? { completionTimeoutMs: 0 } : {}),
      ...(codexAppServer === undefined ? {} : { codexAppServer }),
      ...(wantsFollow
        ? {
            onObserverReady: async (observer) => {
              if (!server) {
                server = await serveObserver(observer, { open: shouldOpen, port });
              }
            }
          }
        : {}),
      open: wantsFollow ? false : shouldOpen,
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(redactRepoNames === undefined ? {} : { redactRepos: redactRepoNames }),
      ...(repos === undefined ? {} : { repos }),
      count: count === null ? Number.NaN : count,
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
    });
    if (outcome.backend !== "meta") {
      throw new Error(`Expected meta backend, got ${outcome.backend}.`);
    }
    result = outcome.result;
  } catch (error) {
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(`watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    });
    server = null;
    throw error;
  }

  let output = result;
  if (server && shouldServeOssMetaLabObserver(result, { wantsFollow: true })) {
    liveRefresh = startOssMetaLabLiveRefresh(result);
    output = withOssMetaLabServer(result, server);
  } else if (shouldServeOssMetaLabObserver(result, { wantsFollow })) {
    server = await serveObserver(result.observer, { open: shouldOpen, port });
    liveRefresh = startOssMetaLabLiveRefresh(result);
    output = withOssMetaLabServer(result, server);
  } else {
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((error: unknown) => {
      args.io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    server = null;
  }

  const exitCode = exitCodeForOssMetaLab(output);
  writeResult(args.command, args.io, output, formatOssMetaLabHuman);
  args.io.setExitCode(exitCode);

  if (shouldForceExitAfterOssMetaLab(output, { detach: args.options.detach === true, wantsMachine })) {
    setTimeout(() => process.exit(exitCode), 50);
  }

  if (server && output.observer?.ok) {
    await followObserver(args.io, output.observer, server, output.liveRequested
	      ? {
	          onStop: async () => {
	            const cleanup = liveRefresh
	              ? await liveRefresh.cleanup()
	              : await cleanupOssMetaLabSandboxes(output);
	            return [
	              `E2B sandbox cleanup killed ${cleanup.killed}, skipped ${cleanup.skipped}.`,
	              ...cleanup.errors.map((error) => `E2B sandbox cleanup error: ${error}`)
            ];
          }
        }
      : {});
  }
}

async function renderAndMaybeFollowObserver(args: {
  command: Command;
  cwd: string;
  detach?: boolean | undefined;
  io: CliIo;
  open?: boolean | undefined;
  port: string;
  runInput: string;
}): Promise<void> {
  const port = parseObserverPort(args.port);
  if (port === null) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: args.cwd,
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_PORT",
        message: "--port must be an integer between 0 and 65535."
      }
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const wantsMachine = wantsJson(args.command);
  const shouldOpen = args.open === false ? false : args.open === true ? true : !wantsMachine && process.stdout.isTTY === true;
  const wantsFollow = !wantsMachine && args.detach !== true;
  const rendered = await renderObserver(args.cwd, args.runInput, { open: wantsFollow ? false : shouldOpen });
  let server: ObserverServer | null = null;
  let result = rendered;
  if (rendered.ok && wantsFollow) {
    server = await serveObserver(rendered, { open: shouldOpen, port });
    result = withObserverServer(rendered, server);
  }
  writeResult(args.command, args.io, result, formatObserverHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (result.ok && server) {
    await followObserver(args.io, result, server);
  }
}

async function applyEnvFileOption(args: {
  command: Command;
  cwd: string;
  envFile?: string | undefined;
  io: CliIo;
}): Promise<boolean> {
  if (args.envFile) {
    const result = await loadEnvFile(args.cwd, args.envFile);
    if (!result.ok) {
      writeResult(args.command, args.io, result, formatEnvFileHuman);
      args.io.setExitCode(2);
      return false;
    }
  }

  // Provider-key discovery (#436): fill still-missing keys from the documented project
  // overlay, the owning vendors' native stores, and the humanish user store — fill-only
  // (an explicit --env-file or process env always wins), each fill announced by name and
  // source on stderr, never by value. HUMANISH_STRICT_KEYS=1 restores env-only behavior.
  try {
    await keyDiscoveryFn({
      cwd: args.cwd,
      env: process.env,
      announce: (line) => args.io.writeErr(`${line}\n`)
    });
  } catch {
    // Discovery must never break a command; a rung that fails to read is a miss, not an error.
  }
  return true;
}

function labReposOverride(options: LabCommandOptions): string[] | undefined {
  const override = [
    ...(options.repo ?? []),
    ...(options.repos ? [options.repos] : [])
  ];
  return override.length > 0 ? override : undefined;
}

function parseLabCount(value: string | undefined, fallback: number): number | null {
  return value === undefined ? fallback : parsePositiveInteger(value);
}

function parseLaneIds(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const laneIds: string[] = [];
  for (const raw of value.split(",")) {
    const laneId = raw.trim();
    if (!laneId || seen.has(laneId)) continue;
    seen.add(laneId);
    laneIds.push(laneId);
  }
  return laneIds;
}

function withObserverServer(rendered: ObserverResult, server: ObserverServer): ObserverResult {
  return {
    ...rendered,
    observerUrl: server.url,
    serverUrl: server.url,
    opened: server.opened,
    ...(server.openCommand ? { openCommand: server.openCommand } : {}),
    warnings: [
      ...rendered.warnings,
      "Live observer server is polling observer-data.json with no-store caching.",
      ...(server.warning ? [server.warning] : [])
    ]
  };
}

function withOssMetaLabServer(result: OssMetaLabResult & { observer: ObserverResult & { ok: true } }, server: ObserverServer): OssMetaLabResult {
  return {
    ...result,
    observer: {
      ...result.observer,
      observerUrl: server.url,
      serverUrl: server.url,
      opened: server.opened,
      ...(server.openCommand ? { openCommand: server.openCommand } : {}),
      warnings: [
        ...result.observer.warnings,
        "Live OSS meta-lab server is polling observer-data.json with no-store caching.",
        ...(server.warning ? [server.warning] : [])
      ]
    },
    warnings: [
      ...result.warnings,
      "Live OSS meta-lab server is polling observer-data.json with no-store caching.",
      ...(server.warning ? [server.warning] : [])
    ]
  };
}

// Exported so tests/program.test.ts can drive the command-boundary catch-all's
// post-write guard (invocationEnvelopeAlreadyWritten above) through the same
// funnel every real command uses, without duplicating its stdout-vs-formatHuman
// branching. Not re-exported from src/index.ts; this stays an internal seam.
export function writeResult<T>(command: Command, io: CliIo, result: T, formatHuman: (result: T) => string): void {
  if (wantsJson(command)) {
    io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.writeOut(formatHuman(result));
  }
  markInvocationEnvelopeWritten(command);
  // Every backend's result passes through here, so this is where a study's facts get read for
  // telemetry — not in each backend, which is how they went unreported for two releases.
  noteStudyFacts(command, deriveStudyFacts(result));
}

const studyFactsByCommand = new WeakMap<Command, TelemetryProperties>();

function noteStudyFacts(command: Command, facts: TelemetryProperties): void {
  if (Object.keys(facts).length === 0) return;
  studyFactsByCommand.set(command, { ...studyFactsByCommand.get(command), ...facts });
}

/** Exported for tests: the facts writeResult read off a command's result document. */
export function studyFactsFor(command: Command): TelemetryProperties {
  return { ...studyFactsByCommand.get(command) };
}

function formatDoctorHuman(result: DoctorResult): string {
  return [
    `humanish doctor ${result.ok ? "ok" : "needs setup"}`,
    `cwd: ${result.cwd}`,
    // "missing" is a VERDICT, and a row that never ran has none. A participant reading doctor on a
    // fresh desktop got `- missing package.json: package.json is present and safe to read`, which
    // contradicts itself in eleven words (labs/tui-self-study.yaml).
    ...result.checks.map((check) => `- ${check.ok ? "ok" : check.checked === false ? "not checked" : "missing"} ${check.name}: ${check.message}`)
  ].join("\n") + "\n";
}

function formatRunHuman(result: RunResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    `humanish run ${result.mode}`,
    `run: ${result.runId}`,
    ...(result.simCount === undefined ? [] : [`sims: ${result.simCount}`]),
    `bundle: ${result.bundlePath}`,
    `review: ${result.reviewPath}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatVerifyHuman(result: VerifyResult): string {
  return [
    `humanish verify ${result.ok ? "passed" : "failed"}`,
    `run: ${result.run}`,
    `share-safety: ${result.shareSafety.status}`,
    ...result.shareSafety.reasons.map((reason) => `share-safety reason: ${reason.code}: ${reason.message}`),
    ...result.checks.map((check) => `- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatCleanupHuman(result: CleanupResult): string {
  if (!result.ok && result.error) {
    return `${result.error.code}: ${result.error.message}\n`;
  }

  return [
    `humanish cleanup ${result.ok ? "passed" : "failed"}`,
    `run: ${result.runId ?? result.run}`,
    `resources: killed ${result.summary.killed}, already-clean ${result.summary.alreadyClean}, skipped ${result.summary.skipped}, failed ${result.summary.failed}`,
    ...(result.cleanupPath ? [`cleanup: ${result.cleanupPath}`] : []),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatRunsHuman(result: RunsResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  if (result.runs.length === 0) {
    return `No Humanish runs found in ${result.cwd}\n`;
  }

  return [
    `latest: ${result.latest ?? "none"}`,
    ...result.runs.map((run) => `- ${run.runId} ${run.mode ?? "unknown"} ${run.createdAt ?? "unknown"} ${run.path}`)
  ].join("\n") + "\n";
}

function formatObserverHuman(result: ObserverResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "humanish observer rendered",
    `run: ${result.run}`,
    `observer: ${result.observerPath}`,
    ...(result.observerUrl ? [`url: ${result.observerUrl}`] : []),
    ...(result.opened === undefined ? [] : [`opened: ${result.opened ? "yes" : "no"}`]),
    `bundle: ${result.bundlePath}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatCodexAppServerUiHuman(result: CodexAppServerUiCliResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "humanish codex app-server",
    `url: ${result.url ?? "not-started"}`,
    `status: ${result.status ?? "unknown"}`,
    `state: ${result.stateFile ?? "none"}`,
    `reason: ${result.reason}`
  ].join("\n") + "\n";
}

function formatEnvFileHuman(result: EnvFileLoadResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "humanish env-file loaded",
    `env-file: ${result.envFile}`,
    `loaded: ${result.loaded.length ? result.loaded.join(", ") : "none"}`,
    `skipped-existing: ${result.skipped.length ? result.skipped.join(", ") : "none"}`
  ].join("\n") + "\n";
}

function formatLabListHuman(result: LabListResult): string {
  if (result.labs.length === 0) {
    return [
      `No Humanish labs found in ${result.cwd}`,
      "Create one under humanish/labs/*.yaml, .humanish/labs/*.yaml, or pass a .yaml path.",
      ...result.warnings.map((warning) => `warning: ${warning}`)
    ].join("\n") + "\n";
  }

  return [
    "humanish labs",
    ...result.labs.map((lab) => `- ${lab.id} ${lab.source} ${lab.origin} ${lab.path}${lab.title ? ` (${lab.title})` : ""}`),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatLabInspectHuman(result: LabInspectResult): string {
  if (!result.ok || !result.config) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  const config = result.config;
  return [
    "humanish lab",
    `id: ${config.id}`,
    `subject: ${config.subject.source}`,
    ...(config.execution?.target ? [`execution: ${config.execution.target}`] : []),
    `actors: ${config.actors.map((actor) => actor.type).join(", ")}`,
    ...(config.title ? [`title: ${config.title}`] : []),
    ...(config.description ? [`description: ${config.description}`] : []),
    ...(result.path ? [`path: ${result.path}`] : []),
    ...(result.origin ? [`origin: ${result.origin}`] : []),
    ...(config.subject.repos?.length ? [`repos: ${config.subject.repos.join(", ")}`] : []),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatLabPreflightHuman(result: LabPreflightResult): string {
  const checkedTargets = result.targets.filter((target) => target.checked);
  const reachableTargets = checkedTargets.filter((target) => target.reachable === true);
  const blockedTargets = result.targets.filter((target) => target.status === "blocked");
  return [
    `humanish lab preflight ${result.ok ? "passed" : "failed"}`,
    `lab: ${result.labId ?? result.lab}`,
    ...(result.backend ? [`backend: ${result.backend}`] : []),
    `reachability: ${result.reachability}`,
    `targets: ${checkedTargets.length ? `${reachableTargets.length}/${checkedTargets.length} reachable` : `${result.targets.length} declared, not checked`}`,
    ...(blockedTargets.length ? [`blocked-targets: ${blockedTargets.length}`] : []),
    `spend: ${result.spend.e2bDesktop ? "one e2b desktop, no model calls" : "none"}`,
    ...(result.sandbox.created
      ? [`sandbox: created=yes killed=${result.sandbox.killed === true ? "yes" : "no"}`]
      : []),
    ...result.checks.map((check) => `- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`),
    ...(result.error ? [`error: ${result.error.code}: ${result.error.message}`] : []),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatLabResolveFailureHuman(result: LabResolveFailure): string {
  return [
    `${result.error.code}: ${result.error.message}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

async function readCodexAppServerPrompt(options: {
  cwd: string;
  prompt?: string;
  promptFile?: string;
}): Promise<string | null> {
  if (options.prompt !== undefined && options.prompt.trim()) {
    return options.prompt;
  }
  if (options.promptFile !== undefined && options.promptFile.trim()) {
    const promptPath = resolve(options.cwd, options.promptFile);
    const text = await readFile(promptPath, "utf8");
    return text.trim() || null;
  }
  return null;
}

function codexAppServerUiError(
  cwd: string,
  code: NonNullable<CodexAppServerUiCliResult["error"]>["code"],
  message: string
): CodexAppServerUiCliResult {
  return {
    schema: "humanish.codex-app-server-ui-result.v1",
    ok: false,
    cwd: resolve(cwd),
    reason: message,
    error: { code, message }
  };
}

function codexAppServerUiResultFromState(state: CodexAppServerUiState): CodexAppServerUiCliResult {
  return {
    schema: "humanish.codex-app-server-ui-result.v1",
    ok: state.status === "passed",
    cwd: state.cwd,
    reason: state.reason,
    stateFile: state.stateFile,
    status: state.status,
    ...(state.url === undefined ? {} : { url: state.url })
  };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseTimeoutMs(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 3_600_000 ? parsed : null;
}

function parseObserverPort(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 65535 ? parsed : null;
}

type WatchStopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface WatchSignalTarget {
  once(event: WatchStopSignal, listener: () => void): unknown;
  removeListener(event: WatchStopSignal, listener: () => void): unknown;
}

export async function followObserver(
  io: CliIo,
  result: ObserverResult,
  server: ObserverServer,
  options: {
    onStop?: () => Promise<string[]>;
    signalTarget?: WatchSignalTarget;
    signals?: WatchStopSignal[];
  } = {}
): Promise<void> {
  io.writeOut(`watching: ${result.serverUrl ?? result.observerUrl ?? result.observerPath}\n`);
  io.writeOut("watching: press Ctrl-C to stop\n");
  await new Promise<void>((resolve) => {
    const signalTarget = options.signalTarget ?? process;
    const signals = options.signals ?? ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<WatchStopSignal, () => void>();
    let stopping = false;

    const stop = (signal: WatchStopSignal) => {
      if (stopping) {
        return;
      }

      stopping = true;
      for (const [registeredSignal, handler] of handlers.entries()) {
        signalTarget.removeListener(registeredSignal, handler);
      }
      io.setExitCode(exitCodeForSignal(signal));

      (async () => {
        try {
          await server.close();
        } catch (error: unknown) {
          io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }

        if (options.onStop) {
          try {
            const messages = await options.onStop();
            for (const message of messages) {
              io.writeOut(`watch cleanup: ${message}\n`);
            }
          } catch (error: unknown) {
            io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }

        io.writeOut("watch stopped\n");
        resolve();
      })();
    };

    for (const signal of signals) {
      const handler = () => stop(signal);
      handlers.set(signal, handler);
      signalTarget.once(signal, handler);
    }
  });
}

function exitCodeForSignal(signal: WatchStopSignal): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGHUP":
      return 129;
  }
}

function formatFeedbackHuman(result: FeedbackResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "humanish feedback ready",
    `run: ${result.run}`,
    ...(result.draftPath ? [`draft: ${result.draftPath}`] : []),
    ...(result.issuePath ? [`issue: ${result.issuePath}`] : [])
  ].join("\n") + "\n";
}

function formatOssLabHuman(result: OssLabResult): string {
  if (!result.ok && result.error) {
    return `${result.error.code}: ${result.error.message}\n`;
  }

  return [
    `humanish lab oss-smoke ${result.ok ? "passed" : "failed"}`,
    `run: ${result.runId}`,
    ...(result.reportMarkdownPath ? [`report: ${result.reportMarkdownPath}`] : []),
    `sandbox: ${result.cleanup.kept ? result.sandboxPath : "removed"}`,
    ...result.repos.map((repo) => {
      const passed = repo.steps.filter((step) => step.ok).length;
      return `- ${repo.ok ? "ok" : "fail"} ${repo.repo}: ${passed}/${repo.steps.length} steps, ${repo.changedFiles.length} changed files in disposable clone`;
    }),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatOssMetaLabHuman(result: OssMetaLabResult): string {
  return [
    `humanish lab oss ${result.ok ? (result.dryRun ? "dry-run" : "watch") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId ?? "not-created"}`,
    `repos: ${result.repos.join(", ")}`,
    ...(result.count === undefined ? [] : [`desktops: ${result.count}`]),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.observerUrl ? [`url: ${result.observer.observerUrl}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...(result.observer?.bundlePath ? [`bundle: ${result.observer.bundlePath}`] : []),
    ...result.assignments.map((assignment) => `- ${String(assignment.index).padStart(2, "0")} ${assignment.repo}: top-level desktop lane -> nested Humanish Observer`),
    ...result.sandboxes.map((sandbox) => {
      const sandboxLabel = sandbox.sandboxId ? ` sandbox=${sandbox.sandboxId}` : "";
      const bootstrapLabel = sandbox.bootstrapStatus ? ` bootstrap=${sandbox.bootstrapStatus}` : "";
      const completionLabel = sandbox.completionStatus ? ` completion=${sandbox.completionStatus}` : "";
      const screenshotLabel = sandbox.screenshotPresent ? " screenshot=yes" : "";
      return `sandbox ${sandbox.streamId}: ${sandbox.repo} stream=${sandbox.urlPresent ? "connected" : "missing"}${bootstrapLabel}${completionLabel}${screenshotLabel}${sandboxLabel}`;
    }),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatOssMetaLabCleanupHuman(result: {
  cleanup: {
    errors: string[];
    killed: number;
    matched?: number;
    remaining?: number;
    skipped: number;
  };
  lab: string;
  ok: boolean;
  schema: string;
}): string {
  return [
    `humanish lab cleanup ${result.lab} ${result.ok ? "passed" : "failed"}`,
    ...(result.cleanup.matched === undefined ? [] : [`matched: ${result.cleanup.matched}`]),
    `killed: ${result.cleanup.killed}`,
    `skipped: ${result.cleanup.skipped}`,
    ...(result.cleanup.remaining === undefined ? [] : [`remaining: ${result.cleanup.remaining}`]),
    ...result.cleanup.errors.map((error) => `error: ${error}`)
  ].join("\n") + "\n";
}

function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// True when any tunnel-edge exposure flag is present (not --safe, which is an orthogonal filter).
// Used to refuse exposure on the non-lab watch path and on non-CUA backends, where there is no live
// desktop to stream.
function watchExposeRequested(o: {
  expose?: boolean | undefined;
  tunnel?: string | undefined;
  tunnelDomain?: string | undefined;
  oauth?: string | undefined;
  allowEmail?: string[] | undefined;
  allowDomain?: string[] | undefined;
  publicUrl?: string | undefined;
}): boolean {
  return o.expose === true
    || o.tunnel !== undefined
    || o.tunnelDomain !== undefined
    || o.oauth !== undefined
    || (o.allowEmail?.length ?? 0) > 0
    || (o.allowDomain?.length ?? 0) > 0
    || o.publicUrl !== undefined;
}

// Map LabCommandOptions onto the shared exposure validator input.
function exposureRequestFromOptions(options: LabCommandOptions): ExposureRequest {
  return {
    expose: options.expose === true,
    ...(options.tunnel === undefined ? {} : { tunnel: options.tunnel }),
    ...(options.tunnelDomain === undefined ? {} : { tunnelDomain: options.tunnelDomain }),
    ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    allowEmails: options.allowEmail ?? [],
    allowDomains: options.allowDomain ?? [],
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    safe: options.safe === true
  };
}

function formatInitHuman(result: InitResult): string {
  const title = result.ok
    ? `humanish init ${result.mode}`
    : `humanish init ${result.mode} blocked`;
  const lines = [
    title,
    `cwd: ${result.cwd}`,
    "",
    "changes:",
    ...result.changes.map(formatInitChange)
  ];

  if (result.warnings.length > 0) {
    lines.push("", "warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  if (result.error) {
    lines.push("", `${result.error.code}: ${result.error.message}`);
  }

  if (result.mode === "needs-confirmation") {
    lines.push("", "Run with --dry-run --json to inspect or --yes to apply.");
  } else if (result.ok && result.nextSteps !== undefined) {
    // Twenty files and no next step is where the funnel died (#505). Increasingly the reader here
    // is a coding agent doing setup for someone, and an agent does what stdout tells it to.
    lines.push(...result.nextSteps);
  }

  return `${lines.join("\n")}\n`;
}

function formatInitChange(change: InitChange): string {
  return `- ${change.action.padEnd(6)} ${change.path} (${change.target}: ${change.reason})`;
}

export function shouldForceExitAfterOssMetaLab(
  output: OssMetaLabResult,
  options: { detach: boolean; wantsMachine: boolean }
): boolean {
  return output.liveRequested === true
    && (options.detach || options.wantsMachine)
    && output.sandboxes.some((sandbox) => sandbox.urlPresent);
}

export function shouldServeOssMetaLabObserver(
  output: OssMetaLabResult,
  options: { wantsFollow: boolean }
): output is OssMetaLabResult & { observer: ObserverResult & { ok: true } } {
  return options.wantsFollow
    && output.observer?.ok === true;
}

export function exitCodeForOssMetaLab(output: OssMetaLabResult): number {
  return output.ok ? 0 : 2;
}

function wantsJson(command: Command): boolean {
  let current: Command | null = command;

  while (current) {
    if (current.opts<{ json?: boolean }>().json === true) {
      return true;
    }

    current = current.parent ?? null;
  }

  return false;
}
