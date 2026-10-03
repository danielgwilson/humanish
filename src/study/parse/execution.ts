import { resolveAutomaticAnalysis, type LabAnalysis } from "../../analysis/automatic-config.js";
import { DEVICE_PRESET_NAMES, isDevicePresetName } from "../device-presets.js";
import { isExactRuntimeVersion } from "../../routes/terminal/runtime.js";
import { invalid, nonNegNumber, posInt, str } from "./values.js";
import type {
  StudyParseFailure,
  StudyDefaults,
  StudyDesktopFidelity,
  StudyDesktopMedia,
  StudyExecution,
  StudyExecutionDesktop,
  StudyExecutionTerminal,
  StudyPolicies,
  StudyReview,
  StudyScenario,
  StudyScenarioCaps,
} from "../types.js";
import { isRecord } from "../../run/type-guards.js";

export function parseExecution(
  raw: unknown,
): { ok: true; value: StudyExecution | undefined } | StudyParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`execution` must be an object.");
  }
  const execution: StudyExecution = {};
  if (raw.target !== undefined) {
    const target = str(raw.target);
    if (target !== "local" && target !== "e2b-desktop" && target !== "e2b-terminal") {
      return invalid("`execution.target` must be local, e2b-desktop, or e2b-terminal.");
    }
    execution.target = target;
  }
  const timeoutMs = posInt(raw.timeoutMs);
  if (timeoutMs !== undefined) execution.timeoutMs = timeoutMs;
  const completionTimeoutMs = posInt(raw.completionTimeoutMs);
  if (completionTimeoutMs !== undefined) execution.completionTimeoutMs = completionTimeoutMs;
  const concurrency = posInt(raw.concurrency);
  if (concurrency !== undefined) execution.concurrency = concurrency;
  const desktopResult = parseDesktop(raw.desktop);
  if (!desktopResult.ok) {
    return desktopResult;
  }
  if (desktopResult.value) execution.desktop = desktopResult.value;
  // Reuse the terminal route's caps parser (same shape, not a fork); a malformed budget is a hard
  // error, never silently dropped (a cap that silently does nothing would be a safety lie).
  const capsResult = parseCaps(raw.caps);
  if (!capsResult.ok) {
    return capsResult;
  }
  if (capsResult.value) execution.caps = capsResult.value;
  const terminalResult = parseTerminal(raw.terminal);
  if (!terminalResult.ok) {
    return terminalResult;
  }
  if (terminalResult.value) execution.terminal = terminalResult.value;
  if (raw.runtime !== undefined) {
    if (
      !isRecord(raw.runtime) ||
      Object.keys(raw.runtime).some((key) => key !== "version") ||
      !isExactRuntimeVersion(raw.runtime.version)
    ) {
      return invalid(
        "`execution.runtime` must contain only an exact Codex `version` (for example 0.153.3); tags, ranges, URLs, and unknown fields are not accepted.",
      );
    }
    execution.runtime = { version: raw.runtime.version };
  }
  if (raw.runtimeAuth !== undefined) {
    const runtimeAuth = str(raw.runtimeAuth);
    if (runtimeAuth !== "openai-env" && runtimeAuth !== "openai-egress") {
      return invalid(
        "`execution.runtimeAuth` must be openai-env or openai-egress (the terminal agent's runtime-auth channel).",
      );
    }
    execution.runtimeAuth = runtimeAuth;
  }
  if (raw.egressAllow !== undefined) {
    if (!Array.isArray(raw.egressAllow) || raw.egressAllow.some((h) => typeof h !== "string")) {
      return invalid("`execution.egressAllow` must be an array of host strings.");
    }
    const hosts = (raw.egressAllow as string[]).map((h) => h.trim()).filter((h) => h.length > 0);
    if (hosts.length === 0) {
      // An empty list would deny everything including the agent's own model endpoint, which
      // fails as an unexplained hang rather than a refusal. Say so at parse time.
      return invalid(
        "`execution.egressAllow` was declared but empty. Declaring it denies all other egress, so " +
          "an empty list denies everything, including the agent's own provider endpoint. Remove " +
          "the field for unrestricted egress, or list the hosts the run needs.",
      );
    }
    execution.egressAllow = hosts;
  }
  return { ok: true, value: Object.keys(execution).length > 0 ? execution : undefined };
}

function parseTerminal(
  raw: unknown,
): { ok: true; value: StudyExecutionTerminal | undefined } | StudyParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`execution.terminal` must be an object ({ transport?, stdin? }).");
  }
  const terminal: StudyExecutionTerminal = {};
  if (raw.transport !== undefined) {
    const transport = str(raw.transport);
    if (transport !== "exec-stream") {
      // "pty" is deliberately rejected: stdin is disabled, so the capture is a non-interactive
      // exec stream, and an interactive-PTY label would overstate the mechanism. True duplex PTY
      // does not ship.
      return invalid(
        "`execution.terminal.transport` must be exec-stream: the route captures the agent's output with stdin closed, and an interactive terminal (pty) is not supported.",
      );
    }
    terminal.transport = transport;
  }
  if (raw.stdin !== undefined) {
    const stdin = str(raw.stdin);
    if (stdin !== "disabled" && stdin !== "planned" && stdin !== "sent") {
      return invalid("`execution.terminal.stdin` must be disabled, planned, or sent.");
    }
    if (stdin === "sent") {
      // Assisted input is forbidden until the interventions ledger + comparability flag + verify
      // check exist (the terminal route's stdin rule); shipping it now would let an assisted run
      // pose as autonomous green proof.
      return invalid(
        "`execution.terminal.stdin: sent` (assisted input) is not supported: the route cannot yet mark a run that received typed help as different from an unassisted one. Remove the setting; stdin stays closed.",
      );
    }
    terminal.stdin = stdin;
  }
  return { ok: true, value: Object.keys(terminal).length > 0 ? terminal : undefined };
}

function parseDesktop(
  raw: unknown,
): { ok: true; value: StudyExecutionDesktop | undefined } | StudyParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  const desktop: StudyExecutionDesktop = {};
  if (raw.recording !== undefined) {
    if (
      !isRecord(raw.recording) ||
      typeof raw.recording.audio !== "boolean" ||
      Object.keys(raw.recording).some((key) => key !== "audio")
    ) {
      return invalid(
        "`execution.desktop.recording` must be { audio: true|false }; omit it for snapshots only.",
      );
    }
    desktop.recording = { audio: raw.recording.audio };
  }
  if (raw.device !== undefined) {
    const device = str(raw.device);
    if (!device || !isDevicePresetName(device)) {
      return invalid(
        `\`execution.desktop.device\` must be one of: ${DEVICE_PRESET_NAMES.join(", ")}.`,
      );
    }
    desktop.device = device;
  }
  if (raw.resolution !== undefined) {
    const resolution = raw.resolution;
    if (
      !Array.isArray(resolution) ||
      resolution.length !== 2 ||
      !resolution.every((value) => Number.isInteger(value) && (value as number) > 0)
    ) {
      return invalid(
        "`execution.desktop.resolution` must be two positive integers [width, height].",
      );
    }
    desktop.resolution = [resolution[0] as number, resolution[1] as number];
  }
  const sandboxTimeoutMs = posInt(raw.sandboxTimeoutMs);
  if (sandboxTimeoutMs !== undefined) desktop.sandboxTimeoutMs = sandboxTimeoutMs;
  if (raw.browser !== undefined) {
    const browser = str(raw.browser);
    if (
      browser !== "default" &&
      browser !== "chrome" &&
      browser !== "chromium" &&
      browser !== "firefox"
    ) {
      return invalid("`execution.desktop.browser` must be default, chrome, chromium, or firefox.");
    }
    desktop.browser = browser;
  }
  // A custom E2B desktop template name or ID. Trimmed non-empty when present; deliberately not
  // allowlisted (any string is a valid template name/id; over-restricting would reject real
  // adopter images). An explicitly-set but blank/whitespace value is a mistake, not a template.
  if (raw.template !== undefined) {
    const template = str(raw.template);
    if (template === undefined) {
      return invalid(
        "`execution.desktop.template` must be a non-empty E2B desktop template name or ID when it is set. Any name is accepted.",
      );
    }
    desktop.template = template;
  }
  if (typeof raw.codexAppServer === "boolean") desktop.codexAppServer = raw.codexAppServer;
  if (raw.fidelity !== undefined) {
    if (!isRecord(raw.fidelity) || typeof raw.fidelity.mobileEmulation !== "boolean") {
      return invalid(
        "`execution.desktop.fidelity` must be an object with `mobileEmulation: true|false` (optional deviceScaleFactor, touch, userAgent).",
      );
    }
    const fidelity: StudyDesktopFidelity = { mobileEmulation: raw.fidelity.mobileEmulation };
    if (raw.fidelity.deviceScaleFactor !== undefined) {
      const scale = raw.fidelity.deviceScaleFactor;
      if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 4) {
        return invalid(
          "`execution.desktop.fidelity.deviceScaleFactor` must be a number greater than 0 and at most 4.",
        );
      }
      fidelity.deviceScaleFactor = scale;
    }
    if (raw.fidelity.touch !== undefined) {
      if (typeof raw.fidelity.touch !== "boolean") {
        return invalid("`execution.desktop.fidelity.touch` must be true or false.");
      }
      fidelity.touch = raw.fidelity.touch;
    }
    if (raw.fidelity.userAgent !== undefined) {
      const userAgent = str(raw.fidelity.userAgent);
      if (userAgent === undefined) {
        return invalid(
          "`execution.desktop.fidelity.userAgent` must be a non-empty string when set.",
        );
      }
      fidelity.userAgent = userAgent;
    }
    desktop.fidelity = fidelity;
  }
  if (raw.media !== undefined) {
    if (!isRecord(raw.media)) {
      return invalid(
        "`execution.desktop.media` must be an object with `camera` and/or `microphone` ({ source }).",
      );
    }
    const media: StudyDesktopMedia = {};
    if (raw.media.camera !== undefined) {
      const source = isRecord(raw.media.camera) ? str(raw.media.camera.source) : undefined;
      if (source === undefined || (source !== "synthetic" && !source.endsWith(".y4m"))) {
        return invalid(
          "`execution.desktop.media.camera.source` must be `synthetic` or a path to a `.y4m` file (Chrome's fake video capture reads Y4M).",
        );
      }
      media.camera = { source };
    }
    if (raw.media.microphone !== undefined) {
      const source = isRecord(raw.media.microphone) ? str(raw.media.microphone.source) : undefined;
      if (source !== "speech")
        return invalid(
          "`execution.desktop.media.microphone.source` must be `speech`. Microphone source-file injection is unsupported.",
        );
      media.microphone = { source };
    }
    if (media.camera === undefined && media.microphone === undefined) {
      return invalid("`execution.desktop.media` declares neither `camera` nor `microphone`.");
    }
    desktop.media = media;
  }
  return { ok: true, value: Object.keys(desktop).length > 0 ? desktop : undefined };
}

export function parsePersonas(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const personas = raw.filter(isRecord);
  return personas.length > 0 ? personas : undefined;
}

export function parseScenario(
  raw: unknown,
): { ok: true; value: StudyScenario | undefined } | StudyParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  const scenario: StudyScenario = {};
  const ref = str(raw.ref);
  if (ref) scenario.ref = ref;
  if (isRecord(raw.inline)) scenario.inline = raw.inline;
  const mode = str(raw.mode);
  if (mode === "dry-run" || mode === "live") scenario.mode = mode;
  const capsResult = parseCaps(raw.caps);
  if (!capsResult.ok) {
    return capsResult;
  }
  if (capsResult.value) scenario.caps = capsResult.value;
  return { ok: true, value: Object.keys(scenario).length > 0 ? scenario : undefined };
}

/**
 * Parse `scenario.caps`. Returns a parse failure on a malformed value rather than silently
 * dropping a budget declaration (a cap that silently does nothing would claim protection it
 * does not give). Each cap must be a non-negative finite number.
 */
function parseCaps(
  raw: unknown,
): { ok: true; value: StudyScenarioCaps | undefined } | StudyParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid(
      "`scenario.caps` must be an object ({ maxUsd?, maxTotalUsd?, maxJobs?, maxMinutes? }).",
    );
  }
  const caps: StudyScenarioCaps = {};
  for (const key of ["maxUsd", "maxTotalUsd", "maxJobs", "maxMinutes"] as const) {
    if (raw[key] === undefined) continue;
    const value = nonNegNumber(raw[key]);
    if (value === undefined) {
      return invalid(`\`scenario.caps.${key}\` must be a non-negative number.`);
    }
    caps[key] = value;
  }
  return { ok: true, value: Object.keys(caps).length > 0 ? caps : undefined };
}

const POLICY_FLAGS = [
  "redactRepos",
  "redactScreenshots",
  "allowPublicTargets",
  "allowPrivateRepoAccess",
  "allowProviderCredentials",
  "allowPaymentCredentials",
  "allowGitHubMutation",
] as const;

export function parsePolicies(
  raw: unknown,
): { ok: true; value: StudyPolicies | undefined } | StudyParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  // A quoted "true" would otherwise be dropped and the policy left at its default.
  for (const flag of POLICY_FLAGS) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean")
      return invalid(`\`policies.${flag}\` must be true or false (unquoted).`);
  }
  const policies: StudyPolicies = {};
  if (typeof raw.redactRepos === "boolean") policies.redactRepos = raw.redactRepos;
  if (typeof raw.redactScreenshots === "boolean")
    policies.redactScreenshots = raw.redactScreenshots;
  if (typeof raw.allowPublicTargets === "boolean")
    policies.allowPublicTargets = raw.allowPublicTargets;
  if (raw.mediaPermission === "prompt" || raw.mediaPermission === "granted")
    policies.mediaPermission = raw.mediaPermission;
  if (typeof raw.allowPrivateRepoAccess === "boolean")
    policies.allowPrivateRepoAccess = raw.allowPrivateRepoAccess;
  if (typeof raw.allowProviderCredentials === "boolean")
    policies.allowProviderCredentials = raw.allowProviderCredentials;
  if (typeof raw.allowPaymentCredentials === "boolean")
    policies.allowPaymentCredentials = raw.allowPaymentCredentials;
  if (typeof raw.allowGitHubMutation === "boolean")
    policies.allowGitHubMutation = raw.allowGitHubMutation;
  return { ok: true, value: Object.keys(policies).length > 0 ? policies : undefined };
}

export function parseReview(
  raw: unknown,
): { ok: true; value: StudyReview | undefined } | StudyParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return invalid("`review` must be a mapping.");
  const analysis = resolveAutomaticAnalysis(raw.analysis);
  if (!analysis.ok) return invalid(analysis.message);
  const review: StudyReview = {};
  if (raw.analysis !== undefined)
    review.analysis = raw.analysis === false ? false : { ...(raw.analysis as LabAnalysis) };
  const scoring = str(raw.scoring);
  if (scoring) review.scoring = scoring;
  const milestones = str(raw.milestones);
  if (milestones) review.milestones = milestones;
  const vocabulary = str(raw.vocabulary);
  if (vocabulary) review.vocabulary = vocabulary;
  if (raw.scorer !== undefined) {
    const scorer = parseReviewScorer(raw.scorer);
    if (!scorer.ok) return scorer;
    review.scorer = scorer.value;
  }
  return { ok: true, value: Object.keys(review).length > 0 ? review : undefined };
}

function parseReviewScorer(raw: unknown): { ok: true; value: { ref: string } } | StudyParseFailure {
  if (!isRecord(raw))
    return invalid(
      "`review.scorer` must be a mapping with a `ref` path (e.g. { ref: scorers/product.mjs }).",
    );
  const unknownKeys = Object.keys(raw).filter((key) => key !== "ref");
  if (unknownKeys.length > 0) {
    return invalid(
      `\`review.scorer\` accepts only \`ref\` (a scorer module path relative to the project), and these fields are unknown: ${unknownKeys.join(", ")}.`,
    );
  }
  const ref = str(raw.ref);
  if (!ref)
    return invalid(
      "`review.scorer.ref` must be a non-empty repo-relative path to a scorer module (.mjs recommended; .js/.cjs accepted).",
    );
  return { ok: true, value: { ref } };
}

export function parseDefaults(raw: unknown): StudyDefaults | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const defaults: StudyDefaults = {};
  if (typeof raw.open === "boolean") defaults.open = raw.open;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}
