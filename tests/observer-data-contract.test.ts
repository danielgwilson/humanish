import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OBSERVER_DATA_SCHEMA, buildObserverData } from "../src/observer-data.js";
import type { RunBundle } from "../src/run.js";

// CONTRACT FREEZE for humanish.observer-data.v1 (#426). The Observer rebuild is a
// rendering-layer swap only if the data it renders cannot drift underneath it, so this
// test pins the bundle -> observer-data transform against committed goldens derived from
// the deterministic lab goldens in tests/golden/labs/ (same inputs as lab-golden.test.ts).
//
// The committed observer-data goldens double as the dev fixtures the new observer/
// workspace renders, so a shape change here is visible in the same diff that causes it.
//
// Intentional contract changes: rerun with UPDATE_OBSERVER_DATA_GOLDENS=1, review the
// golden diff, and say why in the commit message. Goldens are stored RAW (fixed
// generatedAt); normalization happens identically on both sides of the comparison, so
// the committed fixture stays human-diffable (same policy as tests/golden/labs/).

const ROOT = process.cwd();
const GOLDEN_DIR = path.join(ROOT, "tests", "golden", "observer-data");
const FIXED_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const GOLDENS = ["first-run", "oss"] as const;

// Same ambient-value masking as tests/lab-golden.test.ts: ISO timestamps and the
// environment-dependent git-state subtree are masked by value, keeping structure asserted.
function normalize(value: unknown, inGitState = false): unknown {
  if (inGitState && (value === null || typeof value !== "object")) {
    return "[git]";
  }
  if (typeof value === "string") {
    return value.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "[ts]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, inGitState));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nowInGitState = inGitState || obj.schema === "humanish.git-state.v1";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      out[key] = normalize(entry, nowInGitState);
    }
    return out;
  }
  return value;
}

describe("observer-data.v1 contract freeze", () => {
  for (const id of GOLDENS) {
    it(`${id} golden bundle produces the frozen observer-data shape`, async () => {
      const bundle = JSON.parse(
        await readFile(path.join(ROOT, "tests", "golden", "labs", `${id}.json`), "utf8")
      ) as RunBundle;

      const data = buildObserverData(bundle, FIXED_GENERATED_AT);
      expect(data.schema).toBe(OBSERVER_DATA_SCHEMA);
      expect(data.schemaVersion).toBe(1);

      const goldenPath = path.join(GOLDEN_DIR, `${id}.json`);
      if (process.env.UPDATE_OBSERVER_DATA_GOLDENS) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(goldenPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        return;
      }

      const golden = JSON.parse(await readFile(goldenPath, "utf8")) as unknown;
      expect(normalize(data)).toEqual(normalize(golden));
    });
  }
});
