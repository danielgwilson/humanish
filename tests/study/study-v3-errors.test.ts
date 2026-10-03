// What a humanish.study.v3 file may declare on each route, and the messages it gets when it
// declares something else. Messages name the v3 keys the author wrote.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { resolveStudyManifest } from "../../src/study/discover.js";
import { planStudy, resolveStudyDryRun } from "../../src/study/plan.js";
import { V2_SCHEMA, STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";

type Raw = Record<string, unknown>;

const study: Raw = {
  schema: STUDY_SCHEMA,
  id: "study-v3",
  route: "computer-use",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use" },
  execution: { target: "e2b-desktop", timeoutMs: 60_000 },
};

const scripted: Raw = {
  schema: STUDY_SCHEMA,
  id: "study-v3",
  route: "scripted",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
  actor: { type: "scripted-browser" },
  scenario: "scripted-first-run",
};

// The same file in the v2 spelling: `changes` holds its v2 keys.
function asV2(raw: Raw, changes: Raw): Raw {
  const copy: Raw = { ...raw, schema: V2_SCHEMA, ...changes };
  for (const key of ["route", "actor", "participants", "surfaces", "mode", "caps"])
    delete copy[key];
  return copy;
}

function config(raw: Raw): StudyConfig {
  const result = parseStudy(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

function refusal(raw: Raw): string {
  const result = parseStudy(raw);
  if (result.ok) throw new Error("parsed");
  expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  return result.error.message;
}

function participantCount(raw: Raw, count?: number): number {
  const result = planStudy(config(raw), {
    cwd: process.cwd(),
    dryRun: true,
    ...(count === undefined ? {} : { count }),
  });
  if (!result.ok || result.planned.plan.route !== "computer-use") throw new Error("no plan");
  return result.planned.plan.runner.participants.length;
}

describe("participants", () => {
  it("expands an entry with a count into `<id>-01` to `<id>-NN`, beside single entries", () => {
    const parsed = config({
      ...study,
      participants: [
        { id: "new", count: 2, persona: "synthetic-new-user" },
        { id: "solo" },
        { id: "one", count: 1 },
      ],
    });
    expect(parsed.actors[0]?.lanes).toEqual([
      { id: "new-01", persona: "synthetic-new-user" },
      { id: "new-02", persona: "synthetic-new-user" },
      { id: "solo" },
      { id: "one-01" },
    ]);
  });

  it("needs an id on an entry with a count", () => {
    expect(refusal({ ...study, participants: [{ count: 2 }] })).toContain(
      "participants[0] has a count, so it needs an `id`",
    );
    expect(refusal({ ...study, participants: [{ id: "x", count: 0 }] })).toBe(
      "participants[0].count must be a positive integer.",
    );
  });

  it("names the entry a bad key came from after groups expand", () => {
    expect(
      refusal({ ...study, participants: [{ id: "g", count: 2 }, { device: "toaster" }] }),
    ).toMatch(/^participants\[1\]\.device must be one of: /);
    expect(refusal({ ...study, participants: [{ id: "a", count: 1 }, { id: "a-01" }] })).toBe(
      'participants ids must be unique (duplicate "a-01").',
    );
  });

  it("reads `{ count, instruction }` as v2's count with laneFocus, so --count still applies", () => {
    const homogeneous = { ...study, participants: { count: 3, instruction: "Try the export." } };
    const v2 = config(
      asV2(study, {
        actors: [
          { type: "openai-computer-use", count: 3, laneFocus: { instruction: "Try the export." } },
        ],
      }),
    );
    expect({ ...config(homogeneous), schema: V2_SCHEMA }).toEqual(v2);
    expect(participantCount(homogeneous)).toBe(3);
    expect(participantCount(homogeneous, 5)).toBe(5);
    expect(participantCount({ ...study, participants: 2 })).toBe(2);
    expect(participantCount({ ...study, participants: [{}, {}] }, 5)).toBe(2);
  });

  it("refuses other keys on the object form", () => {
    expect(
      refusal({ ...study, participants: { count: 2, persona: "synthetic-new-user" } }),
    ).toContain("To set `persona`, write participants as a list.");
  });

  it("accepts only the forms each route reads", () => {
    expect(
      refusal({
        ...study,
        route: "preview",
        subject: { source: "this-repo" },
        participants: { count: 4 },
      }),
    ).toBe("route: preview takes `participants` as a count, such as `participants: 4`.");
    expect(refusal({ ...study, route: "shared-world" })).toContain(
      "route: shared-world takes `participants` as a list of at least two entries",
    );
    expect(refusal({ ...study, route: "shared-world", participants: 2 })).toContain(
      "as a list of at least two entries",
    );
    expect(refusal({ ...scripted, participants: 2 })).toContain(
      "route: scripted takes no `participants`.",
    );
    expect(refusal({ ...study, route: "terminal", participants: 1 })).toBe(
      "route: terminal takes no `participants`. It runs one agent.",
    );
    expect(refusal({ ...study, participants: 0 })).toBe(
      "`participants` must be a positive integer.",
    );
  });
});

describe("surfaces", () => {
  it("is the scripted route's count: desktop, or desktop and mobile", () => {
    const v2 = (count?: number) =>
      config(
        asV2(scripted, {
          scenario: { ref: "scripted-first-run" },
          actors: [{ type: "scripted-browser", ...(count === undefined ? {} : { count }) }],
        }),
      );
    const v3 = (raw: Raw) => ({ ...config(raw), schema: V2_SCHEMA });
    expect(v3(scripted)).toEqual(v2());
    expect(v3({ ...scripted, surfaces: ["desktop"] })).toEqual(v2(1));
    expect(v3({ ...scripted, surfaces: ["desktop", "mobile"] })).toEqual(v2(2));
  });

  it("refuses other lists and other routes", () => {
    expect(refusal({ ...scripted, surfaces: ["mobile"] })).toBe(
      "`surfaces` must be [desktop] or [desktop, mobile].",
    );
    expect(refusal({ ...study, surfaces: ["desktop"] })).toBe(
      "`surfaces` belongs to route: scripted. This study's route is computer-use; remove it.",
    );
  });
});

describe("caps", () => {
  it("moves to the route's own location", () => {
    expect(config({ ...study, caps: { maxUsd: 2 } }).execution?.caps).toEqual({ maxUsd: 2 });
  });

  it("refuses a caps key the route does not read", () => {
    expect(refusal({ ...study, caps: { maxJobs: 2 } })).toBe(
      "route: computer-use reads only caps.maxUsd, caps.maxTotalUsd. Remove caps.maxJobs.",
    );
    expect(refusal({ ...study, route: "terminal", caps: { maxTotalUsd: 2 } })).toBe(
      "route: terminal reads only caps.maxUsd, caps.maxJobs, caps.maxMinutes. Remove caps.maxTotalUsd.",
    );
    expect(refusal({ ...scripted, caps: { maxUsd: 1 } })).toBe(
      "route: scripted reads no `caps`; remove the block.",
    );
    expect(refusal({ ...study, caps: { maxUsd: -1 } })).toBe(
      "`caps.maxUsd` must be a non-negative number.",
    );
  });

  it("refuses execution.timeoutMs on the terminal route, whose deadline is caps.maxMinutes", () => {
    expect(refusal({ ...study, route: "terminal" })).toContain(
      "route: terminal does not read `execution.timeoutMs`",
    );
  });
});

describe("route, mode and the keys a route does not read", () => {
  it("needs a known route", () => {
    expect(refusal({ ...study, route: undefined })).toBe(
      "A study needs `route:`, one of preview, computer-use, shared-world, terminal, scripted.",
    );
  });

  it("refuses a route the subject and actor do not take", () => {
    expect(refusal({ ...study, route: "preview" })).toBe(
      "This study declares route: preview, but its subject (source: app-url) and actor (type: openai-computer-use) take the computer-use route. Change `route`, or change the subject or actor.",
    );
  });

  it("reads mode as v2's scenario.mode and refuses other values", () => {
    expect(resolveStudyDryRun(config({ ...study, mode: "live" }), undefined, true)).toBe(false);
    expect(resolveStudyDryRun(config(study), undefined, true)).toBe(true);
    expect(refusal({ ...study, mode: "livee" })).toBe(
      "`mode` must be `dry-run` or `live`. Leave it out for a dry run.",
    );
  });

  it("refuses each key the route does not read, by its v3 name", () => {
    expect(refusal({ ...study, scenario: "scripted-first-run" })).toBe(
      "route: computer-use does not read scenario. Remove it.",
    );
    expect(
      refusal({
        ...study,
        review: { scoring: "rubric" },
        execution: { ...(study.execution as Raw), completionTimeoutMs: 5 },
      }),
    ).toBe(
      "route: computer-use does not read execution.completionTimeoutMs, review.scoring (reserved; no route reads it yet). Remove them.",
    );
    expect(refusal({ ...scripted, actor: { type: "scripted-browser", mission: "x" } })).toBe(
      "route: scripted does not read actor.mission (the scripted-browser actor runs no model). Remove it.",
    );
  });

  it("points a v2 key at its v3 place", () => {
    expect(refusal(asV2(study, { schema: STUDY_SCHEMA, actors: [{ type: "x" }] }))).toContain(
      "A study has one `actor:` object",
    );
    expect(refusal({ ...study, actor: { type: "openai-computer-use", count: 2 } })).toContain(
      "`actor.count` moved to `participants:`",
    );
    expect(refusal({ ...study, subject: { source: "clone", topology: "shared-world" } })).toBe(
      "`subject.topology` moved to `route:`. A shared world is `route: shared-world`.",
    );
    expect(refusal({ ...study, execution: { target: "e2b-desktop", caps: { maxUsd: 1 } } })).toBe(
      "`execution.caps` moved to a top-level `caps:` block.",
    );
    expect(refusal({ ...study, personas: [{ id: "x" }] })).toMatch(
      /^Unknown study field\(s\): personas\. Known fields: schema, id, title, description, route, mode, /,
    );
    expect(refusal({ ...study, scenario: { ref: "x" } })).toBe(
      "`scenario` is a scenario id or a path to one, as a string.",
    );
    expect(refusal({ ...study, actor: {} })).toBe("actor.type is required.");
  });

  it("names both schemas when the schema is neither", () => {
    expect(refusal({ ...study, schema: "humanish.study.v2" })).toBe(
      "The study schema must be humanish.study.v3 or humanish.lab.v2.",
    );
  });
});

describe("discovery", () => {
  it("resolves a v3 file by path and keeps its schema in the config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "humanish-study-v3-"));
    try {
      await mkdir(path.join(root, "humanish", "labs"), { recursive: true });
      const file = path.join("humanish", "labs", "study-v3.yaml");
      await writeFile(path.join(root, file), stringify({ ...study, participants: 2 }));
      const resolved = await resolveStudyManifest(root, file);
      if (!resolved.ok) throw new Error(resolved.error.message);
      expect(resolved.config.schema).toBe(STUDY_SCHEMA);
      expect(resolved.config.actors[0]?.count).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
