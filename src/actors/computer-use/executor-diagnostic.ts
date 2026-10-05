// The diagnostic an executor attaches to a failure its driver did not declare: which step failed
// and what kind of failure it was, as two fixed words. It carries no error text. A browser error
// message can hold a form value, page text, a cookie pair or a file path, and redaction on the
// host cannot be relied on to catch all of them, so the message never leaves the classifier.

/** The driver steps a diagnostic can name. */
export const CUA_DIAGNOSTIC_STEPS = Object.freeze([
  "owner_window_check",
  "cdp_session",
  "frame_tree",
  "isolated_world",
  "focus_probe",
  "insert_text",
  "cdp_detach",
  "text_port",
  "channel",
  "channel_write",
] as const);
export type CuaDiagnosticStep = (typeof CUA_DIAGNOSTIC_STEPS)[number];

/** The kinds of failure a diagnostic can name. */
export const CUA_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "target_closed",
  "detached",
  "navigation",
  "timeout",
  "protocol_error",
  "channel_closed",
  "unknown",
] as const);
export type CuaDiagnosticCategory = (typeof CUA_DIAGNOSTIC_CATEGORIES)[number];

export interface CuaExecutorDiagnostic {
  readonly step: CuaDiagnosticStep;
  readonly category: CuaDiagnosticCategory;
}

const STEP_LABELS: Readonly<Record<CuaDiagnosticStep, string>> = Object.freeze({
  owner_window_check: "checking the owner window",
  cdp_session: "opening a DevTools session (newCDPSession)",
  frame_tree: "reading the frame tree (Page.getFrameTree)",
  isolated_world: "creating the isolated world (Page.createIsolatedWorld)",
  focus_probe: "probing focus (Runtime.evaluate)",
  insert_text: "inserting text (Input.insertText)",
  cdp_detach: "detaching the DevTools session (CDPSession.detach)",
  text_port: "running a text port step",
  channel: "reading the browser-control channel",
  channel_write: "writing to the browser-control channel",
});

const CATEGORY_SENTENCES: Readonly<Record<CuaDiagnosticCategory, string>> = Object.freeze({
  target_closed: "the page, its browser context or the browser closed",
  detached: "the DevTools session or the frame detached",
  navigation: "the page navigated or its document was replaced",
  timeout: "the call timed out",
  protocol_error: "the browser refused a DevTools protocol call",
  channel_closed: "the channel to the guest closed",
  unknown: "the error matched no known kind",
});

/** Error classes that name their category on their own. */
const ERROR_CLASSES: Readonly<Record<string, CuaDiagnosticCategory>> = Object.freeze({
  TargetClosedError: "target_closed",
  TimeoutError: "timeout",
  ProtocolError: "protocol_error",
});

/** Node system error codes a broken channel or socket reports. */
const SYSTEM_CODES: Readonly<Record<string, CuaDiagnosticCategory>> = Object.freeze({
  EPIPE: "channel_closed",
  ECONNRESET: "channel_closed",
  ERR_STREAM_DESTROYED: "channel_closed",
  ERR_STREAM_PREMATURE_CLOSE: "channel_closed",
  ERR_STREAM_WRITE_AFTER_END: "channel_closed",
  ETIMEDOUT: "timeout",
});

/**
 * Known Playwright and Chromium message shapes, checked in order; the first match names the
 * category. The message is only tested here, never copied.
 */
const MESSAGE_SHAPES: ReadonlyArray<readonly [RegExp, CuaDiagnosticCategory]> = Object.freeze([
  [/detached|No session with given id/i, "detached"],
  [
    /\b(?:target|page|context|browser|session)\b[^.]*\b(?:closed|crashed|disconnected)\b/i,
    "target_closed",
  ],
  [/navigat|Execution context was destroyed|Cannot find context with specified id/i, "navigation"],
  [/timed? ?out|timeout/i, "timeout"],
  [/\bProtocol error\b/i, "protocol_error"],
]);

function categoryOf(error: unknown): CuaDiagnosticCategory {
  if (!(error instanceof Error)) return "unknown";
  if (Object.hasOwn(ERROR_CLASSES, error.name)) return ERROR_CLASSES[error.name]!;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && Object.hasOwn(SYSTEM_CODES, code)) return SYSTEM_CODES[code]!;
  const message = typeof error.message === "string" ? error.message : "";
  return MESSAGE_SHAPES.find(([shape]) => shape.test(message))?.[1] ?? "unknown";
}

/** The diagnostic for `error`, thrown during `step`: the step and a category, never its text. */
export function classifyExecutorFailure(
  step: CuaDiagnosticStep,
  error: unknown,
): CuaExecutorDiagnostic {
  return { step, category: categoryOf(error) };
}

export function isCuaExecutorDiagnostic(value: unknown): value is CuaExecutorDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const { step, category } = value as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    (CUA_DIAGNOSTIC_STEPS as readonly unknown[]).includes(step) &&
    (CUA_DIAGNOSTIC_CATEGORIES as readonly unknown[]).includes(category)
  );
}

/** The fixed sentence for a trace or a failure record, built only from the two words. */
export function describeExecutorDiagnostic(diagnostic: CuaExecutorDiagnostic): string {
  const { step, category } = diagnostic;
  return `${step}, ${category}: ${CATEGORY_SENTENCES[category]} while ${STEP_LABELS[step]}`;
}
