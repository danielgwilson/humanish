import { invalid, posInt, str } from "./values.js";
import type {
  LabComms,
  LabCommsEmail,
  LabCommsExternal,
  LabCommsReceivingEmail,
  LabCommsRecipient,
  LabCommsSmtp,
  LabConfigParseFailure,
} from "../types.js";
import { isRecord } from "../../run/type-guards.js";

// Fail-loud (never silently swallow a comms setting): a malformed `comms` block returns a parse
// failure rather than being dropped.
export function parseComms(
  raw: unknown,
): { ok: true; value: LabComms | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return invalid("`comms` must be a mapping.");
  const comms: LabComms = {};
  if (raw.email !== undefined) {
    const email = parseCommsEmail(raw.email);
    if (!email.ok) return email;
    comms.email = email.value;
  }
  return { ok: true, value: Object.keys(comms).length > 0 ? comms : undefined };
}

/** A parsed optional field: its value when set, or a parse failure. */
type Parsed<T> = { ok: true; value: T | undefined } | LabConfigParseFailure;

function parseCommsEmail(raw: unknown): { ok: true; value: LabCommsEmail } | LabConfigParseFailure {
  if (!isRecord(raw)) return invalid("`comms.email` must be a mapping.");
  if (raw.connection !== undefined) return parseEmailConnection(raw);
  const unknown = Object.keys(raw).filter(
    (key) =>
      !["kind", "injectEnv", "port", "smtp", "linkOrigin", "recipients", "external"].includes(key),
  );
  if (unknown.length)
    return invalid(
      "Unknown email capture setting. Real inboxes select a saved `comms.email.connection`.",
    );
  if (raw.kind === "real") {
    return invalid(
      "Real inboxes require `comms.email.connection` naming a saved connection; omit kind.",
    );
  }
  if (raw.kind !== undefined && raw.kind !== "fake") {
    return invalid("`comms.email.kind` must be `fake`.");
  }
  // external ingress (#328): the ADOPTER runs the catch, so there is no subject env for humanish to
  // inject and `injectEnv` becomes meaningless rather than merely unused — the operator points their
  // own app at their own catch. Parse it first so the injectEnv requirement can key off it.
  const external = parseExternalCatch(raw.external);
  if (!external.ok) return external;
  const smtp = parseSmtp(raw.smtp);
  if (!smtp.ok) return smtp;

  const injectEnv = str(raw.injectEnv);
  if (injectEnv === undefined && external.value === undefined && smtp.value === undefined) {
    return invalid(
      "`comms.email` needs a transport: `injectEnv` (the subject-env var set to the catch's HTTP base URL, e.g. RESEND_BASE_URL), or `smtp` (host/port env vars, for an app that sends over SMTP), or `external` on an adopter-hosted plane where you run the catch yourself.",
    );
  }
  if (injectEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(injectEnv)) {
    return invalid(`\`comms.email.injectEnv\` must be a valid env var name (got "${injectEnv}").`);
  }
  const email: LabCommsEmail = {
    kind: "fake",
    ...(injectEnv === undefined ? {} : { injectEnv }),
    ...(smtp.value === undefined ? {} : { smtp: smtp.value }),
    ...(external.value === undefined ? {} : { external: external.value }),
  };
  const port = parseCatchPort(raw.port);
  if (!port.ok) return port;
  if (port.value !== undefined) email.port = port.value;
  const recipients = parseRecipients(raw.recipients);
  if (!recipients.ok) return recipients;
  if (recipients.value !== undefined) email.recipients = recipients.value;
  if (raw.linkOrigin !== undefined) {
    const linkOrigin = str(raw.linkOrigin);
    if (linkOrigin === undefined) return invalid("`comms.email.linkOrigin` must be a string.");
    try {
      new URL(linkOrigin);
    } catch {
      return invalid(
        `\`comms.email.linkOrigin\` must be an absolute URL origin (got "${linkOrigin}").`,
      );
    }
    email.linkOrigin = linkOrigin;
  }
  return { ok: true, value: email };
}

/** A real inbox: a saved connection, with optional link and allowed origins and nothing else. */
function parseEmailConnection(
  raw: Record<string, unknown>,
): { ok: true; value: LabCommsReceivingEmail } | LabConfigParseFailure {
  const unsupported = Object.keys(raw).filter(
    (key) => !["connection", "linkOrigin", "allowedOrigins"].includes(key),
  );
  if (unsupported.length)
    return invalid(
      "An email connection cannot be mixed with capture settings, kind, recipients, or provider options. Use only connection, optional linkOrigin and allowedOrigins.",
    );
  if (typeof raw.connection !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(raw.connection))
    return invalid(
      "`comms.email.connection` must name a saved connection (lowercase letters, digits and hyphens; at most 48 characters).",
    );
  const value: LabCommsReceivingEmail = { kind: "real", connection: raw.connection };
  if (raw.linkOrigin !== undefined) {
    const parsed = exactOrigin(raw.linkOrigin);
    if (!parsed)
      return invalid(
        "`comms.email.linkOrigin` must be an exact http(s) origin without credentials, query or fragment.",
      );
    value.linkOrigin = parsed;
  }
  if (raw.allowedOrigins !== undefined) {
    if (!Array.isArray(raw.allowedOrigins) || raw.allowedOrigins.length > 16)
      return invalid("`comms.email.allowedOrigins` must contain at most 16 exact http(s) origins.");
    const origins = raw.allowedOrigins.map(exactOrigin);
    if (origins.some((entry) => entry === undefined))
      return invalid(
        "`comms.email.allowedOrigins` accepts exact http(s) origins without credentials, query or fragment.",
      );
    value.allowedOrigins = [...new Set(origins as string[])];
  }
  return { ok: true, value };
}

/** The origin of an http(s) URL with no credentials, path, query or fragment, else undefined. */
function exactOrigin(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** `comms.email.external`: the catch the adopter runs, its inbox and the env var holding its token. */
function parseExternalCatch(raw: unknown): Parsed<LabCommsExternal> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return invalid("`comms.email.external` must be a mapping.");
  const catchBaseUrl = str(raw.catchBaseUrl);
  if (catchBaseUrl === undefined) {
    return invalid(
      "`comms.email.external.catchBaseUrl` is required — the base URL of the catch YOU run (humanish reads its GET /deliveries and your app POSTs its sends to it).",
    );
  }
  for (const [field, value] of [
    ["catchBaseUrl", catchBaseUrl],
    ["inboxBaseUrl", str(raw.inboxBaseUrl)],
  ] as const) {
    if (value === undefined) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return invalid(
        `\`comms.email.external.${field}\` must be an absolute http(s) URL (got "${value}").`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return invalid(
        `\`comms.email.external.${field}\` must be an absolute http(s) URL (got "${value}").`,
      );
    }
  }
  const authTokenEnv = str(raw.authTokenEnv);
  if (authTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authTokenEnv)) {
    return invalid(
      `\`comms.email.external.authTokenEnv\` must be a valid env var NAME (got "${authTokenEnv}"); the value is read at runtime and never persisted.`,
    );
  }
  const inboxBaseUrl = str(raw.inboxBaseUrl);
  return {
    ok: true,
    value: {
      catchBaseUrl,
      ...(inboxBaseUrl === undefined ? {} : { inboxBaseUrl }),
      ...(authTokenEnv === undefined ? {} : { authTokenEnv }),
    },
  };
}

/** SMTP transport, for apps that send mail through SMTP rather than a provider's HTTP API. */
function parseSmtp(raw: unknown): Parsed<LabCommsSmtp> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return invalid("`comms.email.smtp` must be a mapping.");
  const envName = (value: unknown, field: string): string | undefined => {
    const name = str(value);
    if (name === undefined) return undefined;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `__invalid__${field}`;
  };
  const hostEnv = envName(raw.hostEnv, "hostEnv");
  const portEnv = envName(raw.portEnv, "portEnv");
  if (hostEnv === undefined || portEnv === undefined) {
    return invalid(
      "`comms.email.smtp` needs both `hostEnv` and `portEnv` — the subject-env vars your app reads for its SMTP host and port. The harness sets them to its own loopback listener.",
    );
  }
  if (hostEnv.startsWith("__invalid__") || portEnv.startsWith("__invalid__")) {
    return invalid("`comms.email.smtp.hostEnv` and `portEnv` must be valid env var names.");
  }
  let smtpPort = 2525;
  if (raw.port !== undefined) {
    const parsed = posInt(raw.port);
    if (parsed === undefined || parsed > 65_535)
      return invalid("`comms.email.smtp.port` must be a positive integer ≤ 65535.");
    smtpPort = parsed;
  }
  const userEnv = envName(raw.userEnv, "userEnv");
  const passwordEnv = envName(raw.passwordEnv, "passwordEnv");
  if (userEnv?.startsWith("__invalid__") || passwordEnv?.startsWith("__invalid__")) {
    return invalid("`comms.email.smtp.userEnv` and `passwordEnv` must be valid env var names.");
  }
  return {
    ok: true,
    value: {
      port: smtpPort,
      hostEnv,
      portEnv,
      ...(userEnv === undefined ? {} : { userEnv }),
      ...(passwordEnv === undefined ? {} : { passwordEnv }),
      ...(str(raw.user) === undefined ? {} : { user: str(raw.user) as string }),
      ...(str(raw.password) === undefined ? {} : { password: str(raw.password) as string }),
    },
  };
}

/** `comms.email.port`: the catch's HTTP port. */
function parseCatchPort(raw: unknown): Parsed<number> {
  if (raw === undefined) return { ok: true, value: undefined };
  const port = posInt(raw);
  if (port === undefined) return invalid("`comms.email.port` must be a positive integer.");
  // Cap at 65534: the catch reserves port+1 for the read-only inbox listener on the shared-world route.
  if (port > 65_534)
    return invalid(
      "`comms.email.port` must be ≤ 65534 (the catch reserves port+1 for the inbox listener).",
    );
  return { ok: true, value: port };
}

/** The participant a declared inbox recipient belongs to. The manifest spells it `lane`. */
export function recipientParticipantId(recipient: LabCommsRecipient): string {
  return recipient.lane;
}

/** The declared recipients that name an address, in declaration order, by participant id. */
export function addressedRecipients(
  email: Pick<LabCommsEmail, "recipients">,
): { participantId: string; address: string }[] {
  return (email.recipients ?? []).flatMap((recipient) =>
    recipient.address === undefined
      ? []
      : [{ participantId: recipient.lane, address: recipient.address }],
  );
}

/** `comms.email.recipients`: which participant each captured address belongs to. */
function parseRecipients(raw: unknown): Parsed<LabCommsRecipient[]> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return invalid("`comms.email.recipients` must be a list.");
  const recipients: LabCommsRecipient[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return invalid("each `comms.email.recipients` entry must be a mapping.");
    const lane = str(entry.lane);
    if (lane === undefined) return invalid("each `comms.email.recipients` entry needs a `lane`.");
    const address = str(entry.address);
    recipients.push({ lane, ...(address === undefined ? {} : { address }) });
  }
  return { ok: true, value: recipients };
}
