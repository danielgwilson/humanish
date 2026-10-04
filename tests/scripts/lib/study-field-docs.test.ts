import { describe, expect, it } from "vitest";
import { documentedPaths, missingFields } from "../../../scripts/lib/study-field-docs.js";
import { isStudyKeyPath, studyKeyPaths } from "../../../src/study/keys.js";

describe("the study file reference check", () => {
  it("reads inline code spans outside fenced blocks, without list indexes", () => {
    const page = [
      "| `participants[].persona` | persona id |",
      "Set `caps.maxUsd` and `participants[0].device`.",
      "```yaml",
      "route: computer-use",
      "```",
      "`route` is required.",
    ].join("\n");
    expect([...documentedPaths(page)]).toEqual([
      "participants.persona",
      "caps.maxUsd",
      "participants.device",
      "route",
    ]);
  });

  it("names each required path no code span names exactly", () => {
    const page =
      "`caps` holds `caps.maxUsd`. A fenced `caps.maxTotalUsd:` line does not count:\n```yaml\n`caps.maxJobs`\n```";
    expect(
      missingFields(page, ["caps", "caps.maxUsd", "caps.maxTotalUsd", "caps.maxJobs"]),
    ).toEqual(["caps.maxTotalUsd", "caps.maxJobs"]);
  });

  it("lists every study key to two levels, each one the parser accepts", () => {
    const paths = studyKeyPaths(2);
    expect(paths).toContain("route");
    expect(paths).toContain("caps.maxTotalUsd");
    expect(paths).toContain("participants.persona");
    expect(paths).toContain("execution.desktop");
    expect(paths).not.toContain("execution.desktop.device");
    expect(paths).not.toContain("execution.caps");
    expect(paths.every(isStudyKeyPath)).toBe(true);
  });
});
