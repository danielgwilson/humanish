import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scanScript = resolve("scripts/public-surface-scan.mjs");

async function createGitHistory(commitEmails: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "humanish-public-surface-scan-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "public-surface-scan-fixture", version: "1.0.0" }, null, 2)}\n`
  );
  spawnSync("git", ["init", "--quiet"], { cwd: root });

  for (const [index, email] of commitEmails.entries()) {
    await writeFile(join(root, `safe-${index}.txt`), `safe fixture ${index}\n`);
    const add = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const commit = spawnSync(
      "git",
      [
        "-c", "user.name=Public Surface Test",
        "-c", `user.email=${email}`,
        "commit", "--quiet", "-m", `fixture ${index}`
      ],
      { cwd: root, encoding: "utf8" }
    );
    expect(commit.status, commit.stderr).toBe(0);
  }

  return root;
}

function runScan(root: string, denylistPattern = "") {
  return spawnSync(process.execPath, [scanScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF: "",
      HUMANISH_PUBLIC_COMMIT_EMAIL_ALLOWLIST: "",
      HUMANISH_PUBLIC_DENYLIST_PATTERN: denylistPattern
    },
    timeout: 30_000
  });
}

describe("public-surface commit email policy", () => {
  it("accepts both GitHub-documented noreply forms and explicit GitHub-generated addresses", async () => {
    const root = await createGitHistory([
      "0xContributor@users.noreply.github.com",
      "123456+modern-contributor@users.noreply.github.com",
      "github-actions[bot]@users.noreply.github.com",
      "noreply@github.com"
    ]);
    try {
      const scan = runScan(root);
      expect(scan.status, scan.stderr).toBe(0);
      expect(scan.stdout).toContain("public-surface scan ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("still rejects commit email addresses outside the exact policy", async () => {
    const rejectedEmails = [
      ["contributor", "users.noreply.github.com.example.test"].join("@"),
      "-@users.noreply.github.com",
      "bad-@users.noreply.github.com",
      "a--b@users.noreply.github.com",
      `${"a".repeat(40)}@users.noreply.github.com`
    ];
    const root = await createGitHistory(rejectedEmails);
    try {
      const scan = runScan(root);
      expect(scan.status).toBe(1);
      expect(scan.stderr).toContain("unapproved_commit_email");
      for (const email of rejectedEmails) {
        expect(scan.stderr).toContain(email);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("applies the private-name pattern supplied by the release environment", async () => {
    const root = await createGitHistory(["123456+public-contributor@users.noreply.github.com"]);
    try {
      await writeFile(join(root, "private-name.txt"), "private-downstream-codename\n");
      const scan = runScan(root, "private-downstream-codename");
      expect(scan.status).toBe(1);
      expect(scan.stderr).toContain("custom_private_residue_1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
