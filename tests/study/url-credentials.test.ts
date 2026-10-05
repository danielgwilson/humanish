// A study URL is recorded in the run and shown in the participant's address bar, so the parser and
// the computer-use planner refuse one that carries userinfo or a credential parameter. Ordinary
// query strings still parse. Credential values are built at run time.
import { describe, expect, it } from "vitest";

import { parseStudyDocument } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { ALNUM, synthetic } from "../helpers/secret-formats.js";

type Raw = Record<string, unknown>;

const TOKEN = synthetic(ALNUM, 32, 7);
const BYPASS = `${"x-vercel-protection" + "-bypass"}=${TOKEN}`;
const SHARE = `${"_vercel" + "_share"}=${TOKEN}`;

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
  const result = parseStudyDocument(raw);
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
  ])("parses an ordinary query string: %s", (appUrl) => {
    const result = parseStudyDocument(publicStudy(appUrl));
    expect(result.ok).toBe(true);
  });

  it("refuses the same URL in a library caller's config, which skips the parser", () => {
    const parsed = parseStudyDocument(publicStudy("https://preview.example.com/"));
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

  it("refuses it on an external-public shared world in a library caller's config", () => {
    const parsed = parseStudyDocument({
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
    });
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
  });
});
