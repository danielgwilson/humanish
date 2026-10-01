import { describe, expect, it } from "vitest";
import {
  codeMapFolders,
  findCodeMapIssues,
  requiredFolders,
} from "../../../scripts/lib/code-map.js";

const architecture = (rows: string[]) =>
  [
    "# Map",
    "",
    "## Find the code for each part of the system",
    "",
    "| Folder | What it holds | Read first |",
    "| --- | --- | --- |",
    ...rows.map((folder) => `| \`${folder}\` | Something | \`README.md\` |`),
    "| `src/guest-*.ts` | The guest runtime | `src/guest-runtime-main.ts` |",
    "",
    "## Next section",
    "",
    "| `src/elsewhere/` | Not the code map | |",
  ].join("\n");

const files = [
  "src/cli/program.ts",
  "src/routes/terminal/lab.ts",
  "src/routes/terminal/nested/deep.ts",
  "src/guest-runtime-main.ts",
  "observer/main.tsx",
];

describe("ARCHITECTURE.md code map check", () => {
  it("reads directory rows from the code map section only", () => {
    expect(codeMapFolders(architecture(["src/cli/", "observer/"]))).toEqual([
      "src/cli/",
      "observer/",
    ]);
  });

  it("requires every src/ directory and every src/routes/ folder, not files or deeper folders", () => {
    expect(requiredFolders(files)).toEqual(["src/cli/", "src/routes/", "src/routes/terminal/"]);
  });

  it("passes when every required folder has a row and every row exists", () => {
    const rows = ["src/cli/", "src/routes/", "src/routes/terminal/", "observer/"];
    expect(findCodeMapIssues(architecture(rows), files)).toEqual([]);
  });

  it("names a folder without a row and a row whose folder is gone", () => {
    const rows = ["src/cli/", "src/routes/", "src/removed/"];
    expect(findCodeMapIssues(architecture(rows), files)).toEqual([
      "src/routes/terminal/ has no row in ARCHITECTURE.md's code map",
      "ARCHITECTURE.md's code map lists src/removed/, which does not exist",
    ]);
  });

  it("fails when the code map section is missing", () => {
    expect(findCodeMapIssues("# Map\n", files)).toHaveLength(1);
  });
});
