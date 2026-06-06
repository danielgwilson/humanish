export const OSS_REMOTE_TELEMETRY_SCHEMA = "mimetic.oss-remote-telemetry.v1";

export type OssRemoteCompletionStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "timed_out"
  | "missing";

export type OssRemoteProcessState = "running" | "suspended" | "exited" | "unknown";
export type OssRemoteAppStatus = "running" | "stopped" | "missing" | "unknown";
export type OssRemoteActorState =
  | "running"
  | "suspended"
  | "passed"
  | "failed"
  | "blocked"
  | "timed_out"
  | "unknown";

export type OssRemoteLaneStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "timed_out"
  | "missing";

export interface OssRemoteTelemetryInput {
  actorStateText?: string | null;
  appStatusText?: string | null;
  appUrl?: string | null;
  checkedAt?: string;
  completionJson?: Record<string, unknown> | string | null;
  logTail?: string | null;
  nestedObserverPath?: string | null;
  nestedObserverPresent?: boolean | null;
  processStateText?: string | null;
  streamUrl?: string | null;
}

export interface OssRemoteCompletionTelemetry {
  checkedAt: string;
  present: boolean;
  reason: string;
  status: OssRemoteCompletionStatus;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
}

export interface OssRemoteTelemetry {
  schema: typeof OSS_REMOTE_TELEMETRY_SCHEMA;
  checkedAt: string;
  status: OssRemoteLaneStatus;
  completion: OssRemoteCompletionTelemetry;
  process: {
    state: OssRemoteProcessState;
    summary: string;
    text: string;
  };
  app: {
    status: OssRemoteAppStatus;
    statusText: string;
    url?: string;
  };
  stream: {
    present: boolean;
    url?: string;
  };
  nestedObserver: {
    presence: "present" | "missing" | "unknown";
    path?: string;
  };
  actor: {
    state: OssRemoteActorState;
    summary: string;
    text: string;
  };
  redaction: {
    status: "passed";
    redacted: boolean;
    fields: string[];
    notes: string;
  };
}

const REDACTED_URL_PARAM = "[redacted-url-param]";
const DEFAULT_COMPLETION_CHECKED_AT = "1970-01-01T00:00:00.000Z";

const secretPatterns: Array<{
  name: string;
  pattern: RegExp;
  replacement: string;
}> = [
  {
    name: "openai-token",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[redacted-openai-key]"
  },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
    replacement: "[redacted-github-token]"
  },
  {
    name: "e2b-token",
    pattern: /\be2b_[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[redacted-e2b-key]"
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: "Bearer [redacted-token]"
  },
  {
    name: "remote-home-path",
    pattern: /\/home\/(?:user|runner)\/[^\s"']+/gi,
    replacement: "[redacted-remote-path]"
  },
  {
    name: "remote-tmp-path",
    pattern: /\/tmp\/[^\s"']+/gi,
    replacement: "[redacted-remote-path]"
  }
];

export function buildOssRemoteTelemetry(input: OssRemoteTelemetryInput): OssRemoteTelemetry {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const redactedFields = new Set<string>();
  const sanitizeField = (field: string, value: string): string => {
    const sanitized = redactOssRemoteTelemetryText(value);
    if (sanitized !== value) {
      redactedFields.add(field);
    }
    return sanitized;
  };
  const sanitizeUrlField = (field: string, value: string): string => {
    const sanitized = sanitizeOssRemoteTelemetryUrl(value);
    if (sanitized !== value) {
      redactedFields.add(field);
    }
    return sanitized;
  };

  const fallbackLogTail = sanitizeField("logTail", input.logTail ?? "");
  const completion = parseOssRemoteCompletion(input.completionJson ?? null, {
    checkedAt,
    fallbackLogTail
  });

  const processText = sanitizeField("processStateText", input.processStateText ?? "");
  const process = {
    state: classifyOssRemoteProcessState(processText),
    summary: summarizeProcessState(processText),
    text: processText
  };

  const appStatusText = sanitizeField("appStatusText", input.appStatusText ?? "");
  const appUrl = normalizeOptionalText(input.appUrl);
  const sanitizedAppUrl = appUrl ? sanitizeUrlField("appUrl", appUrl) : undefined;
  const app = {
    status: classifyOssRemoteAppStatus({
      statusText: appStatusText,
      ...(sanitizedAppUrl ? { url: sanitizedAppUrl } : {})
    }),
    statusText: appStatusText,
    ...(sanitizedAppUrl ? { url: sanitizedAppUrl } : {})
  };

  const streamUrl = normalizeOptionalText(input.streamUrl);
  const sanitizedStreamUrl = streamUrl ? sanitizeUrlField("streamUrl", streamUrl) : undefined;
  const stream = {
    present: Boolean(sanitizedStreamUrl),
    ...(sanitizedStreamUrl ? { url: sanitizedStreamUrl } : {})
  };

  const nestedObserverPath = normalizeOptionalText(input.nestedObserverPath);
  const sanitizedNestedObserverPath = nestedObserverPath
    ? sanitizeField("nestedObserverPath", nestedObserverPath)
    : undefined;
  const nestedObserverPresent = input.nestedObserverPresent ?? completion.nestedObserverPresent;
  const nestedObserver = {
    presence: nestedObserverPresent === true
      ? "present" as const
      : nestedObserverPresent === false ? "missing" as const : "unknown" as const,
    ...(sanitizedNestedObserverPath ? { path: sanitizedNestedObserverPath } : {})
  };

  const actorText = sanitizeField("actorStateText", input.actorStateText ?? "");
  const actorState = classifyOssRemoteActorState(actorText, process.state, completion.status);
  const actor = {
    state: actorState,
    summary: summarizeActorState(actorState, actorText),
    text: actorText
  };

  const status = resolveLaneStatus(completion.status, process.state, app.status, actor.state);

  return {
    schema: OSS_REMOTE_TELEMETRY_SCHEMA,
    checkedAt,
    status,
    completion,
    process,
    app,
    stream,
    nestedObserver,
    actor,
    redaction: {
      status: "passed",
      redacted: redactedFields.size > 0,
      fields: [...redactedFields].sort(),
      notes: redactedFields.size > 0
        ? "Remote bootstrap evidence was sanitized before telemetry modeling."
        : "Remote bootstrap evidence contained no recognized token or auth URL patterns."
    }
  };
}

export function parseOssRemoteCompletion(
  payload: Record<string, unknown> | string | null | undefined,
  options: { checkedAt?: string; fallbackLogTail?: string } = {}
): OssRemoteCompletionTelemetry {
  const checkedAt = options.checkedAt ?? DEFAULT_COMPLETION_CHECKED_AT;
  const parsed = parseCompletionPayload(payload);
  if (!parsed) {
    return {
      checkedAt,
      present: false,
      ...(options.fallbackLogTail ? { logTail: tailLines(options.fallbackLogTail, 80) } : {}),
      reason: "Remote bootstrap completion marker is missing.",
      status: "missing"
    };
  }

  const status = normalizeOssRemoteCompletionStatus(parsed.status);
  if (!status) {
    return {
      checkedAt,
      present: false,
      ...(options.fallbackLogTail ? { logTail: tailLines(options.fallbackLogTail, 80) } : {}),
      reason: "Remote bootstrap completion marker is missing a recognized status.",
      status: "missing"
    };
  }

  const nestedVerifyPassed = normalizeNestedVerifyPassed(parsed);
  const logTail = typeof parsed.logTail === "string"
    ? tailLines(redactOssRemoteTelemetryText(parsed.logTail), 80)
    : options.fallbackLogTail ? tailLines(options.fallbackLogTail, 80) : undefined;

  return {
    checkedAt: typeof parsed.completedAt === "string" && parsed.completedAt.trim()
      ? redactOssRemoteTelemetryText(parsed.completedAt).trim()
      : checkedAt,
    present: true,
    reason: completionReason(parsed.reason, status),
    status,
    ...(typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? { exitCode: parsed.exitCode } : {}),
    ...(logTail ? { logTail } : {}),
    ...(typeof parsed.nestedObserverPresent === "boolean" ? { nestedObserverPresent: parsed.nestedObserverPresent } : {}),
    ...(nestedVerifyPassed === undefined ? {} : { nestedVerifyPassed })
  };
}

export function normalizeOssRemoteCompletionStatus(value: unknown): Exclude<OssRemoteCompletionStatus, "missing"> | null {
  return value === "running"
    || value === "passed"
    || value === "failed"
    || value === "blocked"
    || value === "timed_out"
    ? value
    : null;
}

export function classifyOssRemoteProcessState(text: string): OssRemoteProcessState {
  const normalized = text.trim();
  if (!normalized) {
    return "unknown";
  }

  if (/\bsuspended\b|\bstopped\b|\bsigtstp\b|\bsigstop\b/i.test(normalized)
    || /\bstate\s*[:=]\s*t\b/i.test(normalized)
    || /\bstat(?:e)?\s*[:=]?\s*[^\n]*\bT\+?\b/.test(normalized)
    || /(?:^|\n)\s*\d+\s+T\+?\s+\S+/.test(normalized)
    || /\bT\+?\s+(?:\d|pts\/|tty)/.test(normalized)) {
    return "suspended";
  }

  if (/\b(?:exited|exit code|terminated|defunct|zombie|not running|no process|dead)\b/i.test(normalized)) {
    return "exited";
  }

  if (/\b(?:running|listening|ready|started|pid\s*[=:]?\s*\d+)\b/i.test(normalized)
    || /\bstate\s*[:=]\s*[rs]\b/i.test(normalized)
    || /\bstat(?:e)?\s*[:=]?\s*[^\n]*\b[RS]\+?\b/.test(normalized)) {
    return "running";
  }

  return "unknown";
}

export function classifyOssRemoteAppStatus(input: { statusText?: string; url?: string }): OssRemoteAppStatus {
  const statusText = input.statusText?.trim() ?? "";
  if (!statusText && !input.url) {
    return "missing";
  }

  if (/\b(?:200|204|ok|healthy|ready|running|listening|started|serving|vite ready|compiled successfully)\b/i.test(statusText)) {
    return "running";
  }

  if (/\b(?:connection refused|eaddrinuse|failed|stopped|not running|timeout|timed out|cannot connect|no server)\b/i.test(statusText)) {
    return "stopped";
  }

  return input.url ? "unknown" : "missing";
}

export function classifyOssRemoteActorState(
  actorStateText: string,
  processState: OssRemoteProcessState = "unknown",
  completionStatus: OssRemoteCompletionStatus = "missing"
): OssRemoteActorState {
  const normalized = actorStateText.trim();
  if (/\bsuspended\b|\bstopped\b|\bsigtstp\b|\bsigstop\b/i.test(normalized) || processState === "suspended") {
    return "suspended";
  }

  if (/\btimed[ _-]?out\b|\btimeout\b/i.test(normalized) || completionStatus === "timed_out") {
    return "timed_out";
  }

  if (/\bblocked\b/i.test(normalized) || completionStatus === "blocked") {
    return "blocked";
  }

  if (/\b(?:failed|failure|exit code [1-9]\d*)\b/i.test(normalized) || completionStatus === "failed") {
    return "failed";
  }

  if (/\b(?:passed|success|complete|completed)\b/i.test(normalized) || completionStatus === "passed") {
    return "passed";
  }

  if (/\b(?:running|watching|active|spawned|pid\s*[=:]?\s*\d+)\b/i.test(normalized)
    || processState === "running"
    || completionStatus === "running") {
    return "running";
  }

  return "unknown";
}

export function redactOssRemoteTelemetryText(value: string): string {
  const withoutUrlSecrets = replaceUrls(value, sanitizeOssRemoteTelemetryUrl);
  return applySecretPatterns(withoutUrlSecrets);
}

export function sanitizeOssRemoteTelemetryUrl(value: string): string {
  return redactAuthQueryParams(applySecretPatterns(value));
}

function parseCompletionPayload(payload: Record<string, unknown> | string | null | undefined): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  if (typeof payload !== "string") {
    return payload;
  }

  if (!payload.trim()) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeNestedVerifyPassed(parsed: Record<string, unknown>): boolean | undefined {
  if (typeof parsed.nestedVerifyPassed === "boolean") {
    return parsed.nestedVerifyPassed;
  }

  if (parsed.nestedVerifyStatus === "passed") {
    return true;
  }

  if (parsed.nestedVerifyStatus === "failed") {
    return false;
  }

  return undefined;
}

function completionReason(reason: unknown, status: Exclude<OssRemoteCompletionStatus, "missing">): string {
  if (typeof reason === "string" && reason.trim()) {
    return compactReason(redactOssRemoteTelemetryText(reason));
  }

  switch (status) {
    case "passed":
      return "Remote bootstrap completed successfully.";
    case "failed":
      return "Remote bootstrap failed.";
    case "blocked":
      return "Remote bootstrap is blocked.";
    case "timed_out":
      return "Remote bootstrap completion timed out.";
    case "running":
      return "Remote bootstrap is still running.";
  }
}

function resolveLaneStatus(
  completionStatus: OssRemoteCompletionStatus,
  processState: OssRemoteProcessState,
  appStatus: OssRemoteAppStatus,
  actorState: OssRemoteActorState
): OssRemoteLaneStatus {
  if (completionStatus === "passed"
    || completionStatus === "failed"
    || completionStatus === "blocked"
    || completionStatus === "timed_out"
    || completionStatus === "running") {
    return completionStatus;
  }

  if (actorState === "failed" || actorState === "blocked" || actorState === "timed_out" || actorState === "passed") {
    return actorState;
  }

  if (actorState === "suspended" || processState === "suspended") {
    return "blocked";
  }

  if (actorState === "running" || processState === "running" || appStatus === "running") {
    return "running";
  }

  return "missing";
}

function summarizeProcessState(text: string): string {
  const state = classifyOssRemoteProcessState(text);
  switch (state) {
    case "running":
      return "Remote process state indicates the bootstrap or actor is still running.";
    case "suspended":
      return "Remote process state indicates the actor is suspended or stopped.";
    case "exited":
      return "Remote process state indicates the bootstrap or actor exited.";
    case "unknown":
      return text.trim()
        ? "Remote process state was captured but could not be classified."
        : "No remote process state captured.";
  }
}

function summarizeActorState(state: OssRemoteActorState, text: string): string {
  switch (state) {
    case "running":
      return "Actor state indicates work is still running.";
    case "suspended":
      return "Actor state indicates the process is suspended or stopped.";
    case "passed":
      return "Actor state indicates successful completion.";
    case "failed":
      return "Actor state indicates failure.";
    case "blocked":
      return "Actor state indicates a blocker.";
    case "timed_out":
      return "Actor state indicates timeout.";
    case "unknown":
      return text.trim()
        ? "Actor state was captured but could not be classified."
        : "No actor state captured.";
  }
}

function compactReason(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function tailLines(value: string, limit: number): string {
  return value.split(/\r?\n/).slice(-limit).join("\n").trim();
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function applySecretPatterns(value: string): string {
  return secretPatterns.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value
  );
}

function replaceUrls(value: string, replacer: (url: string) => string): string {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;\]]+$/)?.[0] ?? "";
    const body = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${replacer(body)}${trailing}`;
  });
}

function redactAuthQueryParams(value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart === -1) {
    return value;
  }

  const hashStart = value.indexOf("#", queryStart);
  const queryEnd = hashStart === -1 ? value.length : hashStart;
  const query = value.slice(queryStart + 1, queryEnd);
  const sanitizedQuery = query.split("&").map((part) => {
    if (!part) {
      return part;
    }

    const equalsIndex = part.indexOf("=");
    const key = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    if (!isAuthLikeQueryKey(key)) {
      return part;
    }

    return equalsIndex === -1 ? key : `${key}=${REDACTED_URL_PARAM}`;
  }).join("&");

  return `${value.slice(0, queryStart + 1)}${sanitizedQuery}${value.slice(queryEnd)}`;
}

function isAuthLikeQueryKey(value: string): boolean {
  const normalized = safeDecodeURIComponent(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("credential")
    || normalized.includes("auth")
    || normalized.includes("apikey")
    || normalized.includes("signature")
    || normalized.includes("bearer")
    || normalized.includes("jwt")
    || normalized.includes("session")
    || normalized === "key"
    || normalized.endsWith("key")
    || normalized === "sig";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
