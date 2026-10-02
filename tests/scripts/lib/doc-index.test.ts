import { describe, expect, it } from "vitest";
import {
  citesEvidenceOnly,
  findHistoryLinks,
  findPreambleLines,
  findUnindexedDocs,
} from "../../../scripts/lib/doc-index.js";

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

  it("accepts a page its folder's `README.md` links, when `docs/README.md` links that index", () => {
    expect(
      unindexed({
        "docs/README.md": "- [contracts](contracts/README.md)\n",
        "docs/contracts/README.md": "- [core](core.md)\n- [policy](./policy.md)\n",
        "docs/contracts/core.md": "# Core\n",
        "docs/contracts/policy.md": "# Policy\n",
      }),
    ).toEqual([]);
  });

  it("names a page no index links, and a folder index `docs/README.md` does not link", () => {
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

  it("accepts a page a `README.md` two folders up links", () => {
    expect(
      unindexed({
        "docs/README.md": "- [evidence](evidence/README.md)\n",
        "docs/evidence/README.md": "- [run](computer-use/run-2026-09-01.md)\n",
        "docs/evidence/computer-use/run-2026-09-01.md": "# Run\n",
        "docs/evidence/computer-use/unlisted-2026-09-02.md": "# Unlisted\n",
      }),
    ).toEqual(["docs/evidence/computer-use/unlisted-2026-09-02.md"]);
  });

  it("skips docs/history/ and files outside docs/, but checks docs/status.md", () => {
    expect(
      unindexed({
        "docs/README.md": "",
        "docs/history/goals/old/receipt.md": "# Receipt\n",
        "docs/history/plans/plan.md": "# Plan\n",
        "docs/status.md": "# Current\n",
        "README.md": "# humanish\n",
        "site/content/docs/index.mdx": "# Docs\n",
      }),
    ).toEqual(["docs/status.md"]);
  });
});

describe("findPreambleLines", () => {
  it("names each line that opens with Date: or Status:", () => {
    const page = [
      "# Policy",
      "",
      "Date: 2026-06-02",
      "",
      "Status: shipped policy reference.",
      "The status of a run is in `status.json`.",
      "- Status: a list item is not a preamble",
    ].join("\n");
    expect(findPreambleLines(page)).toEqual([3, 5]);
  });

  it("finds nothing on a page that opens with its scope", () => {
    expect(findPreambleLines("# Policy\n\nThis page is the policy reference.\n")).toEqual([]);
  });
});

describe("findHistoryLinks", () => {
  it("names lines in `README.md` and site pages that link into docs/history/", () => {
    const readme = [
      "[record](docs/evidence/computer-use/run-2026-09-01.md)",
      "[old goal](docs/history/goals/x/goal.md)",
      "[url](https://github.com/danielgwilson/humanish/blob/main/docs/history/plans/p.md)",
      "[status](docs/status.md)",
    ].join("\n");
    expect(findHistoryLinks("README.md", readme)).toEqual([2, 3]);
    expect(findHistoryLinks("site/content/docs/x.mdx", "[a](../../../docs/history/r.md)")).toEqual([
      1,
    ]);
  });

  it("applies to `README.md` and site pages only", () => {
    expect(
      ["README.md", "site/content/docs/x.mdx", "docs/status.md", "AGENTS.md"].filter(
        citesEvidenceOnly,
      ),
    ).toEqual(["README.md", "site/content/docs/x.mdx"]);
  });
});
