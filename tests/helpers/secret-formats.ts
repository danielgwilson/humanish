// Synthetic secrets in the formats a run file can leak, and ordinary values that look a little like
// them. Every value is built when the module loads, so this file holds no literal that the
// public-surface scan or gitleaks would flag. None of these values is a working credential.

import { OPENAI_EGRESS_PLACEHOLDER } from "../../src/routes/terminal/runtime-auth.js";

function range(from: string, to: string): string {
  const start = from.charCodeAt(0);
  return Array.from({ length: to.charCodeAt(0) - start + 1 }, (_, index) =>
    String.fromCharCode(start + index),
  ).join("");
}

const UPPER = range("A", "Z");
const LOWER = range("a", "z");
const DIGITS = range("0", "9");
const HEX = DIGITS + range("a", "f");
/** Letters and digits, for a synthetic token. */
export const ALNUM = UPPER + LOWER + DIGITS;
const BASE64URL = `${ALNUM}-_`;

/** `length` characters drawn from `alphabet`, always the same for the same seed. */
export function synthetic(alphabet: string, length: number, seed: number): string {
  let state = seed >>> 0 || 1;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[(state >>> 8) % alphabet.length];
  }
  return out;
}

const base64url = (text: string): string => Buffer.from(text).toString("base64url");

const jwt = [
  base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  base64url(JSON.stringify({ sub: "participant-1", exp: 1_900_000_000 })),
  synthetic(BASE64URL, 43, 14),
].join(".");

export interface SecretFormat {
  readonly name: string;
  /** The value in a line as a run file would hold it. */
  readonly text: string;
}

/** One line per format. Each must make verify grade a run blocked. */
export const SECRET_FORMATS: readonly SecretFormat[] = [
  {
    name: "OpenAI project key",
    text: `request failed for key ${"sk-" + "proj-"}${synthetic(BASE64URL, 80, 1)}`,
  },
  {
    name: "Anthropic API key",
    text: `x-api-key: ${"sk-" + "ant-" + "api03-"}${synthetic(BASE64URL, 93, 2)}AA`,
  },
  { name: "GitHub classic token", text: `token ${"gh" + "p_"}${synthetic(ALNUM, 36, 3)}` },
  {
    name: "GitHub fine-grained token",
    text: `${"github" + "_pat_"}${synthetic(ALNUM, 22, 4)}_${synthetic(ALNUM, 59, 5)}`,
  },
  {
    name: "Vercel access token",
    text: `vercel deploy --token ${"vc" + "p_"}${synthetic(ALNUM, 24, 6)}`,
  },
  {
    name: "Vercel legacy token in an env line",
    text: `VERCEL_TOKEN=${synthetic(ALNUM, 24, 7)}`,
  },
  {
    name: "Vercel protection bypass in a URL",
    text: `opened https://preview-app-git-branch-acme.vercel.app/?${"x-vercel-protection" + "-bypass"}=${synthetic(ALNUM, 32, 8)}&x-vercel-set-bypass-cookie=true`,
  },
  {
    name: "Vercel share link",
    text: `https://preview-app-acme.vercel.app/dashboard?${"_vercel" + "_share"}=${synthetic(ALNUM, 32, 9)}`,
  },
  {
    name: "AWS access key id",
    text: `aws_access_key_id = ${"AK" + "IA"}${synthetic(UPPER + DIGITS, 16, 10)}`,
  },
  {
    name: "AWS secret access key",
    text: `aws_secret_access_key = ${synthetic(`${ALNUM}+/`, 40, 11)}`,
  },
  { name: "Google API key", text: `maps key ${"AI" + "za"}${synthetic(BASE64URL, 35, 12)}` },
  { name: "Google OAuth access token", text: `${"ya" + "29."}${synthetic(BASE64URL, 120, 13)}` },
  { name: "Stripe live secret key", text: `${"sk" + "_live_"}${synthetic(ALNUM, 99, 15)}` },
  { name: "Stripe test secret key", text: `${"sk" + "_test_"}${synthetic(ALNUM, 99, 16)}` },
  { name: "Stripe webhook secret", text: `${"wh" + "sec_"}${synthetic(ALNUM, 32, 17)}` },
  {
    name: "Slack bot token",
    text: `${"xo" + "xb-"}${synthetic(DIGITS, 12, 18)}-${synthetic(DIGITS, 13, 19)}-${synthetic(ALNUM, 24, 20)}`,
  },
  {
    name: "Slack webhook URL",
    text: `posted to https://hooks.slack.com/services/T${synthetic(UPPER + DIGITS, 10, 21)}/B${synthetic(UPPER + DIGITS, 10, 22)}/${synthetic(ALNUM, 24, 23)}`,
  },
  { name: "JWT", text: `session ${jwt}` },
  { name: "Bearer token", text: `Authorization: Bearer ${synthetic(BASE64URL, 40, 24)}` },
  {
    name: "Basic auth header",
    text: `Authorization: Basic ${Buffer.from(`deploy:${synthetic(ALNUM, 20, 25)}`).toString("base64")}`,
  },
  {
    name: "URL userinfo with a token password",
    text: `git clone https://deploy-bot:${synthetic(ALNUM, 20, 26)}@git.example.com/acme/app.git`,
  },
  { name: "URL userinfo user:pass", text: `opened https://user:pass${"@"}staging.example.com/` },
  {
    name: "URL userinfo with an empty user name",
    text: `https://:${synthetic(ALNUM, 20, 36)}${"@"}example.com/`,
  },
  {
    name: "variable quoted inside a JSON string",
    text: JSON.stringify({ line: `VERCEL_TOKEN="${synthetic(ALNUM, 24, 37)}"` }),
  },
  {
    name: "password parameter with punctuation",
    text: `https://example.com/?password=Correct${"Horse!Battery"}Staple${synthetic(DIGITS, 2, 38)}`,
  },
  {
    name: "token query parameter",
    text: `https://app.example.com/invite?token=${synthetic(BASE64URL, 32, 27)}`,
  },
  {
    name: "access_token in a URL fragment",
    text: `https://app.example.com/callback#access_token=${synthetic(BASE64URL, 40, 28)}&token_type=bearer`,
  },
  {
    name: "signed URL signature",
    text: `https://bucket.example.com/a.png?X-Amz-Credential=key%2F20261005&X-Amz-Signature=${synthetic(HEX, 64, 29)}`,
  },
  {
    name: "npm token",
    text: `//registry.npmjs.org/:${"_auth" + "Token"}=${"np" + "m_"}${synthetic(ALNUM, 36, 30)}`,
  },
  { name: "npm token alone", text: `${"np" + "m_"}${synthetic(ALNUM, 36, 31)}` },
  { name: "GitLab token", text: `${"gl" + "pat-"}${synthetic(BASE64URL, 20, 32)}` },
  {
    name: "SendGrid key",
    text: `${"S" + "G."}${synthetic(BASE64URL, 22, 33)}.${synthetic(BASE64URL, 43, 34)}`,
  },
  {
    name: "Hugging Face token",
    text: `${"h" + "f_"}${synthetic(ALNUM, 34, 35)}`,
  },
  {
    name: "Windows user profile path",
    text: `C:\\Users\\${"ali" + "ce"}\\AppData\\Local\\Temp\\run.log`,
  },
];

/** Values a run file holds in normal use. None may make verify grade a run blocked. */
export const ORDINARY_VALUES: readonly SecretFormat[] = [
  { name: "git sha", text: `commit ${synthetic(HEX, 40, 101)}` },
  { name: "sha256 digest", text: `sha256:${synthetic(HEX, 64, 102)}` },
  {
    name: "uuid",
    text: [8, 4, 4, 4, 12].map((length, index) => synthetic(HEX, length, 103 + index)).join("-"),
  },
  { name: "md5 etag", text: `etag: "${synthetic(HEX, 32, 110)}"` },
  { name: "secret marker", text: "OPENAI_API_KEY=[REDACTED_SECRET]" },
  { name: "sandbox id marker", text: `"sandboxId": "[redacted-sandbox-id]"` },
  { name: "sandbox id label", text: `[redacted-sandbox-id ${synthetic(HEX, 16, 111)}]` },
  { name: "E2B dashboard URL", text: "Get a key at https://e2b.dev/dashboard?tab=keys." },
  { name: "egress placeholder", text: `CODEX_API_KEY=${OPENAI_EGRESS_PLACEHOLDER}` },
  { name: "loopback app URL", text: "http://127.0.0.1:3000/todos?filter=active&page=2" },
  {
    name: "campaign query",
    text: "https://www.example.com/?utm_source=newsletter&utm_campaign=launch-week",
  },
  { name: "search query", text: "https://docs.example.com/search?q=access+token+rotation" },
  { name: "short key parameter", text: "http://127.0.0.1:3000/settings?key=profile&tab=2" },
  { name: "ssh clone URL", text: "ssh://git@github.com/acme/app.git" },
  { name: "username-only URL", text: "https://git@example.com/acme/app.git" },
  { name: "database URL without a password", text: "postgres://localhost:5432/app" },
  {
    name: "templated credentials",
    text: `https://x-access-token:${"$"}{GH_TOKEN}@github.com/acme/app.git?token=${"$"}{INVITE_TOKEN}`,
  },
  { name: "placeholder token", text: "https://app.example.com/invite?token=<your-invite-token>" },
  {
    name: "percent-encoded marker and placeholder",
    text: `https://app.example.com/?token=%5BREDACTED_SECRET%5D&access_token=%24%7BINVITE_TOKEN%7D`,
  },
  { name: "JSON number at a credential name", text: `{"TOKEN":1234567890123456,"next":"kept"}` },
  { name: "token usage", text: `{"inputTokens":1234,"outputTokens":567,"cachedTokens":0}` },
  { name: "prose", text: "Bearer tokens expire after an hour. Enter the password from the email." },
  { name: "run id", text: "cua-20261005-123456-ab12cd" },
  { name: "screenshot path", text: "screenshots/participant-1/turn-03-call-01.png" },
  { name: "timestamp", text: "2026-10-05T12:34:56.789Z" },
];
