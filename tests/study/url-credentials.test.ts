// A study URL is recorded in the run and shown in the participant's address bar, so the parser and
// the computer-use planner refuse one that carries userinfo or a credential parameter. Ordinary
// query strings still parse. Credential values are built at run time.
import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { libraryConfig } from "../helpers/library-config.js";
import { ALNUM, synthetic } from "../helpers/secret-formats.js";

type Raw = Record<string, unknown>;

const TOKEN = synthetic(ALNUM, 32, 7);
const BYPASS = `${"x-vercel-protection" + "-bypass"}=${TOKEN}`;
const SHARE = `${"_vercel" + "_share"}=${TOKEN}`;
// An E2B app host, `<port>-<sandbox id>.e2b.app`, with an id built at run time.
const sandboxHost = (port: number, seed: number): string =>
  `${port}-${synthetic("abcdefghijklmnopqrstuvwxyz0123456789", 20, seed)}.${"e2b"}.app`;
const APP_HOST = sandboxHost(3000, 11);
const OTHER_HOST = sandboxHost(8025, 12);
const STREAM_KEY = synthetic(ALNUM, 16, 13);

const publicStudy = (appUrl: string, extra: Raw = {}): Raw => ({
  schema: STUDY_SCHEMA,
  id: "url-credentials",
  route: "computer-use",
  subject: { source: "app-url", appUrl },
  actor: { type: "openai-computer-use" },
  execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  policies: { allowPublicTargets: true },
  ...extra,
});

function refusal(raw: Raw): string {
  const result = parseStudy(raw);
  if (result.ok) throw new Error("parsed");
  expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  expect(result.error.message).not.toContain(TOKEN);
  return result.error.message;
}

describe("study URLs with credentials", () => {
  it.each([
    ["a user and password", `https://user:${TOKEN}@preview.example.com/`],
    ["a user name alone", `https://${TOKEN}@preview.example.com/`],
    ["a preview bypass parameter", `https://preview.example.com/?${BYPASS}`],
    ["a share parameter", `https://preview.example.com/dashboard?${SHARE}`],
    ["a percent-encoded parameter name", `https://preview.example.com/?%74oken=${TOKEN}`],
    ["a token in the fragment", `https://preview.example.com/#/callback?access_token=${TOKEN}`],
    ["a password alone", `https://:${TOKEN}@preview.example.com/`],
    ["a password with punctuation", `https://preview.example.com/?password=${TOKEN}!-${TOKEN}`],
    [
      "a key a dot-dot segment removes from the normalized path",
      `https://preview.example.com/${"sk-" + "proj-"}${TOKEN}${TOKEN}/../`,
    ],
    [
      "a base64 key in a path segment",
      `https://preview.example.com/x/${Buffer.from(`${"sk-" + "proj-"}${TOKEN}`).toString("base64")}`,
    ],
    [
      "a base64 key after a long path segment",
      `https://preview.example.com/${"a".repeat(65)}/${Buffer.from(`${"sk-" + "proj-"}${TOKEN}`).toString("base64")}`,
    ],
    [
      "a tab that the URL parser drops from an encoded key",
      (() => {
        const encoded = Buffer.from(`${"sk-" + "proj-"}${TOKEN}`).toString("base64");
        return `https://preview.example.com/${"a".repeat(65)}/${encoded.slice(0, 1)}\t${encoded.slice(1)}`;
      })(),
    ],
    [
      "a base64-encoded key",
      `https://preview.example.com/?payload=${Buffer.from(`${"sk-" + "proj-"}${TOKEN}`).toString("base64url")}`,
    ],
  ])("refuses subject.appUrl with %s", (_label, appUrl) => {
    expect(refusal(publicStudy(appUrl))).toMatch(/^`subject\.appUrl` /);
  });

  it("refuses a participant target with a credential and names that participant", () => {
    const message = refusal(
      publicStudy("https://preview.example.com/", {
        participants: [{ id: "a" }, { id: "b", target: `https://b.example.com/?${SHARE}` }],
      }),
    );
    expect(message).toMatch(/^`participants\[1\]\.target` /);
  });

  it("refuses userinfo in subject.serve.url", () => {
    const message = refusal({
      schema: STUDY_SCHEMA,
      id: "url-credentials",
      route: "computer-use",
      subject: {
        source: "clone",
        repos: ["acme/app"],
        serve: { start: "npm start", url: `http://admin:${TOKEN}@127.0.0.1:3000/` },
      },
      actor: { type: "openai-computer-use" },
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    });
    expect(message).toMatch(/^`subject\.serve\.url` /);
  });

  it.each([
    "https://preview.example.com/todos?filter=active&page=2",
    "https://www.example.com/?utm_source=newsletter&utm_campaign=launch-week",
    "https://preview.example.com/settings?tab=profile#billing",
    "https://preview.example.com/?token=%5BREDACTED_SECRET%5D",
    `https://preview.example.com/${"home"}/settings/profile`,
  ])("parses an ordinary query string: %s", (appUrl) => {
    const result = parseStudy(publicStudy(appUrl));
    expect(result.ok).toBe(true);
  });
});

// A credential in or beside an E2B URL nested in a study URL: [label, URL, secret it must not echo].
const NESTED_CREDENTIALS: readonly (readonly [string, string, string])[] = [
  [
    "a stream URL whose auth key rides its password parameter",
    `https://app.example.com/?next=${encodeURIComponent(`https://6080-${APP_HOST.slice(5)}/vnc.html?autoconnect=true&resize=scale&password=${STREAM_KEY}`)}`,
    STREAM_KEY,
  ],
  [
    "an E2B URL with a password in its user info",
    `https://app.example.com/?next=${encodeURIComponent(`https://user:${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "an E2B URL with a user name alone",
    `https://app.example.com/?next=${encodeURIComponent(`https://${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "an E2B URL as written with a user name alone",
    `https://app.example.com/?next=https://${TOKEN}${"@"}${APP_HOST}/`,
    TOKEN,
  ],
  [
    "an E2B URL with a password that holds an ampersand",
    `https://app.example.com/#next=https://user:pass&${TOKEN}${"@"}${APP_HOST}/`,
    TOKEN,
  ],
  [
    "an E2B URL with a user name longer than 256 characters",
    `https://app.example.com/?next=${encodeURIComponent(`https://${TOKEN.repeat(9)}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "a stream URL with an encoded password parameter name",
    `https://app.example.com/?next=${encodeURIComponent(`https://6080-${APP_HOST.slice(5)}/vnc.html?%70assword=${STREAM_KEY}`)}`,
    STREAM_KEY,
  ],
  [
    "a URL with a quote in its user info",
    `https://app.example.com/?next=${encodeURIComponent(`https://user:pass"${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone in a path segment",
    `https://app.example.com/redirect/${encodeURIComponent(`https://${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone in a fragment route's query",
    `https://app.example.com/#/callback?next=${encodeURIComponent(`https://${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone, encoded twice",
    `https://app.example.com/?next=${encodeURIComponent(encodeURIComponent(`https://${TOKEN}${"@"}${APP_HOST}/`))}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone in a fragment parameter",
    `https://app.example.com/#next=${encodeURIComponent(`https://${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone written whole in the fragment",
    `https://app.example.com/#https://${TOKEN}${"@"}${APP_HOST}/?view=compact`,
    TOKEN,
  ],
  [
    "a URL with a user name alone written whole in the path",
    `https://app.example.com/redirect/https://${TOKEN}${"@"}${APP_HOST}/`,
    TOKEN,
  ],
  [
    "a URL with a user name alone in a base64 state parameter",
    `https://app.example.com/callback?state=${Buffer.from(JSON.stringify({ returnTo: `https://${TOKEN}${"@"}${APP_HOST}/` })).toString("base64url")}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone, hex-encoded in a parameter",
    `https://app.example.com/callback?state=${Buffer.from(`https://${TOKEN}${"@"}${APP_HOST}/`).toString("hex")}`,
    TOKEN,
  ],
  [
    "a URL with a user name alone, base64-encoded twice in a parameter",
    `https://app.example.com/callback?state=${Buffer.from(Buffer.from(`https://${TOKEN}${"@"}${APP_HOST}/`).toString("base64")).toString("base64")}`,
    TOKEN,
  ],
  [
    "a URL with an apostrophe in its password, base64-encoded in a parameter",
    `https://app.example.com/callback?state=${Buffer.from(`https://user:p4ss'${TOKEN}${"@"}${APP_HOST}/`).toString("base64url")}`,
    TOKEN,
  ],
  [
    "a token parameter whose = is an HTML character reference",
    `https://app.example.com/?token&#61;${TOKEN}`,
    TOKEN,
  ],
  [
    "a stream URL whose password parameter name holds an encoded tab",
    `https://app.example.com/?next=${encodeURIComponent(`https://6080-${APP_HOST.slice(5)}/vnc.html?pass\tword=${STREAM_KEY}`)}`,
    STREAM_KEY,
  ],
  [
    "a URL with an ampersand in its user name, base64-encoded in a parameter",
    `https://app.example.com/callback?state=${Buffer.from(`https://reader&${TOKEN}${"@"}${APP_HOST}/`).toString("base64url")}`,
    TOKEN,
  ],
  [
    "a URL with an ampersand in its user name, hex-encoded in a parameter",
    `https://app.example.com/callback?state=${Buffer.from(`https://reader&${TOKEN}${"@"}${APP_HOST}/`).toString("hex")}`,
    TOKEN,
  ],
  [
    "a URL with an ampersand in its user name, base64-encoded twice",
    `https://app.example.com/callback?state=${Buffer.from(Buffer.from(`https://reader&${TOKEN}${"@"}${APP_HOST}/`).toString("base64url")).toString("base64url")}`,
    TOKEN,
  ],
  [
    "a stream URL with a tab in its password parameter name, base64-encoded twice",
    `https://app.example.com/callback?state=${Buffer.from(Buffer.from(`https://6080-${APP_HOST.slice(5)}/vnc.html?pass\tword=${STREAM_KEY}`).toString("base64url")).toString("base64url")}`,
    STREAM_KEY,
  ],
  [
    "a URL with a quote in its password, base64-encoded in a parameter",
    `https://app.example.com/callback?state=${Buffer.from(`https://user:pa"ss${TOKEN}${"@"}${APP_HOST}/`).toString("base64url")}`,
    TOKEN,
  ],
  [
    "a URL with an apostrophe in its user info",
    `https://app.example.com/?next=${encodeURIComponent(`https://o'hare:${TOKEN}${"@"}${APP_HOST}/`)}`,
    TOKEN,
  ],
  [
    "an E2B URL with a token parameter",
    `https://app.example.com/?next=${encodeURIComponent(`https://${APP_HOST}/invite?token=${TOKEN}`)}`,
    TOKEN,
  ],
  ["an E2B API key", `https://${APP_HOST}/?key=${"e2b" + "_"}${TOKEN}`, TOKEN],
  ["a token parameter on an E2B host", `https://${APP_HOST}/?token=${TOKEN}`, TOKEN],
  [
    "a signed URL signature",
    `https://bucket.example.com/a.png?X-Amz-Signature=${synthetic("0123456789abcdef", 64, 14)}`,
    "",
  ],
  ["a preview bypass parameter on an E2B host", `https://${APP_HOST}/?${BYPASS}`, TOKEN],
];

describe("study URLs that name an E2B sandbox", () => {
  it.each([
    [
      "its own URL, percent-encoded, as a sign-in return address",
      `https://${APP_HOST}/api/sign-in?origin=${encodeURIComponent(`https://${APP_HOST}`)}`,
    ],
    [
      "another sandbox's URL as written in a parameter",
      `https://${APP_HOST}/sign-in?inbox=https://${OTHER_HOST}/messages`,
    ],
    [
      "an E2B URL in a parameter of a host off E2B",
      `https://app.example.com/sign-in?return=${encodeURIComponent(`https://${APP_HOST}/home`)}`,
    ],
    [
      "an E2B URL, then an address, in the fragment",
      `https://app.example.com/#next=${encodeURIComponent(`https://${APP_HOST}`)}&email=${encodeURIComponent(["reader", "example.com"].join("@"))}`,
    ],
    [
      "an E2B URL in the fragment",
      `https://app.example.com/#next=${encodeURIComponent(`https://${APP_HOST}/`)}`,
    ],
    [
      "an E2B URL, then a parameter that holds an address",
      `https://app.example.com/?next=${encodeURIComponent(`https://${APP_HOST}`)}&email=${encodeURIComponent(["reader", "example.com"].join("@"))}`,
    ],
    [
      "an E2B URL, then a time and an address",
      `https://app.example.com/?next=${encodeURIComponent(`https://${APP_HOST}`)}&time=${encodeURIComponent("12:34")}&email=${encodeURIComponent(["reader", "example.com"].join("@"))}`,
    ],
    [
      "an E2B URL with a port, then an address as written",
      `https://app.example.com/?origin=${encodeURIComponent(`https://${APP_HOST}:3000`)}&email=${["reader", "example.com"].join("@")}`,
    ],
    [
      "an E2B URL, then a mailto link",
      `https://app.example.com/?next=${encodeURIComponent(`https://${APP_HOST}`)}&contact=${encodeURIComponent(`mailto:${["reader", "example.com"].join("@")}`)}`,
    ],
    [
      "a base64 JSON state with an E2B URL and an address",
      `https://app.example.com/callback?state=${Buffer.from(JSON.stringify({ next: `https://${APP_HOST}`, email: ["reader", "example.com"].join("@") })).toString("base64url")}`,
    ],
    [
      "a percent-encoded JSON state with an E2B URL and an address",
      `https://app.example.com/callback?state=${encodeURIComponent(JSON.stringify({ next: `https://${APP_HOST}`, email: ["reader", "example.com"].join("@") }))}`,
    ],
    [
      "the E2B docs page, then another parameter",
      `https://app.example.com/?next=${encodeURIComponent("https://docs.e2b.dev/api-key")}&view=compact`,
    ],
    [
      "an E2B URL inside a base64 state parameter",
      `https://app.example.com/callback?state=${Buffer.from(JSON.stringify({ returnTo: `https://${APP_HOST}/home` })).toString("base64url")}`,
    ],
  ])("parses subject.appUrl with %s", (_label, appUrl) => {
    const result = parseStudy(publicStudy(appUrl));
    expect(result.ok ? "parsed" : result.error.message).toBe("parsed");
  });

  it.each(NESTED_CREDENTIALS)(
    "refuses subject.appUrl with %s in it as a credential",
    (_label, appUrl, secret) => {
      const message = refusal(publicStudy(appUrl));
      expect(message).toMatch(
        /^`subject\.appUrl` carries a credential in its path, query or fragment/,
      );
      if (secret !== "") expect(message).not.toContain(secret);
    },
  );

  it("refuses user info on an E2B host as a user name or password", () => {
    const message = refusal(publicStudy(`https://user:${TOKEN}${"@"}${APP_HOST}/`));
    expect(message).toMatch(/^`subject\.appUrl` has a user name or password in it/);
  });

  it("parses a participant target that names an E2B sandbox", () => {
    const result = parseStudy(
      publicStudy(`https://${APP_HOST}/`, {
        participants: [
          {
            id: "a",
            target: `https://${OTHER_HOST}/sign-in?origin=${encodeURIComponent(`https://${OTHER_HOST}`)}`,
          },
        ],
      }),
    );
    expect(result.ok ? "parsed" : result.error.message).toBe("parsed");
  });
});

describe("study URLs with credentials in a library caller's config, which skips the parser", () => {
  it("refuses the same URL on computer-use", () => {
    const parsed = parseStudy(publicStudy("https://preview.example.com/"));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const config: StudyConfig = {
      ...parsed.config,
      subject: { ...parsed.config.subject, appUrl: `https://preview.example.com/?${BYPASS}` },
    };
    const planned = planStudy(config, { cwd: process.cwd(), dryRun: true });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_UNSAFE");
    expect(planned.refusal.message).not.toContain(TOKEN);
  });

  it.each([
    [
      "desktop-cli",
      (config: StudyConfig): StudyConfig => ({
        ...config,
        subject: {
          source: "desktop-cli",
          product: { name: "sample-cli", publicSurfaces: [`https://docs.example.com/?${SHARE}`] },
        },
      }),
    ],
    [
      "terminal",
      (): StudyConfig =>
        libraryConfig(
          publicStudy("https://preview.example.com/", {
            route: "terminal",
            subject: {
              source: "terminal-product",
              product: {
                name: "sample-cli",
                publicSurfaces: [`https://user:${TOKEN}@docs.example.com/`],
              },
            },
            actor: { type: "codex-exec" },
            execution: { target: "e2b-terminal" },
            policies: {},
          }),
        ),
    ],
  ])(
    "refuses a %s public surface with a credential in a library caller's config",
    (_route, change) => {
      const parsed = parseStudy(publicStudy("https://preview.example.com/"));
      if (!parsed.ok) throw new Error(parsed.error.message);
      const planned = planStudy(change(parsed.config), { cwd: process.cwd(), dryRun: true });
      expect(planned.ok).toBe(false);
      if (planned.ok) return;
      expect(planned.refusal.message).toMatch(/^`subject\.product\.publicSurfaces` /);
      expect(planned.refusal.message).not.toContain(TOKEN);
    },
  );

  it("refuses it on an external-public shared world in a library caller's config", () => {
    const shared = {
      schema: STUDY_SCHEMA,
      id: "url-credentials-shared",
      route: "shared-world",
      subject: {
        source: "app-url",
        appUrl: "https://lobby.example.com/",
        publicTarget: { owner: "example-org", authorized: true },
      },
      actor: { type: "openai-computer-use" },
      participants: [{ id: "host", host: true }, { id: "guest" }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      policies: { allowPublicTargets: true },
    };
    const parsed = parseStudy(shared);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const config: StudyConfig = {
      ...parsed.config,
      subject: { ...parsed.config.subject, appUrl: `https://user:${TOKEN}@lobby.example.com/` },
    };
    const planned = planStudy(config, { cwd: process.cwd(), dryRun: true });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.message).toMatch(/^`subject\.appUrl` has a user name or password/);
    expect(planned.refusal.message).not.toContain(TOKEN);

    // The parsed config with a credential in one entry; the parser fills the concurrency.
    const withEntry = libraryConfig({
      ...shared,
      participants: [
        { id: "host", host: true },
        { id: "guest", entry: `/lobby?token=${TOKEN}` },
      ],
      execution: { ...shared.execution, concurrency: 2 },
    });
    const entryPlanned = planStudy(withEntry, { cwd: process.cwd(), dryRun: true });
    expect(entryPlanned.ok).toBe(false);
    if (entryPlanned.ok) return;
    expect(entryPlanned.refusal.message).toMatch(/^`participants\[1\]\.entry` /);
  });

  it("refuses a terminal runtimeAuth it does not know in a library caller's config", () => {
    const config = libraryConfig(
      publicStudy("https://preview.example.com/", {
        route: "terminal",
        subject: {
          source: "terminal-product",
          product: { name: "sample-cli", publicSurfaces: ["https://docs.example.com/"] },
        },
        actor: { type: "codex-exec" },
        execution: { target: "e2b-terminal", runtimeAuth: "openai-egres" },
        policies: {},
      }),
    );
    const planned = planStudy(config, { cwd: process.cwd(), dryRun: true });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.code).toBe("HUMANISH_TERMINAL_CREDENTIAL_DENIED");
  });
});
