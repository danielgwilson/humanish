import { describe, expect, it } from "vitest";
import { findUndocumentedExports } from "../../../scripts/lib/public-export-docs.js";

/** Runs the scanner over in-memory modules keyed by repo-relative path. */
const scan = (modules: Record<string, string>) =>
  findUndocumentedExports((file) => modules[file]).map(
    ({ name, file, line, reason }) => `${name} ${file}:${line} ${reason}`,
  );

describe("public export doc comments", () => {
  it("passes when every export is documented where it is declared, through re-exports", () => {
    expect(
      scan({
        "src/index.ts": [
          'export { run as runLab } from "./run.js";',
          'export type { Shape, Kind } from "./types.js";',
        ].join("\n"),
        "src/run.ts": "/** Runs a lab. */\nexport function run(): void {}\n",
        "src/types.ts": 'export type { Shape } from "./shape.js";\nexport * from "./kind.js";\n',
        "src/shape.ts": "/** A shape. */\nexport interface Shape {\n  name: string;\n}\n",
        "src/kind.ts": '/** A kind. */\nexport type Kind = "a" | "b";\n',
      }),
    ).toEqual([]);
  });

  it("names an export with no doc comment, a line comment only, or no declaration", () => {
    expect(
      scan({
        "src/index.ts": [
          'export { bare } from "./bare.js";',
          'export type { Lined } from "./lined.js";',
          'export { gone } from "./gone.js";',
        ].join("\n"),
        "src/bare.ts": "export const bare = 1;\n",
        "src/lined.ts": "// Not a doc comment.\nexport interface Lined {}\n",
      }),
    ).toEqual([
      "bare src/bare.ts:1 no doc comment",
      "Lined src/lined.ts:2 no doc comment",
      "gone src/gone.ts:1 declaration not found",
    ]);
  });

  it("finds a declaration exported by a separate `export { name }` statement", () => {
    expect(
      scan({
        "src/index.ts": 'export { helper } from "./helper.js";\n',
        "src/helper.ts": "/** Helps. */\nfunction helper(): void {}\nexport { helper };\n",
      }),
    ).toEqual([]);
  });
});
