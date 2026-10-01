import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
    expect(packageJson.keywords).toContain("persona-simulation");
    expect(packageJson.files).toEqual([
      "AGENTS.md",
      "CHANGELOG.md",
      "dist",
      "docs/architecture",
      "docs/assets",
      "docs/contracts",
      "docs/goals/current.md",
      "docs/principles",
      "docs/product",
      "docs/ramp",
      "docs/release",
      "docs/roadmap",
      "examples",
      "skills",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "ARCHITECTURE.md",
    ]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts["public-surface:scan"]).toBe("node scripts/public-surface-scan.mjs");
    expect(packageJson.scripts["skill:check"]).toBe("DISABLE_TELEMETRY=1 npx skills add . --list");
    expect(packageJson.scripts["pack:dry-run"]).toBe("npm pack --dry-run");
    expect(packageJson.scripts["api:proof"]).toBe("node scripts/public-api-proof.mjs");
    expect(packageJson.scripts["release:check"]).toBe(
      "pnpm check && pnpm api:proof && pnpm public-surface:scan && pnpm skill:check && npm pack --dry-run",
    );
  });

  it("keeps local machine paths out of the ramp and goal docs", async () => {
    const ramp = await readFile("docs/ramp/README.md", "utf8");
    const goals = await readFile("docs/goals/current.md", "utf8");
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

  it("links the version-pinned drawDB study hero and ships it in the npm payload", async () => {
    const readme = await readFile("README.md", "utf8");
    const screenshotPath = "docs/assets/humanish-drawdb-hero.png";
    const screenshotMarkdown =
      `![humanish Observer grid of a live four-persona drawDB study: four completed lanes, each showing its final full-desktop screenshot and outcome]` +
      `(https://unpkg.com/humanish@0.16.0/${screenshotPath})`;
    const screenshot = await stat(screenshotPath);
    const inventory = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      }),
    ) as Array<{ files?: Array<{ path?: string; size?: number }> }>;

    expect(inventory).toHaveLength(1);
    const packedScreenshot = inventory[0]?.files?.find((file) => file.path === screenshotPath);
    if (!packedScreenshot) {
      throw new Error(`npm pack inventory omitted ${screenshotPath}`);
    }

    expect(readme).toContain(screenshotMarkdown);
    expect(readme).toContain("it is not a humanish adopter or endorser");
    expect(readme).not.toContain(`https://unpkg.com/humanish@latest/${screenshotPath}`);
    expect(packedScreenshot.size).toBe(screenshot.size);
    expect(packedScreenshot.size).toBeGreaterThan(50_000);
  }, 45_000);

  it("keeps the legacy synthetic hero in the npm payload for older pinned READMEs", async () => {
    const screenshotPath = "docs/assets/humanish-observer-hero.png";
    const screenshot = await stat(screenshotPath);
    const inventory = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      }),
    ) as Array<{ files?: Array<{ path?: string; size?: number }> }>;

    expect(inventory).toHaveLength(1);
    const packedScreenshot = inventory[0]?.files?.find((file) => file.path === screenshotPath);
    if (!packedScreenshot) {
      throw new Error(`npm pack inventory omitted ${screenshotPath}`);
    }

    expect(packedScreenshot.size).toBe(screenshot.size);
    expect(packedScreenshot.size).toBeGreaterThan(50_000);
  }, 45_000);
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
