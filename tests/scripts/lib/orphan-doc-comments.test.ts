import { describe, expect, it } from "vitest";
import { findOrphanDocComments } from "../../../scripts/lib/orphan-doc-comments.js";

const reasons = (source: string) =>
  findOrphanDocComments(source).map(({ line, reason }) => `${line} ${reason}`);

describe("orphan doc comment scanner", () => {
  it("accepts a block on a declaration, a member, a one-line member and past line comments", () => {
    const source = [
      "/** File header. */",
      'import { x } from "./x.js";',
      "",
      "/** A function. */",
      "// eslint-disable-next-line",
      "export async function run(): Promise<void> {}",
      "",
      "export interface Shape {",
      "  /** A member. */",
      "  readonly name?: string;",
      "  /** A method. */",
      "  size(): number;",
      "  /** Inline. */ count: number;",
      "}",
      "",
      'const glob = "src/**/*.ts"; // not a doc block',
      "",
      "export type Kind =",
      "  /** A union member. */",
      '  | "a";',
    ].join("\n");
    expect(reasons(source)).toEqual([]);
  });

  it("flags a block followed by another block, by the end of the file, or by a statement", () => {
    const source = [
      "export const a = 1;",
      "",
      "/** Moved away. */",
      "/** Documents b. */",
      "export const b = 2;",
      "",
      "function f(): number {",
      "  /** Not a declaration. */",
      "  return 1;",
      "}",
      "",
      "/** Left at the end. */",
      "",
    ].join("\n");
    expect(reasons(source)).toEqual([
      "3 followed by another doc comment",
      "8 not followed by a declaration",
      "12 at end of file",
    ]);
  });

  it("treats a block before an import as a header only when no code comes before it", () => {
    const source = [
      'import { a } from "./a.js";',
      "/** Not a header. */",
      'import { b } from "./b.js";',
    ].join("\n");
    expect(reasons(source)).toEqual(["2 not followed by a declaration"]);
  });
});
