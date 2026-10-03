import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { V2_SCHEMA } from "../../src/study/types.js";
import { parseStudyDocument } from "../../src/study/config.js";

const base = {
  schema: V2_SCHEMA,
  id: "keys",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actors: [{ type: "openai-computer-use", mission: "Explore the app." }],
  execution: { target: "e2b-desktop" },
};

function message(config: Record<string, unknown>): string {
  const result = parseStudyDocument(config);
  if (result.ok) throw new Error("expected the lab to be rejected");
  expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  return result.error.message;
}

describe("unknown lab fields", () => {
  it("rejects a top-level typo and suggests the field", () => {
    expect(message({ ...base, executon: { concurrency: 2 } })).toContain(
      "Unknown study field: executon (did you mean `execution`?)",
    );
  });

  it("names the path inside arrays", () => {
    const text = message({
      ...base,
      actors: [
        {
          type: "openai-computer-use",
          lanes: [{ id: "a" }, { id: "b", stopWhen: { any: [{ urlInclude: "/done" }] } }],
        },
      ],
    });
    expect(text).toContain(
      "in `actors[0].lanes[1].stopWhen.any[0]`: urlInclude (did you mean `urlIncludes`?)",
    );
  });

  it("lists every unknown key at the first mapping that has one", () => {
    expect(message({ ...base, policies: { redactScreenshot: true, allowAll: true } })).toContain(
      "in `policies`: redactScreenshot (did you mean `redactScreenshots`?), allowAll.",
    );
  });

  it.each(["constructor", "toString", "__proto__"])(
    "treats %s as an unknown key rather than an inherited property",
    (key) => {
      const execution = JSON.parse(`{"target":"e2b-desktop","${key}":1}`) as object;
      expect(message({ ...base, execution })).toContain(`in \`execution\`: ${key}`);
    },
  );

  it("rejects a quoted boolean policy", () => {
    expect(message({ ...base, policies: { redactScreenshots: "true" } })).toBe(
      "`policies.redactScreenshots` must be true or false (unquoted).",
    );
  });

  it("parses every committed study", async () => {
    const dir = "humanish/studies";
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".yaml"))) {
      const result = parseStudyDocument(parse(await readFile(path.join(dir, file), "utf8")));
      expect(result.ok ? "ok" : result.error.message, file).toBe("ok");
    }
  });
});
