// `execution.egressAllow` acts only on the terminal route, whose sandbox is created with the list as
// an outbound allowlist. Every other route ignores it. Until the release that refuses it there, the parse
// warns, so `study check` and every run print it, and each run records it in its bundle.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { parseStudy } from "../../src/study/config.js";
import { lab, SCENARIO_YAML, type BaseName } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const allow = { execution: { egressAllow: ["example.com"] } };
const ignoredOn = (route: string) => (warning: string) =>
  warning.startsWith(`\`execution.egressAllow\` is ignored on route: ${route}.`) &&
  warning.includes("2026-11-04");

function parsed(base: BaseName) {
  const result = parseStudy(lab(base, allow));
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

async function project(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-egress-allow-");
  await writeFile(path.join(cwd, "package.json"), '{ "name": "egress-allow-fixture" }\n');
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return cwd;
}

async function dryRunEvents(base: BaseName): Promise<RunBundle["events"]> {
  const cwd = await project();
  const outcome = await runStudy(parsed(base).config, { cwd, dryRun: true });
  const { runId } = outcome.result as { runId?: string };
  if (runId === undefined) throw new Error(`no run: ${JSON.stringify(outcome.result)}`);
  const bundle = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as RunBundle;
  return bundle.events;
}

const routes: Array<[BaseName, string]> = [
  ["cuAppUrl", "computer-use"],
  ["sharedExternal", "shared-world"],
  ["scriptedAppUrl", "scripted"],
  ["preview", "preview"],
];

describe("execution.egressAllow off the terminal route", () => {
  it.each(routes)("parses %s with a warning that the field is ignored", (base, route) => {
    expect(parsed(base).warnings.filter(ignoredOn(route))).toHaveLength(1);
  });

  it("parses the warning after the roster warnings, next to the other warning a run records", () => {
    const result = parseStudy(
      lab(
        "cuAppUrl",
        { participants: { count: 2 }, execution: { ...allow.execution, concurrency: 1 } },
        { mission: 'Click "New".' },
      ),
    );
    if (!result.ok) throw new Error(result.error.message);
    const kinds = result.warnings.map((warning) =>
      warning.startsWith("execution.concurrency 1 caps a 2-participant roster")
        ? "concurrency"
        : ignoredOn("computer-use")(warning)
          ? "egressAllow"
          : warning.startsWith("actor.mission reads like a script")
            ? "scripted mission"
            : warning,
    );
    expect(kinds).toEqual(["concurrency", "egressAllow", "scripted mission"]);
  });

  it.each(routes)("records the warning in a %s run's bundle", async (base, route) => {
    const warnings = (await dryRunEvents(base)).filter(
      (event) => event.type === "study.warning" && ignoredOn(route)(event.message),
    );
    expect(warnings).toEqual([expect.objectContaining({ level: "warn" })]);
  });
});

describe("execution.egressAllow on the terminal route", () => {
  it("parses with no warning and keeps the list", () => {
    const result = parsed("terminal");
    expect(result.warnings.filter((warning) => warning.includes("egressAllow"))).toEqual([]);
    expect(result.config.execution?.egressAllow).toEqual(["example.com"]);
  });

  it("records no study warning in its bundle", async () => {
    const events = await dryRunEvents("terminal");
    expect(events.filter((event) => event.type === "study.warning")).toEqual([]);
  });
});
