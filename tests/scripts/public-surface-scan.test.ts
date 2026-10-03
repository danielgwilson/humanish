import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scanScript = resolve("scripts/public-surface-scan.mjs");

async function createGitHistory(commitEmails: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "humanish-public-surface-scan-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "public-surface-scan-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  spawnSync("git", ["init", "--quiet"], { cwd: root });

  for (const [index, email] of commitEmails.entries()) {
    await writeFile(join(root, `safe-${index}.txt`), `safe fixture ${index}\n`);
    const add = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const commit = spawnSync(
      "git",
      [
        "-c",
        "user.name=Public Surface Test",
        "-c",
        `user.email=${email}`,
        "commit",
        "--quiet",
        "-m",
        `fixture ${index}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(commit.status, commit.stderr).toBe(0);
  }

  return root;
}

function runScan(root: string, denylistPattern = "", githubRef = "") {
  return spawnSync(process.execPath, [scanScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF: githubRef,
      HUMANISH_PUBLIC_COMMIT_EMAIL_ALLOWLIST: "",
      HUMANISH_PUBLIC_DENYLIST_PATTERN: denylistPattern,
    },
    timeout: 30_000,
  });
}

describe("public-surface commit email policy", () => {
  it("allows only the fixed quoted guest XDG constants in their implementation files", async () => {
    const root = await createGitHistory(["noreply@github.com"]);
    const guestHome = ["", "home", "humanish"].join("/");
    try {
      for (const file of [
        "src/guest/runtime-desktop.ts",
        "dist/guest/runtime-desktop.js",
        "dist/guest/runtime-desktop.d.ts",
        "runtime/browser-guest/control/root/opt/humanish/control/vsock.py",
      ]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), `"${guestHome}/.cache" '${guestHome}/.config'\n`);
      }
      expect(runScan(root).status).toBe(0);
      // Neither an arbitrary guest path nor a private username is exempted.
      await writeFile(
        join(root, "src/guest/runtime-desktop.ts"),
        `"${guestHome}/.config/private" "${["", "home", "maintainer", ".cache"].join("/")}"\n`,
      );
      const denied = runScan(root);
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain("absolute_linux_home_path");
      await writeFile(join(root, "src/guest/runtime-desktop.ts"), "safe\n");
      await writeFile(join(root, "unrelated.txt"), `"${guestHome}/.cache"\n`);
      expect(runScan(root).status).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("accepts both GitHub-documented noreply forms and explicit GitHub-generated addresses", async () => {
    const root = await createGitHistory([
      "0xContributor@users.noreply.github.com",
      "123456+modern-contributor@users.noreply.github.com",
      "github-actions[bot]@users.noreply.github.com",
      "noreply@github.com",
    ]);
    try {
      const scan = runScan(root);
      expect(scan.status, scan.stderr).toBe(0);
      expect(scan.stdout).toContain("public-surface scan ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("does not judge fork commits fetched from GitHub pull refs", async () => {
    // A clone that has fetched pull refs carries commits from forks. Those are authored by
    // external contributors whose addresses are their own business and already public on GitHub,
    // and judging them failed our gate on somebody's normal gmail: for a contribution we should
    // welcome. Their commits are judged when the PR is proposed, which is when it matters to us.
    const root = await createGitHistory(["noreply@github.com"]);
    try {
      const branched = spawnSync("git", ["checkout", "--quiet", "-b", "fork-work"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(branched.status, branched.stderr).toBe(0);
      await writeFile(join(root, "contribution.txt"), "a welcome contribution\n");
      spawnSync("git", ["add", "."], { cwd: root });
      const authored = spawnSync(
        "git",
        [
          "-c",
          "user.name=External Contributor",
          "-c",
          "user.email=contributor@example.test",
          "commit",
          "--quiet",
          "-m",
          "their contribution",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(authored.status, authored.stderr).toBe(0);

      // Park it exactly where a fetched pull ref lives, then take the branch away.
      const sha = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).stdout.trim();
      spawnSync("git", ["checkout", "--quiet", "-"], { cwd: root });
      spawnSync("git", ["update-ref", "refs/remotes/origin-all/pull/7/head", sha], { cwd: root });
      spawnSync("git", ["branch", "--quiet", "-D", "fork-work"], { cwd: root });

      const sweep = runScan(root);
      expect(sweep.status, sweep.stderr).toBe(0);
      expect(sweep.stderr).not.toContain("contributor@example.test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("scopes a tag publish to the history being published, not every branch in the repo", async () => {
    // A release publishes main. Walking `--all` also walks unmerged feature branches, so a branch
    // someone else is still working on could block a release of code it is not part of, which is
    // exactly what happened: an in-flight branch with an unapproved author held up a tag of clean
    // main. Narrowing loses nothing, because that branch is still judged when it is proposed.
    const root = await createGitHistory(["noreply@github.com"]);
    try {
      // A side branch carrying an unapproved author, never merged.
      const branch = spawnSync("git", ["checkout", "--quiet", "-b", "someone-elses-work"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(branch.status, branch.stderr).toBe(0);
      await writeFile(join(root, "their-file.txt"), "their work\n");
      spawnSync("git", ["add", "."], { cwd: root });
      const theirs = spawnSync(
        "git",
        [
          "-c",
          "user.name=Someone Else",
          "-c",
          "user.email=nope@example.test",
          "commit",
          "--quiet",
          "-m",
          "their commit",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(theirs.status, theirs.stderr).toBe(0);
      spawnSync("git", ["checkout", "--quiet", "-"], { cwd: root });

      // The local sweep still sees it: nothing is hidden from the person working in the repo.
      const sweep = runScan(root);
      expect(sweep.status).toBe(1);
      expect(sweep.stderr).toContain("nope@example.test");

      // A tag publish judges what it is publishing, and that branch is not part of it.
      const publish = runScan(root, "", "refs/tags/v1.2.3");
      expect(publish.status, publish.stderr).toBe(0);
      expect(publish.stdout).toContain("public-surface scan ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("still rejects an unapproved author that is part of what a tag publishes", async () => {
    // The narrowing must not become a hole: anything in the published history is still judged.
    const root = await createGitHistory(["noreply@github.com", "nope@example.test"]);
    try {
      const publish = runScan(root, "", "refs/tags/v1.2.3");
      expect(publish.status).toBe(1);
      expect(publish.stderr).toContain("unapproved_commit_email");
      expect(publish.stderr).toContain("nope@example.test");
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
      `${"a".repeat(40)}@users.noreply.github.com`,
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

describe("public-surface packed history", () => {
  it("fails on a packed docs/history/ page or a packed `Status: HISTORICAL` banner, and not on unpacked ones", async () => {
    const root = await createGitHistory(["noreply@github.com"]);
    const setFiles = (files: string[]) =>
      writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ name: "public-surface-scan-fixture", version: "1.0.0", files }, null, 2)}\n`,
      );
    try {
      await mkdir(join(root, "docs/history"), { recursive: true });
      await writeFile(join(root, "docs/history/plan.md"), "# Old plan\n");
      await writeFile(join(root, "docs/guide.md"), "# Guide\n\nStatus: HISTORICAL (banner)\n");
      await setFiles(["docs/README.md"]);
      await writeFile(join(root, "docs/README.md"), "# Docs\n");
      expect(runScan(root).status).toBe(0);

      await setFiles(["docs"]);
      const packed = runScan(root);
      expect(packed.status).toBe(1);
      expect(packed.stderr).toContain("docs/history/plan.md:0: packed_history_doc");
      expect(packed.stderr).toContain("docs/guide.md:3: packed_historical_banner");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("public-surface sandbox ids", () => {
  // Shaped like an E2B id. Keys are built at run time so this file holds no id at one.
  const realShaped = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
  const sandboxIdKey = ["sandbox", "Id"].join("");
  const subjectKey = ["subject", "Sandbox", "Id"].join("");
  const resourcesKey = ["provider", "Resources"].join("");
  const planted = (value: string): string =>
    `${JSON.stringify(
      {
        [resourcesKey]: [{ kind: "sandbox", id: value }],
        lease: { [sandboxIdKey]: value },
        [subjectKey]: value,
      },
      null,
      2,
    )}\n`;

  it("fails a real-shaped id at every key, in tests/ and out of it, and passes only the marker or a test's fake id", async () => {
    const root = await createGitHistory(["noreply@github.com"]);
    try {
      await mkdir(join(root, "site/public/runs/demo"), { recursive: true });
      await mkdir(join(root, "tests/fixtures/copied-run"), { recursive: true });
      await writeFile(join(root, "site/public/runs/demo/run.json"), planted(realShaped));
      await writeFile(join(root, "tests/fixtures/copied-run/run.json"), planted(realShaped));
      await writeFile(join(root, "tests/fixtures/synthetic.json"), planted("fake-sandbox-001"));
      await writeFile(join(root, "site/public/runs/demo/fake.json"), planted("fake-sandbox-001"));
      await writeFile(
        join(root, "site/public/runs/demo/redacted.json"),
        planted("[redacted-sandbox-id]"),
      );
      const scan = runScan(root);
      expect(scan.status).toBe(1);
      const flagged = scan.stderr
        .split("\n")
        .filter((line) => line.includes(": sandbox_id_value: "))
        .map(
          (line) => `${line.split(":")[0]} ${line.split(": sandbox_id_value: ")[1]!.split(":")[0]}`,
        );
      const keys = ["providerResources[].id", "sandboxId", "subjectSandboxId"];
      expect(flagged.sort()).toEqual(
        [
          ...keys.map((key) => `site/public/runs/demo/run.json ${key}`),
          ...keys.map((key) => `tests/fixtures/copied-run/run.json ${key}`),
          ...keys.map((key) => `site/public/runs/demo/fake.json ${key}`),
        ].sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
