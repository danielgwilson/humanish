import { describe, expect, it } from "vitest";
import { findUnindexedDocs } from "../../../scripts/lib/doc-index.js";

function unindexed(files: Record<string, string>): string[] {
  return findUnindexedDocs(Object.keys(files), (path) => files[path]);
}

describe("findUnindexedDocs", () => {
  it("accepts a page docs/README.md links, with or without a fragment", () => {
    expect(
      unindexed({
        "docs/README.md": "- [a](architecture/a.md)\n- [b](principles/b.md#why)\n",
        "docs/architecture/a.md": "# A\n",
        "docs/principles/b.md": "# B\n",
      }),
    ).toEqual([]);
  });

  it("accepts a page its folder's README.md links, when docs/README.md links that README", () => {
    expect(
      unindexed({
        "docs/README.md": "- [contracts](contracts/README.md)\n",
        "docs/contracts/README.md": "- [core](core.md)\n- [policy](./policy.md)\n",
        "docs/contracts/core.md": "# Core\n",
        "docs/contracts/policy.md": "# Policy\n",
      }),
    ).toEqual([]);
  });

  it("names a page no index links, and a folder README docs/README.md does not link", () => {
    expect(
      unindexed({
        "docs/README.md": "- [engineering](principles/engineering.md)\n",
        "docs/principles/engineering.md": "# Engineering\n",
        "docs/principles/three-roles.md": "# Three roles\n",
        "docs/contracts/README.md": "- [core](core.md)\n",
        "docs/contracts/core.md": "# Core\n",
      }),
    ).toEqual(["docs/principles/three-roles.md", "docs/contracts/README.md"]);
  });

  it("does not count a link to another page's folder as a link to the page", () => {
    expect(
      unindexed({
        "docs/README.md": "- [principles/](principles/engineering.md)\n",
        "docs/principles/engineering.md": "# Engineering\n",
        "docs/principles/actor-fidelity.md": "# Actor fidelity\n",
      }),
    ).toEqual(["docs/principles/actor-fidelity.md"]);
  });

  it("skips history folders and files outside docs/, but checks docs/goals/current.md", () => {
    expect(
      unindexed({
        "docs/README.md": "",
        "docs/goals/old/receipt.md": "# Receipt\n",
        "docs/plans/plan.md": "# Plan\n",
        "docs/goals/current.md": "# Current\n",
        "README.md": "# humanish\n",
        "site/content/docs/index.mdx": "# Docs\n",
      }),
    ).toEqual(["docs/goals/current.md"]);
  });
});
