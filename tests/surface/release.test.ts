import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoIndex, findDocPathIssues } from "../../scripts/lib/doc-paths.js";

/** The files under one package.json `files` entry, relative to the repo root. */
async function filesUnder(entry: string): Promise<string[]> {
  const info = await stat(entry).catch(() => undefined);
  if (info === undefined) return [];
  if (info.isFile()) return [entry];
  const entries = await readdir(entry, { recursive: true, withFileTypes: true });
  return entries
    .filter((dirent) => dirent.isFile())
    .map((dirent) =>
      path
        .relative(process.cwd(), path.join(dirent.parentPath, dirent.name))
        .split(path.sep)
        .join("/"),
    );
}

describe("release readiness", () => {
  it("keeps publication gated while exposing package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bugs?: { url?: string };
      files?: string[];
      homepage?: string;
      keywords?: string[];
      license: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      private?: boolean;
      publishConfig?: { access?: string };
      scripts: Record<string, string>;
      version: string;
    };

    expect(packageJson.private).toBeUndefined();
    expect(packageJson.version).toMatch(/^0\.\d+\.\d+$/);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.dependencies).not.toHaveProperty("@e2b/desktop");
    // Desktop 2.3.2 raises its e2b floor to the first verified background handle with stdin methods.
    expect(packageJson.peerDependencies?.["@e2b/desktop"]).toBe("^2.3.2");
    expect(packageJson.peerDependenciesMeta?.["@e2b/desktop"]).toEqual({ optional: true });
    expect(packageJson.devDependencies?.["@e2b/desktop"]).toBe("^2.4.0");
    expect(packageJson.homepage).toBe("https://github.com/danielgwilson/humanish#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/danielgwilson/humanish/issues");
    expect(packageJson.keywords).toContain("user-research");
    expect(packageJson.files).toEqual([
      "AGENTS.md",
      "CHANGELOG.md",
      "dist",
      "docs/architecture",
      "docs/contracts",
      "docs/decisions",
      "docs/status.md",
      "docs/principles",
      "docs/product",
      "docs/ramp",
      "docs/release",
      "docs/history/roadmap",
      "examples",
      "skills",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "ARCHITECTURE.md",
      "CONTEXT.md",
      "TELEMETRY.md",
    ]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts["public-surface:scan"]).toBe("node scripts/public-surface-scan.mjs");
    expect(packageJson.scripts["skill:check"]).toBe(
      "DISABLE_TELEMETRY=1 pnpm exec skills add . --list",
    );
    expect(packageJson.scripts["pack:dry-run"]).toBe("npm pack --dry-run");
    expect(packageJson.scripts["api:proof"]).toBe("node scripts/public-api-proof.mjs");
    expect(packageJson.scripts["release:check"]).toBe(
      "pnpm check && pnpm api:proof && pnpm public-surface:scan && pnpm skill:check && npm pack --dry-run",
    );
  });

  it("keeps local machine paths out of the ramp and goal docs", async () => {
    const ramp = await readFile("docs/ramp/README.md", "utf8");
    const goals = await readFile("docs/status.md", "utf8");
    const forbidden = [
      ["", "Users", ""].join("/"),
      ["local", "git"].join("_"),
      ["env", ".env.local"].join("/"),
      ["private", "factory"].join("-"),
    ];
    for (const term of forbidden) {
      expect(`${ramp}\n${goals}`).not.toContain(term);
    }
  });

  it("ships no image that `README.md` does not show", async () => {
    const readme = await readFile("README.md", "utf8");
    const inventory = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      }),
    ) as Array<{ files?: Array<{ path?: string }> }>;

    expect(inventory).toHaveLength(1);
    const images = (inventory[0]?.files ?? [])
      .map((file) => file.path ?? "")
      .filter((path) => /\.(png|jpe?g|gif|svg|webp)$/i.test(path));
    expect(images.filter((path) => !readme.includes(path))).toEqual([]);
  }, 45_000);

  // Inside node_modules a relative link can only reach what the package ships. Links to repo-only
  // files use GitHub URLs, which docs:check validates.
  it("ships every file that a relative link in a shipped doc names", async () => {
    const { files } = JSON.parse(await readFile("package.json", "utf8")) as { files: string[] };
    const shipped = ["package.json", ...(await Promise.all(files.map(filesUnder))).flat()];
    const index = buildRepoIndex(shipped);
    const broken: string[] = [];
    for (const doc of shipped.filter((file) => /\.mdx?$/.test(file))) {
      for (const issue of findDocPathIssues(doc, await readFile(doc, "utf8"), index)) {
        // Only a markdown link has a resolved target; other doc paths are references.
        if (issue.resolved !== undefined) broken.push(`${doc}:${issue.line} ${issue.resolved}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("npm publishing", () => {
  it("publishes dependency ranges npm can install", async () => {
    // publish.yml runs `npm publish`, which ships package.json as written; npm cannot resolve
    // pnpm's catalog: or workspace: protocols, so an installed package would fail to resolve.
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const workspace = await readFile("pnpm-workspace.yaml", "utf8");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(packageJson[field] ?? {})) {
        expect(range, `${field}.${name}`).not.toMatch(/^(catalog|workspace):/);
        const catalogRange = workspace.match(new RegExp(`^  "?${name}"?: (\\S+)`, "m"))?.[1];
        if (catalogRange) expect(range, `${field}.${name} matches the catalog`).toBe(catalogRange);
      }
    }
  });

  it("defines tag-gated npm trusted publishing", async () => {
    const publish = await readFile(".github/workflows/publish.yml", "utf8");
    const ci = await readFile(".github/workflows/ci.yml", "utf8");

    expect(publish).toContain("id-token: write");
    expect(publish).toMatch(/actions\/checkout@v\d+/);
    expect(publish).toMatch(/actions\/setup-node@v\d+/);
    expect(publish).toMatch(/pnpm\/action-setup@v\d+/);
    expect(publish).toContain('registry-url: "https://registry.npmjs.org"');
    expect(publish).toContain("package-manager-cache: false");
    expect(publish).toContain("if: github.ref_type == 'tag' && startsWith(github.ref_name, 'v')");
    expect(publish).toContain("Verify release tag is on main and matches package version");
    expect(publish).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(publish).toContain('[ "v${PACKAGE_VERSION}" != "$GITHUB_REF_NAME" ]');
    expect(publish).toContain("pnpm release:check");
    expect(publish).toContain(
      "HUMANISH_PUBLIC_DENYLIST_PATTERN: ${{ secrets.HUMANISH_PUBLIC_DENYLIST_PATTERN }}",
    );
    expect(publish).toContain("npm publish --access public");
    expect(ci).toMatch(/pnpm\/action-setup@v\d+/);
    expect(ci).toContain("pnpm release:check");
  });
});
