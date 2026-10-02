import { describe, expect, it } from "vitest";
import {
  findMainLinks,
  findRepoLinks,
  isSitePage,
  repoLinkProblem,
} from "../../../scripts/lib/site-repo-links.js";

describe("site repository links", () => {
  it("reads repo: links with their line and fragment", () => {
    const page = [
      "See [the parser](repo:src/lab/).",
      "The [contract](repo:docs/contracts/schemas.md#library-options) and [a site page](/docs/cli).",
    ].join("\n");
    expect(findRepoLinks(page)).toEqual([
      { line: 1, path: "src/lab/", fragment: undefined },
      { line: 2, path: "docs/contracts/schemas.md", fragment: "library-options" },
    ]);
  });

  it("names main links outside docs/evidence/ and `SECURITY.md`", () => {
    const page = [
      "[record](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/computer-use/run-2026-09-01.md)",
      "[policy](https://github.com/danielgwilson/humanish/blob/main/SECURITY.md)",
      "[lab](https://github.com/danielgwilson/humanish/blob/main/humanish/labs/scripted-demo.yaml)",
      "[examples](https://github.com/danielgwilson/humanish/tree/main/examples/participant)",
      "[tagged](https://github.com/danielgwilson/humanish/blob/v0.107.0/TELEMETRY.md)",
    ].join("\n");
    expect(findMainLinks(page)).toEqual([
      { line: 3, path: "humanish/labs/scripted-demo.yaml" },
      { line: 4, path: "examples/participant" },
    ]);
  });

  it("checks that a repo: path names a file, or a folder written with a trailing slash", () => {
    const files = new Set(["TELEMETRY.md"]);
    const folders = new Set(["examples/participant"]);
    const problem = (path: string) =>
      repoLinkProblem(
        path,
        (file) => files.has(file),
        (folder) => folders.has(folder),
      );
    expect(problem("TELEMETRY.md")).toBeUndefined();
    expect(problem("examples/participant/")).toBeUndefined();
    expect(problem("examples/participant")).toBe("names a folder; end it with /");
    expect(problem("examples/scorer/")).toBe("names a folder that does not exist");
    expect(problem("MISSING.md")).toBe("names a file that does not exist");
    expect(problem("")).toBe("names no path");
  });

  it("covers the site's docs pages only", () => {
    expect(
      ["site/content/docs/library.mdx", "docs/README.md", "README.md"].filter(isSitePage),
    ).toEqual(["site/content/docs/library.mdx"]);
  });
});
