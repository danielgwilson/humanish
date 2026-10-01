// The committed scripted-first-run journey on a real browser, through playwright-core's real
// waitForFunction. Fake pages answer text checks themselves; only a real page shows whether the
// predicate the step executor sends can fail. CI runners carry Google Chrome, so CI requires a
// browser; elsewhere the test skips when none resolves.

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorPersonaRef } from "../../src/actors/contract.js";
import {
  runScriptedBrowserSession,
  type ScriptedBrowserSessionResult,
} from "../../src/actors/scripted-browser/actor.js";
import { resolveBrowserCommand } from "../../src/actors/scripted-browser/browser-command.js";
import { parseBrowserPersonaJourneyFromScenario } from "../../src/actors/scripted-browser/journey.js";
import { browserSurfaces } from "../../src/actors/scripted-browser/types.js";

const browserCommand = await resolveBrowserCommand();
const browserRequired = process.env.CI === "true";

const persona: ActorPersonaRef = {
  id: "scripted-journey",
  traitsApplied: [],
  promptDigest: "abcd1234abcd1234",
};

/** A signup page whose submit renders `reply`. The scenario's last step waits for "Welcome". */
function signupPage(reply: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Text check</title></head><body><main>',
    '<form id="signup"><input type="email" name="email"><button type="submit">Join</button></form>',
    '<p id="status"></p>',
    "<script>document.getElementById('signup').addEventListener('submit', (event) => {",
    `  event.preventDefault(); document.getElementById('status').textContent = ${JSON.stringify(reply)};`,
    "});</script>",
    "</main></body></html>",
  ].join("");
}

/** The first step that did not pass, with its own reason, for an assertion message. */
function outcomeOf(result: ScriptedBrowserSessionResult): string {
  const failing = result.capture.steps.find((step) => step.status !== "passed");
  return failing === undefined
    ? `no step failed; session: ${result.reason}`
    : `${failing.id} ${failing.status}: ${failing.reason}`;
}

async function committedJourney() {
  const relativePath = "humanish/scenarios/scripted-first-run.yaml";
  const parsed = parseBrowserPersonaJourneyFromScenario({
    raw: parse(await readFile(path.resolve(relativePath), "utf8")),
    relativePath,
    sourceDigest: "synthetic-digest",
  });
  if (!parsed.journey) throw new Error(parsed.failure ?? "the committed scenario has no journey");
  return parsed.journey;
}

describe.skipIf(browserCommand === null && !browserRequired)(
  "scripted text checks on a real browser",
  () => {
    let artifactRoot: string;
    let server: Server | undefined;
    beforeEach(async () => {
      artifactRoot = await mkdtemp(path.join(tmpdir(), "humanish-scripted-text-"));
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
      await rm(artifactRoot, { recursive: true, force: true });
    });

    async function runAgainst(reply: string) {
      if (browserCommand === null) {
        throw new Error("CI must resolve a Chromium browser for the real text-check test.");
      }
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(signupPage(reply));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return runScriptedBrowserSession({
        appUrl: `http://127.0.0.1:${port}/`,
        journey: await committedJourney(),
        surface: browserSurfaces[0]!,
        persona,
        // The journey budget outlasts the 8 s step wait, so a missing text fails its step.
        timeoutMs: 30_000,
        artifactRoot,
        browserCommand,
      });
    }

    it(
      "fails the confirm step when the page never shows the expected text",
      { timeout: 60_000 },
      async () => {
        const result = await runAgainst("Request received");
        expect(result.completionReason, outcomeOf(result)).toBe("step_failed");
        expect(result.reason).toContain("step-04-confirm");
      },
    );

    it(
      "passes the confirm step when the page shows the expected text",
      { timeout: 60_000 },
      async () => {
        const result = await runAgainst("Welcome aboard");
        expect(result.completionReason, outcomeOf(result)).toBe("goal_satisfied");
      },
    );
  },
);
