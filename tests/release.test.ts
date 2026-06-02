import { readFile } from "node:fs/promises";
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
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      private?: boolean;
      publishConfig?: { access?: string };
      scripts: Record<string, string>;
      version: string;
    };

    expect(packageJson.private).toBeUndefined();
    expect(packageJson.version).toBe("0.1.1");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.dependencies).not.toHaveProperty("@e2b/desktop");
    expect(packageJson.peerDependencies?.["@e2b/desktop"]).toBe("^2.2.3");
    expect(packageJson.peerDependenciesMeta?.["@e2b/desktop"]).toEqual({ optional: true });
    expect(packageJson.homepage).toBe("https://github.com/danielgwilson/mimetic-cli#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/danielgwilson/mimetic-cli/issues");
    expect(packageJson.keywords).toContain("persona-simulation");
    expect(packageJson.files).toEqual(["dist", "skills", "README.md", "LICENSE"]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts["public-surface:scan"]).toBe("node scripts/public-surface-scan.mjs");
    expect(packageJson.scripts["skill:check"]).toBe("DISABLE_TELEMETRY=1 npx skills add . --list");
    expect(packageJson.scripts["pack:dry-run"]).toBe("npm pack --dry-run");
    expect(packageJson.scripts["release:check"]).toBe("pnpm check && pnpm public-surface:scan && pnpm skill:check && npm pack --dry-run");
  });

  it("documents release gates and human publish decisions", async () => {
    const readiness = await readFile("docs/release/open-source-readiness.md", "utf8");

    expect(readiness).toContain("public package candidate");
    expect(readiness).toContain("License: MIT");
    expect(readiness).toContain("Actual `npm publish` remains a human release");
    expect(readiness).toContain("GitHub Visibility Gate");
    expect(readiness).toContain("Do not make the existing repository public with full history");
    expect(readiness).toContain("skills/mimetic-cli/SKILL.md");
    expect(readiness).toContain("pnpm skill:check");
    expect(readiness).toContain("pnpm release:check && npm publish --access public");
    expect(readiness).toContain("Trusted Publishing Setup");
    expect(readiness).toContain("workflow filename: `publish.yml`");
    expect(readiness).toContain("npm pack --dry-run");
    expect(readiness).toContain("No agent should run that command without explicit human approval");
    expect(readiness).toContain("`.mimetic/`");
    expect(readiness).toContain("`.npmrc`");
  });

  it("defines tag-gated npm trusted publishing", async () => {
    const publish = await readFile(".github/workflows/publish.yml", "utf8");
    const ci = await readFile(".github/workflows/ci.yml", "utf8");

    expect(publish).toContain("id-token: write");
    expect(publish).toContain("actions/checkout@v6");
    expect(publish).toContain("actions/setup-node@v6");
    expect(publish).toContain("pnpm/action-setup@v6");
    expect(publish).toContain("registry-url: \"https://registry.npmjs.org\"");
    expect(publish).toContain("package-manager-cache: false");
    expect(publish).toContain("if: github.ref_type == 'tag' && startsWith(github.ref_name, 'v')");
    expect(publish).toContain("pnpm release:check");
    expect(publish).toContain("npm publish --access public");
    expect(ci).toContain("pnpm/action-setup@v6");
    expect(ci).toContain("pnpm release:check");
  });
});
