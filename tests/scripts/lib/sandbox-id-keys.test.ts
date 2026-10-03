import { describe, expect, it } from "vitest";
import { REDACTED_SANDBOX_ID, redactSandboxIds } from "../../../src/evidence/redaction.js";
import {
  SANDBOX_ID_MARKER,
  sandboxIdFindings,
  sandboxIdValues,
} from "../../../scripts/lib/sandbox-id-keys.mjs";

// The public-surface scan flags any value at a key humanish writes a sandbox id under, whatever the
// id looks like. Each case plants a fake id where a real one would sit in a committed file. The ids
// are written out with a fake- prefix, which the scan accepts in tests/ and this function does not.
const PLANTED = "fake-planted-7";

describe("sandbox ids found by key", () => {
  it.each([
    [
      "run.json providerResources",
      `{"providerResources": [{"schema": "humanish.provider-resource.v1", "id": "fake-planted-7", "status": "killed"}]}`,
      "providerResources[].id",
    ],
    [
      "a sandbox receipt line",
      `{"provider":"e2b-desktop","sandboxId":"fake-planted-7","timeoutMs":3000000}\n`,
      "sandboxId",
    ],
    ["a route result", `{"lanes": [{"sandbox": {"sandboxId": "fake-planted-7"}}]}`, "sandboxId"],
    ["a subject sandbox", `{"subjectSandboxId": "fake-planted-7"}`, "subjectSandboxId"],
    [
      "inline page data",
      `<script>window.data={"providerResources":[{"id":"fake-planted-7","kind":"sandbox"}]}</script>`,
      "providerResources[].id",
    ],
    ["source", `const lease = { sandboxId: "fake-planted-7" };`, "sandboxId"],
  ])("flags the id in %s", (_label, text, key) => {
    expect(sandboxIdValues(text)).toMatchObject([{ key, value: PLANTED }]);
  });

  it("passes the redaction marker, which is the value src writes in a shared copy", () => {
    expect(SANDBOX_ID_MARKER).toBe(REDACTED_SANDBOX_ID);
    const redacted = `{"sandboxId": "[redacted-sandbox-id]", "providerResources": [{"id": "[redacted-sandbox-id]"}]}`;
    expect(sandboxIdValues(redacted)).toEqual([]);
  });

  it("reads every resource in the array and nothing after it", () => {
    const text = `{"providerResources": [{"id": "fake-a-1", "note": "] }"}, {"cleanup": {"killed": true}, "id": "fake-a-2"}], "id": "not-a-resource"}`;
    expect(sandboxIdValues(text).map((found) => found.value)).toEqual(["fake-a-1", "fake-a-2"]);
  });

  it("points at the value's offset, so the scan reports its line", () => {
    const text = `{\n  "providerResources": [\n    { "id": "fake-planted-7" }\n  ]\n}`;
    const [found] = sandboxIdValues(text);
    expect(text.slice(found!.index, found!.index + PLANTED.length)).toBe(PLANTED);
  });

  it("ignores a variable at the key, which carries no id into a committed file", () => {
    expect(sandboxIdValues("return { sandboxId: receipt.sandboxId };")).toEqual([]);
  });
});

// A value shaped like an E2B sandbox id. The texts below build their keys at run time, so this
// file holds no id at a sandbox-id key for the scan to flag.
const REAL_SHAPED = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const KEYS = ["sandbox" + "Id", "subject" + "SandboxId"];
const planted = (value: string): string[] => [
  ...KEYS.map((key) => JSON.stringify({ result: { [key]: value } })),
  JSON.stringify({ ["provider" + "Resources"]: [{ kind: "sandbox", id: value }] }),
];

describe("the scan's rule for a file", () => {
  it.each([
    "tests/fixtures/copied-run/run.json",
    "site/public/runs/demo/run.json",
    "docs/contracts/example.md",
  ])("fails a real-shaped id at every key in %s", (file) => {
    for (const text of planted(REAL_SHAPED))
      expect(sandboxIdFindings(file, text)).toMatchObject([{ value: REAL_SHAPED }]);
  });

  it("passes a fake- or synthetic- id in tests/ only", () => {
    for (const value of ["fake-sandbox-001", "synthetic-desktop"]) {
      for (const text of planted(value)) {
        expect(sandboxIdFindings("tests/routes/example.test.ts", text)).toEqual([]);
        expect(sandboxIdFindings("site/public/runs/demo/run.json", text)).toHaveLength(1);
      }
    }
  });

  it("finds nothing in a copy src has redacted", () => {
    for (const text of planted(REAL_SHAPED)) {
      const redacted = JSON.stringify(redactSandboxIds(JSON.parse(text)));
      expect(sandboxIdFindings("site/public/runs/demo/run.json", redacted)).toEqual([]);
    }
  });
});
