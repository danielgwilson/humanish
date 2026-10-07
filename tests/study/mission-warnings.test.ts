import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { runStudy } from "../../src/run-study.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import { describe, expect, it } from "vitest";
import { parseStudy } from "../../src/study/config.js";
import { lab, type BaseName } from "../admission/fixtures.js";

function parsed(mission: string, base: BaseName = "cuAppUrl") {
  const result = parseStudy(lab(base, {}, { mission }));
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

const scripted = (warnings: readonly string[]) =>
  warnings.filter((warning) => warning.includes("reads like a script"));

describe("participant mission warnings", () => {
  it("warns about numbered steps without refusing the study", () => {
    const warnings = scripted(parsed("1. Create a note.\n2. Save it.").warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1. Create a note.");
    expect(warnings[0]).toContain("Saturday's event needs two setup volunteers");
  });
});

it("warns about bulleted steps and quotes at most three matched lines", () => {
  const warnings = scripted(
    parsed("- Create a note.\n* Save it.\n+ Review it.\n- Archive it.").warnings,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.split("\n").filter((line) => line.startsWith("> "))).toEqual([
    "> - Create a note.",
    "> * Save it.",
    "> + Review it.",
  ]);
});

it.each([
  "Click New, then finish your note.",
  "Tap New and press Save.",
  "Type the title into the box, select a category from the menu.",
  "Press Enter, then stop.",
  "Select Weekly from the menu, then continue.",
])("warns about chained UI actions: %s", (mission) => {
  expect(scripted(parsed(mission).warnings)).toHaveLength(1);
});

it.each(['Click "New".', "Tap 'Save'.", "Open “Settings”.", 'Use the "Submit" button.'])(
  "warns about quoted control labels: %s",
  (mission) => {
    expect(scripted(parsed(mission).warnings)).toHaveLength(1);
  },
);

it.each([
  "Use #new-note.",
  "Find .save-button.",
  'Use [data-testid="save"].',
  "Use main > button.",
])("warns about CSS selectors: %s", (mission) => {
  expect(scripted(parsed(mission).warnings)).toHaveLength(1);
});

it("warns about URLs beyond the subject entry point", () => {
  expect(scripted(parsed("Use http://127.0.0.1:3000/settings.").warnings)).toHaveLength(1);
  expect(scripted(parsed("Use https://example.com/help.").warnings)).toHaveLength(1);
  expect(scripted(parsed("The app is at http://127.0.0.1:3000/.").warnings)).toEqual([]);
  expect(scripted(parsed("The app is at http://127.0.0.1:3000.").warnings)).toEqual([]);
  expect(scripted(parsed("The app is at http://127.0.0.1:3000/.", "cuClone").warnings)).toEqual([]);
});

it("checks participant instructions and task goals but leaves researcher criteria alone", () => {
  for (const participants of [
    { count: 2, instruction: "Click New, then press Save." },
    [{ id: "writer", instruction: "Click New, then press Save." }],
  ]) {
    const result = parseStudy(lab("cuAppUrl", { participants }));
    if (!result.ok) throw new Error(result.error.message);
    expect(scripted(result.warnings)[0]).toMatch(/participants.*instruction/);
  }
  const result = parseStudy(
    lab(
      "cuAppUrl",
      {},
      {
        tasks: [
          {
            id: "note",
            goal: 'Click "New".',
            success: { any: [{ textIncludes: 'Click "Save".' }] },
          },
        ],
      },
    ),
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(scripted(result.warnings)).toHaveLength(1);
  expect(scripted(result.warnings)[0]).toContain("tasks[0].goal");
});

async function project(raw: unknown): Promise<string> {
  const cwd = await makeTestTempDir("humanish-mission-warnings-");
  await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
  await writeFile(path.join(cwd, "humanish/studies/example.yaml"), stringify(raw));
  return cwd;
}

it.each(["cuAppUrl", "sharedExternal"] as const)(
  "checks and records scripted missions on %s",
  async (base) => {
    const raw = lab(base, {}, { mission: 'Click "New".' });
    const cwd = await project(raw);
    const check = await runStudyPreflight({ cwd, study: "example" });
    expect(check.ok).toBe(true);
    expect(scripted(check.warnings)).toHaveLength(1);
    const result = parseStudy(raw);
    if (!result.ok) throw new Error(result.error.message);
    const outcome = await runStudy(result.config, { cwd, dryRun: true });
    const runId = outcome.result.runId;
    expect(runId).toBeDefined();
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish/runs", runId!, "run.json"), "utf8"),
    ) as RunBundle;
    expect(
      bundle.events.filter(
        (event) => event.type === "study.warning" && event.message.includes("reads like a script"),
      ),
    ).toEqual([expect.objectContaining({ level: "warn" })]);
  },
);

it.each(["cuAppUrl", "sharedExternal"] as const)(
  "warns and records missing participant backgrounds on %s",
  async (base) => {
    const raw = lab(
      base,
      {
        participants: [
          { id: "without-persona" },
          { id: "without-background", persona: "short-profile" },
        ],
      },
      { persona: undefined },
    );
    const cwd = await project(raw);
    await mkdir(path.join(cwd, "humanish/personas"));
    await writeFile(
      path.join(cwd, "humanish/personas/short-profile.yaml"),
      "name: Trial User\nsummary: Tries a new planning app.\n",
    );
    if (base === "sharedExternal") {
      raw.participants = [
        { id: "without-persona", host: true },
        { id: "without-background", persona: "short-profile" },
      ];
      await writeFile(path.join(cwd, "humanish/studies/example.yaml"), stringify(raw));
    }
    const check = await runStudyPreflight({ cwd, study: "example" });
    expect(check.ok).toBe(true);
    const warnings = check.warnings.filter((warning) =>
      warning.includes("has no persona background"),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("without-persona");
    expect(warnings[1]).toContain("without-background");
    expect(warnings.join("\n")).toContain(`humanish study show adm-${base.toLowerCase()} --json`);
    const result = parseStudy(raw);
    if (!result.ok) throw new Error(result.error.message);
    const outcome = await runStudy(result.config, { cwd, dryRun: true });
    const runId = outcome.result.runId;
    expect(runId).toBeDefined();
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish/runs", runId!, "run.json"), "utf8"),
    ) as RunBundle;
    expect(
      bundle.events
        .filter(
          (event) =>
            event.type === "study.warning" && event.message.includes("has no persona background"),
        )
        .map((event) => event.message),
    ).toEqual(warnings);
    expect(outcome.result.warnings).toEqual(expect.arrayContaining(warnings));
  },
);

it("does not flag situation text, quoted fixture facts or researcher criteria", () => {
  for (const mission of [
    "Saturday's event needs two setup volunteers and one cleanup volunteer. See whether this app helps you organize the event and keep people informed.",
    'Create a note titled "Launch checklist".',
    "You read the local press and want to organize an event.",
    "The task is to compare two plans, then decide whether either fits your budget.",
  ])
    expect(scripted(parsed(mission).warnings)).toEqual([]);
  const result = parseStudy(
    lab(
      "cuAppUrl",
      {},
      {
        tasks: [
          {
            id: "note",
            goal: "Keep a note for tomorrow.",
            success: { any: [{ textIncludes: 'Click "Save".' }] },
          },
        ],
      },
    ),
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(scripted(result.warnings)).toEqual([]);
});

it("skips scripted-browser and terminal participant text", () => {
  const terminal = parsed('1. Click "New", then press Save.', "terminal");
  expect(scripted(terminal.warnings)).toEqual([]);
  const result = parseStudy(lab("scriptedAppUrl"));
  if (!result.ok) throw new Error(result.error.message);
  expect(scripted(result.warnings)).toEqual([]);
});

it("uses inherited and overridden persona backgrounds for each participant", async () => {
  const raw = lab(
    "cuAppUrl",
    { participants: [{ id: "inherited" }, { id: "overridden", persona: "missing" }] },
    { persona: "experienced" },
  );
  const cwd = await project(raw);
  await mkdir(path.join(cwd, "humanish/personas"));
  await writeFile(
    path.join(cwd, "humanish/personas/experienced.yaml"),
    "background: Plans volunteer shifts in a notebook.\n",
  );
  const check = await runStudyPreflight({ cwd, study: "example" });
  expect(check.ok).toBe(true);
  const warnings = check.warnings.filter((warning) =>
    warning.includes("has no persona background"),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("overridden");
});

it("warns for every participant added by a run count override", async () => {
  const result = parsed("See whether the app fits your plans.");
  const cwd = await project(lab("cuAppUrl"));
  const outcome = await runStudy(result.config, { cwd, dryRun: true, count: 3 });
  expect(
    outcome.result.warnings.filter((warning) => warning.includes("has no persona background")),
  ).toHaveLength(3);
});

it.each(['Click the "New".', "Tap on the “Save”.", "Press `Continue`."])(
  "recognizes quoted controls with articles and code quotes: %s",
  (mission) => {
    expect(scripted(parsed(mission).warnings)).toHaveLength(1);
  },
);

it("quotes action chains split across mission lines", () => {
  const warnings = scripted(parsed("Click New.\nThen press Save.").warnings);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("> Click New.");
  expect(warnings[0]).toContain("> Then press Save.");
});

it.each(['Use input[name="title"].', "Use button.save.", "Find textarea#notes."])(
  "recognizes selectors qualified by an element name: %s",
  (mission) => {
    expect(scripted(parsed(mission).warnings)).toHaveLength(1);
  },
);
