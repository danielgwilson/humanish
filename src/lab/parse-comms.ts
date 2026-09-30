import { invalid, isRecord, posInt, str } from "./parse-values.js";
import type {
  LabComms,
  LabCommsEmail,
  LabCommsExternal,
  LabCommsReceivingEmail,
  LabCommsRecipient,
  LabCommsSmtp,
  LabConfigParseFailure,
} from "./types.js";

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

function parseCommsEmail(raw: unknown): { ok: true; value: LabCommsEmail } | LabConfigParseFailure {
  if (!isRecord(raw)) return invalid("`comms.email` must be a mapping.");
  if (raw.connection !== undefined) {
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
    const origin = (input: unknown): string | undefined => {
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
    };
    if (raw.linkOrigin !== undefined) {
      const parsed = origin(raw.linkOrigin);
      if (!parsed)
        return invalid(
          "`comms.email.linkOrigin` must be an exact http(s) origin without credentials, query or fragment.",
        );
      value.linkOrigin = parsed;
    }
    if (raw.allowedOrigins !== undefined) {
      if (!Array.isArray(raw.allowedOrigins) || raw.allowedOrigins.length > 16)
        return invalid(
          "`comms.email.allowedOrigins` must contain at most 16 exact http(s) origins.",
        );
      const origins = raw.allowedOrigins.map(origin);
      if (origins.some((entry) => entry === undefined))
        return invalid(
          "`comms.email.allowedOrigins` accepts exact http(s) origins without credentials, query or fragment.",
        );
      value.allowedOrigins = [...new Set(origins as string[])];
    }
    return { ok: true, value };
  }
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
  let external: LabCommsExternal | undefined;
  if (raw.external !== undefined) {
    if (!isRecord(raw.external)) return invalid("`comms.email.external` must be a mapping.");
    const catchBaseUrl = str(raw.external.catchBaseUrl);
    if (catchBaseUrl === undefined) {
      return invalid(
        "`comms.email.external.catchBaseUrl` is required — the base URL of the catch YOU run (humanish reads its GET /deliveries and your app POSTs its sends to it).",
      );
    }
    for (const [field, value] of [
      ["catchBaseUrl", catchBaseUrl],
      ["inboxBaseUrl", str(raw.external.inboxBaseUrl)],
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
    const authTokenEnv = str(raw.external.authTokenEnv);
    if (authTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authTokenEnv)) {
      return invalid(
        `\`comms.email.external.authTokenEnv\` must be a valid env var NAME (got "${authTokenEnv}"); the value is read at runtime and never persisted.`,
      );
    }
    const inboxBaseUrl = str(raw.external.inboxBaseUrl);
    external = {
      catchBaseUrl,
      ...(inboxBaseUrl === undefined ? {} : { inboxBaseUrl }),
      ...(authTokenEnv === undefined ? {} : { authTokenEnv }),
    };
  }

  // SMTP transport, for apps that send mail through SMTP rather than a provider's HTTP API.
  let smtp: LabCommsSmtp | undefined;
  if (raw.smtp !== undefined) {
    if (!isRecord(raw.smtp)) return invalid("`comms.email.smtp` must be a mapping.");
    const envName = (value: unknown, field: string): string | undefined => {
      const name = str(value);
      if (name === undefined) return undefined;
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `__invalid__${field}`;
    };
    const hostEnv = envName(raw.smtp.hostEnv, "hostEnv");
    const portEnv = envName(raw.smtp.portEnv, "portEnv");
    if (hostEnv === undefined || portEnv === undefined) {
      return invalid(
        "`comms.email.smtp` needs both `hostEnv` and `portEnv` — the subject-env vars your app reads for its SMTP host and port. The harness sets them to its own loopback listener.",
      );
    }
    if (hostEnv.startsWith("__invalid__") || portEnv.startsWith("__invalid__")) {
      return invalid("`comms.email.smtp.hostEnv` and `portEnv` must be valid env var names.");
    }
    let smtpPort = 2525;
    if (raw.smtp.port !== undefined) {
      const parsed = posInt(raw.smtp.port);
      if (parsed === undefined || parsed > 65_535)
        return invalid("`comms.email.smtp.port` must be a positive integer ≤ 65535.");
      smtpPort = parsed;
    }
    const userEnv = envName(raw.smtp.userEnv, "userEnv");
    const passwordEnv = envName(raw.smtp.passwordEnv, "passwordEnv");
    if (userEnv?.startsWith("__invalid__") || passwordEnv?.startsWith("__invalid__")) {
      return invalid("`comms.email.smtp.userEnv` and `passwordEnv` must be valid env var names.");
    }
    smtp = {
      port: smtpPort,
      hostEnv,
      portEnv,
      ...(userEnv === undefined ? {} : { userEnv }),
      ...(passwordEnv === undefined ? {} : { passwordEnv }),
      ...(str(raw.smtp.user) === undefined ? {} : { user: str(raw.smtp.user) as string }),
      ...(str(raw.smtp.password) === undefined
        ? {}
        : { password: str(raw.smtp.password) as string }),
    };
  }

  const injectEnv = str(raw.injectEnv);
  if (injectEnv === undefined && external === undefined && smtp === undefined) {
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
    ...(smtp === undefined ? {} : { smtp }),
    ...(external === undefined ? {} : { external }),
  };
  if (raw.port !== undefined) {
    const port = posInt(raw.port);
    if (port === undefined) return invalid("`comms.email.port` must be a positive integer.");
    // Cap at 65534: the catch reserves port+1 for the read-only inbox listener on the shared-world route.
    if (port > 65_534)
      return invalid(
        "`comms.email.port` must be ≤ 65534 (the catch reserves port+1 for the inbox listener).",
      );
    email.port = port;
  }
  if (raw.recipients !== undefined) {
    if (!Array.isArray(raw.recipients)) return invalid("`comms.email.recipients` must be a list.");
    const recipients: LabCommsRecipient[] = [];
    for (const entry of raw.recipients) {
      if (!isRecord(entry))
        return invalid("each `comms.email.recipients` entry must be a mapping.");
      const lane = str(entry.lane);
      if (lane === undefined) return invalid("each `comms.email.recipients` entry needs a `lane`.");
      const address = str(entry.address);
      recipients.push({ lane, ...(address === undefined ? {} : { address }) });
    }
    email.recipients = recipients;
  }
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
