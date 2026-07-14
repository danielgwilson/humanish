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
    expect(packageJson.version).toBe("0.15.1");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.dependencies).not.toHaveProperty("@e2b/desktop");
    expect(packageJson.peerDependencies?.["@e2b/desktop"]).toBe("^2.2.3");
    expect(packageJson.peerDependenciesMeta?.["@e2b/desktop"]).toEqual({ optional: true });
    expect(packageJson.homepage).toBe("https://github.com/danielgwilson/humanish#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/danielgwilson/humanish/issues");
    expect(packageJson.keywords).toContain("persona-simulation");
    expect(packageJson.files).toEqual([
      "AGENTS.md",
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
      "skills",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md"
    ]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts["public-surface:scan"]).toBe("node scripts/public-surface-scan.mjs");
    expect(packageJson.scripts["skill:check"]).toBe("DISABLE_TELEMETRY=1 npx skills add . --list");
    expect(packageJson.scripts["pack:dry-run"]).toBe("npm pack --dry-run");
    expect(packageJson.scripts["release:check"]).toBe("pnpm check && pnpm public-surface:scan && pnpm skill:check && npm pack --dry-run");
  });

  it("documents release gates and human publish decisions", async () => {
    const readiness = await readFile("docs/release/open-source-readiness.md", "utf8");
    const standard = await readFile("docs/release/public-readiness-standard.md", "utf8");

    expect(readiness).toContain("public repository candidate after reviewed history cleanup");
    expect(readiness).toContain("docs/release/public-readiness-standard.md");
    expect(readiness).toContain("License: MIT");
    expect(readiness).toContain("`npm publish` remains a human release action");
    expect(readiness).toContain("GitHub Visibility Gate");
    expect(readiness).toContain("from a fresh clone");
    expect(readiness).toContain("residual platform-cache risk");
    expect(readiness).toContain("reachable commit author and committer emails are GitHub noreply-style");
    expect(readiness).toContain("npm dry-run payload");
    expect(readiness).toContain("explicitly allowlisted by SHA-256");
    expect(readiness).toContain("skills/humanish/SKILL.md");
    expect(readiness).toContain("pnpm skill:check");
    expect(readiness).toContain("Prefer the tag-gated GitHub Actions workflow");
    expect(readiness).toContain("npm version patch --no-git-tag-version");
    expect(readiness).toContain("The release tag must point at a commit already reachable from `origin/main`.");
    expect(readiness).toContain("Trusted Publishing Setup");
    expect(readiness).toContain("workflow filename: `publish.yml`");
    expect(readiness).toContain("npm pack --dry-run");
    expect(readiness).toContain("No agent should run `npm publish` locally without explicit human approval");
    expect(readiness).toContain("`.humanish/`");
    expect(readiness).toContain("`.npmrc`");
    expect(readiness).toContain("unapproved durable commit email metadata");
    expect(readiness).toContain("internal");
    expect(readiness).toContain("operations notes");
    expect(readiness).toContain("Public");
    expect(readiness).toContain("`docs/ramp/`");
    expect(readiness).toContain("`docs/goals/`");
    expect(readiness).toContain("repo-local `AGENTS.md`");
    expect(standard).toContain("A maintainer-approved public commit email");
    expect(standard).toContain("Do not force-rewrite `main` solely because a known maintainer-approved public");
    expect(standard).toContain("Secret/PHI/private source? Rotate/revoke first");
  });

  it("keeps future-agent ramp and goal docs public-safe and packaged", async () => {
    const readme = await readFile("README.md", "utf8");
    const agents = await readFile("AGENTS.md", "utf8");
    const ramp = await readFile("docs/ramp/README.md", "utf8");
    const goals = await readFile("docs/goals/current.md", "utf8");

    expect(readme).toContain("docs/ramp/README.md");
    expect(readme).toContain("docs/goals/current.md");
    expect(agents).toContain("Assume this repository is public.");
    expect(ramp).toContain("Future agents should be able to continue from the repo");
    expect(ramp).toContain("[`AGENTS.md`](../../AGENTS.md)");
    expect(goals).toContain("Best Next Work");
    const forbidden = [
      ["", "Users", ""].join("/"),
      ["local", "git"].join("_"),
      ["env", ".env.local"].join("/"),
      ["private", "factory"].join("-")
    ];
    for (const term of forbidden) {
      expect(`${ramp}\n${goals}`).not.toContain(term);
    }
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
    expect(publish).toContain("Verify release tag is on main and matches package version");
    expect(publish).toContain("git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main");
    expect(publish).toContain("[ \"v${PACKAGE_VERSION}\" != \"$GITHUB_REF_NAME\" ]");
    expect(publish).toContain("pnpm release:check");
    expect(publish).toContain("HUMANISH_PUBLIC_DENYLIST_PATTERN: ${{ secrets.HUMANISH_PUBLIC_DENYLIST_PATTERN }}");
    expect(publish).toContain("npm publish --access public");
    expect(ci).toContain("pnpm/action-setup@v6");
    expect(ci).toContain("pnpm release:check");
  });
});
