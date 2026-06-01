import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release readiness", () => {
  it("keeps publication gated while exposing package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bugs?: { url?: string };
      homepage?: string;
      keywords?: string[];
      license: string;
      private: boolean;
      scripts: Record<string, string>;
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe("UNLICENSED");
    expect(packageJson.homepage).toBe("https://github.com/danielgwilson/mimetic-cli#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/danielgwilson/mimetic-cli/issues");
    expect(packageJson.keywords).toContain("persona-simulation");
    expect(packageJson.scripts["pack:dry-run"]).toBe("pnpm build && npm pack --dry-run");
    expect(packageJson.scripts["release:check"]).toBe("pnpm check && npm pack --dry-run");
  });

  it("documents release gates and human publish decisions", async () => {
    const readiness = await readFile("docs/release/open-source-readiness.md", "utf8");

    expect(readiness).toContain("Actual public release is blocked on Daniel choosing the");
    expect(readiness).toContain("license and explicitly approving npm publication");
    expect(readiness).toContain("Do not remove `private: true`");
    expect(readiness).toContain("npm pack --dry-run");
    expect(readiness).toContain("No agent should run that command without explicit human approval");
    expect(readiness).toContain("`.mimetic/`");
    expect(readiness).toContain("`.npmrc`");
  });
});
