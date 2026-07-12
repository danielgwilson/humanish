import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createLocalTreeArchive,
  DEFAULT_LOCAL_TREE_MAX_ARCHIVE_BYTES,
  enumerateLocalTree,
  LOCAL_TREE_DENYLIST_BASENAME_PATTERNS,
  LOCAL_TREE_DENYLIST_PATH_SEGMENTS,
} from "../src/source-archive.js";

// Deterministic author/committer identity so `git commit` never depends on
// (or waits on) the host's global gitconfig -- no GPG signing, no missing
// user.name/user.email.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Humanish Test",
  GIT_AUTHOR_EMAIL: "humanish-test@example.com",
  GIT_COMMITTER_NAME: "Humanish Test",
  GIT_COMMITTER_EMAIL: "humanish-test@example.com",
};

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

function commitAll(cwd: string, files: string[], message: string): void {
  runGit(cwd, ["add", ...files]);
  runGit(cwd, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

function listTarEntries(archivePath: string): string[] {
  return execFileSync("tar", ["-tzf", archivePath])
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function listTarEntriesVerbose(archivePath: string): string[] {
  return execFileSync("tar", ["-tvzf", archivePath])
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

const tempDirsToClean: string[] = [];

async function makeTempRoot(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `humanish-source-archive-${label}-`));
  tempDirsToClean.push(dir);
  return dir;
}

/**
 * A git fixture exercising every enumeration edge case in one tree: a tracked
 * file, a gitignored build-output file, an untracked-but-not-ignored file,
 * planted secret-shaped files (some tracked), and a nested repo boundary.
 * Intentionally left with untracked content, so it is NOT a "clean" fixture --
 * tests that need a clean/dirty distinction build their own minimal repo.
 */
async function buildGitFixture(): Promise<{ root: string }> {
  const root = await makeTempRoot("git-root");

  await writeFile(path.join(root, "tracked.txt"), "tracked content v1\n");
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/junk.txt"), "build output\n");
  await writeFile(path.join(root, "loose.txt"), "untracked but not ignored\n");
  await writeFile(path.join(root, ".env"), "SECRET=abc123\n");
  await writeFile(path.join(root, ".env.example"), "SECRET=\n");
  // Assembled from fragments so the public-surface scanner never sees a
  // key-block literal in this test source; the fixture bytes are identical.
  const fakePemBody = ["-----BEGIN PRIVATE", " KEY-----", "\n", "fake", "\n", "-----END PRIVATE", " KEY-----", "\n"].join("");
  await writeFile(path.join(root, "key.pem"), fakePemBody);

  await mkdir(path.join(root, "nested-repo"), { recursive: true });
  await writeFile(path.join(root, "nested-repo/nested-file.txt"), "nested repo content\n");

  runGit(root, ["init", "-q", "."]);
  commitAll(root, ["tracked.txt", ".gitignore", ".env", ".env.example", "key.pem"], "init");

  // Make nested-repo its own repo AFTER the parent's first commit, so the
  // parent never tracked its contents as plain files.
  runGit(path.join(root, "nested-repo"), ["init", "-q", "."]);

  return { root };
}

describe("always-on denylist constants", () => {
  it("exposes the documented path segments, basename patterns, and byte cap", () => {
    expect(LOCAL_TREE_DENYLIST_PATH_SEGMENTS).toEqual([".git", "node_modules", ".humanish", ".homun"]);
    expect(LOCAL_TREE_DENYLIST_BASENAME_PATTERNS).toEqual([
      ".env*",
      "*.pem",
      "*.key",
      "*.p12",
      "*.pfx",
      "id_rsa*",
      "id_dsa*",
      "id_ed25519*",
      "id_ecdsa*",
      "*.keystore",
      "*.jks",
      "*.ppk",
      "*.gpg",
      "*.tfstate",
      "terraform.tfstate.backup",
      ".npmrc",
      ".netrc",
      ".dockercfg",
      "kubeconfig",
      "credentials.json",
      "service-account.json",
      "serviceAccount.json",
      "service_account.json",
      "secrets.json",
      "secrets.yaml",
      "secrets.yml",
      "auth.json",
    ]);
    expect(DEFAULT_LOCAL_TREE_MAX_ARCHIVE_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe("git-aware enumeration", () => {
  it("honors .gitignore: an ignored file never enters entries or the tar listing", async () => {
    const { root } = await buildGitFixture();

    const { entries, git } = enumerateLocalTree(root);
    expect(git).toBeDefined();
    expect(entries.some((entry) => entry.relPath === "dist/junk.txt")).toBe(false);
    expect(entries.some((entry) => entry.relPath.startsWith("dist/"))).toBe(false);

    const archive = createLocalTreeArchive(root);
    const tarEntries = listTarEntries(archive.archivePath);
    expect(tarEntries).not.toContain("dist/junk.txt");
    expect(tarEntries.some((entry) => entry.startsWith("dist/"))).toBe(false);
  });

  it("includes an untracked-but-not-ignored file (dirty-tree semantics)", async () => {
    const { root } = await buildGitFixture();

    const { entries } = enumerateLocalTree(root);
    expect(entries.some((entry) => entry.relPath === "loose.txt")).toBe(true);

    const archive = createLocalTreeArchive(root);
    expect(listTarEntries(archive.archivePath)).toContain("loose.txt");
  });

  it("excludes planted .env, .env.example, and key.pem even when tracked", async () => {
    const { root } = await buildGitFixture();

    const { entries } = enumerateLocalTree(root);
    const relPaths = entries.map((entry) => entry.relPath);
    expect(relPaths).not.toContain(".env");
    expect(relPaths).not.toContain(".env.example");
    expect(relPaths).not.toContain("key.pem");

    const archive = createLocalTreeArchive(root);
    const tarEntries = listTarEntries(archive.archivePath);
    expect(tarEntries).not.toContain(".env");
    expect(tarEntries).not.toContain(".env.example");
    expect(tarEntries).not.toContain("key.pem");
  });

  it("does not leak a nested repo's own files into the archive", async () => {
    const { root } = await buildGitFixture();

    const { entries } = enumerateLocalTree(root);
    const relPaths = entries.map((entry) => entry.relPath);
    expect(relPaths).not.toContain("nested-repo/");
    expect(relPaths.some((relPath) => relPath.startsWith("nested-repo/"))).toBe(false);

    const archive = createLocalTreeArchive(root);
    expect(listTarEntries(archive.archivePath).some((entry) => entry.startsWith("nested-repo"))).toBe(false);
  });
});

describe("fallback (non-git) enumeration", () => {
  it("has no git info and applies only the denylist, no .gitignore semantics", async () => {
    const root = await makeTempRoot("fallback-denylist");
    await writeFile(path.join(root, "tracked.txt"), "hello\n");
    await writeFile(path.join(root, ".env"), "SECRET=1\n");
    await writeFile(path.join(root, ".env.example"), "SECRET=\n");
    await writeFile(path.join(root, "key.pem"), "fake key\n");
    await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "module.exports = {};\n");

    const { entries, git } = enumerateLocalTree(root);
    expect(git).toBeUndefined();

    const relPaths = entries.map((entry) => entry.relPath);
    expect(relPaths).toContain("tracked.txt");
    expect(relPaths).not.toContain(".env");
    expect(relPaths).not.toContain(".env.example");
    expect(relPaths).not.toContain("key.pem");
    expect(relPaths.some((relPath) => relPath.startsWith("node_modules/"))).toBe(false);
  });

  it("sorts entries bytewise by relPath", async () => {
    const root = await makeTempRoot("sort-order");
    await writeFile(path.join(root, "b.txt"), "b\n");
    await writeFile(path.join(root, "a.txt"), "a\n");
    await mkdir(path.join(root, "A"), { recursive: true });
    await writeFile(path.join(root, "A/nested.txt"), "nested\n");

    const { entries } = enumerateLocalTree(root);
    const relPaths = entries.map((entry) => entry.relPath);
    const bytewiseSorted = [...relPaths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    expect(relPaths).toEqual(bytewiseSorted);
  });
});

describe("extraExclude", () => {
  it("matches both a leading path prefix and an exact basename, without over-matching a lookalike prefix", async () => {
    const root = await makeTempRoot("extra-exclude");
    await mkdir(path.join(root, "big-media"), { recursive: true });
    await writeFile(path.join(root, "big-media/video.mp4"), "big\n");
    await mkdir(path.join(root, "big-media2"), { recursive: true });
    await writeFile(path.join(root, "big-media2/file.txt"), "not excluded\n");
    await writeFile(path.join(root, "notes.secret"), "basename match at root\n");
    await mkdir(path.join(root, "keep"), { recursive: true });
    await writeFile(path.join(root, "keep/notes.secret"), "basename match nested\n");
    await writeFile(path.join(root, "keep.txt"), "kept\n");

    const { entries } = enumerateLocalTree(root, { extraExclude: ["big-media", "notes.secret"] });
    const relPaths = entries.map((entry) => entry.relPath);

    expect(relPaths.some((relPath) => relPath.startsWith("big-media/"))).toBe(false);
    expect(relPaths).not.toContain("notes.secret");
    expect(relPaths).not.toContain("keep/notes.secret");
    expect(relPaths).toContain("keep.txt");
    expect(relPaths).toContain("big-media2/file.txt");
  });
});

describe("symlinks", () => {
  it("stores a symlink as a symlink; secret bytes at an outside target never enter the archive", async () => {
    const root = await makeTempRoot("symlink-root");
    const outsideDir = await makeTempRoot("symlink-outside");
    const secretPath = path.join(outsideDir, "outside-secret.txt");
    const secretBytes = "FAKE_OUTSIDE_SECRET_9f3ac1";
    await writeFile(secretPath, `${secretBytes}\n`);
    await writeFile(path.join(root, "regular.txt"), "regular file\n");
    await symlink(secretPath, path.join(root, "link-to-secret"));

    const { entries } = enumerateLocalTree(root);
    const linkEntry = entries.find((entry) => entry.relPath === "link-to-secret");
    expect(linkEntry?.kind).toBe("symlink");

    const archive = createLocalTreeArchive(root);
    const archiveBytes = await readFile(archive.archivePath);
    expect(archiveBytes.includes(Buffer.from(secretBytes, "utf8"))).toBe(false);

    const verboseEntries = listTarEntriesVerbose(archive.archivePath);
    const linkLine = verboseEntries.find((line) => line.includes("link-to-secret"));
    expect(linkLine).toBeDefined();
    expect(linkLine?.startsWith("l")).toBe(true);
    expect(linkLine).toContain(`-> ${secretPath}`);

    // The digest hashes the target STRING, not target bytes: changing the
    // outside file's content must not change archiveSha256...
    const beforeContentChange = createLocalTreeArchive(root).archiveSha256;
    await writeFile(secretPath, "completely different content\n");
    const afterContentChange = createLocalTreeArchive(root).archiveSha256;
    expect(afterContentChange).toBe(beforeContentChange);

    // ...but re-pointing the symlink at a different target string does.
    await rm(path.join(root, "link-to-secret"));
    await symlink(path.join(outsideDir, "does-not-need-to-exist.txt"), path.join(root, "link-to-secret"));
    const afterRetarget = createLocalTreeArchive(root).archiveSha256;
    expect(afterRetarget).not.toBe(beforeContentChange);
  });
});

describe("digest stability", () => {
  it("is stable across repeated calls on an unchanged tree", async () => {
    const { root } = await buildGitFixture();

    const first = createLocalTreeArchive(root);
    const second = createLocalTreeArchive(root);
    expect(first.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.archiveSha256).toBe(first.archiveSha256);
  });

  it("changes when a tracked file's content changes", async () => {
    const { root } = await buildGitFixture();

    const before = createLocalTreeArchive(root).archiveSha256;
    await writeFile(path.join(root, "tracked.txt"), "tracked content v2, now edited\n");
    const after = createLocalTreeArchive(root).archiveSha256;
    expect(after).not.toBe(before);
  });

  it("does not change when an ignored/excluded path is mutated", async () => {
    const { root } = await buildGitFixture();

    const before = createLocalTreeArchive(root).archiveSha256;
    await writeFile(path.join(root, "dist/junk.txt"), "totally different build output\n");
    await writeFile(path.join(root, ".env"), "SECRET=different-value-entirely\n");
    const after = createLocalTreeArchive(root).archiveSha256;
    expect(after).toBe(before);
  });
});

describe("git info", () => {
  it("reports a 40-hex commit and a truthful dirty flag", async () => {
    const root = await makeTempRoot("git-info-clean");
    await writeFile(path.join(root, "tracked.txt"), "hello\n");
    runGit(root, ["init", "-q", "."]);
    commitAll(root, ["tracked.txt"], "init");

    const clean = enumerateLocalTree(root);
    expect(clean.git?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.git?.dirty).toBe(false);

    await writeFile(path.join(root, "tracked.txt"), "touched\n");
    const dirty = enumerateLocalTree(root);
    expect(dirty.git?.dirty).toBe(true);
    expect(dirty.git?.commit).toBe(clean.git?.commit);
  });

  it("leaves git undefined for a non-git root", async () => {
    const root = await makeTempRoot("non-git-root");
    await writeFile(path.join(root, "file.txt"), "hi\n");

    const { git } = enumerateLocalTree(root);
    expect(git).toBeUndefined();
  });
});

describe("fail-closed behavior", () => {
  it("rejects a tiny maxArchiveBytes, naming the byte count and the maxArchiveBytes knob", async () => {
    const root = await makeTempRoot("size-cap");
    await writeFile(path.join(root, "big.txt"), "x".repeat(1000));

    let thrown: unknown;
    try {
      createLocalTreeArchive(root, { maxArchiveBytes: 10 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("maxArchiveBytes");
    expect(message).toContain("1000");
  });

  it("rejects an empty root (zero packable entries)", async () => {
    const root = await makeTempRoot("empty-root");
    expect(() => createLocalTreeArchive(root)).toThrowError(/packable/);
  });

  it("rejects a root that does not exist", async () => {
    const parent = await makeTempRoot("missing-parent");
    const missingRoot = path.join(parent, "does-not-exist");
    expect(() => createLocalTreeArchive(missingRoot)).toThrowError(/does not exist/);
  });

  it("rejects a root that is not a directory", async () => {
    const root = await makeTempRoot("not-a-directory");
    const filePath = path.join(root, "file.txt");
    await writeFile(filePath, "hi\n");
    expect(() => createLocalTreeArchive(filePath)).toThrowError(/not a directory/);
  });
});

describe("archive shape", () => {
  it("returns archivePath, a 64-hex archiveSha256, fileCount, and totalBytes", async () => {
    const root = await makeTempRoot("basic-archive");
    await writeFile(path.join(root, "a.txt"), "hello world\n");
    await writeFile(path.join(root, "b.txt"), "second file\n");

    const archive = createLocalTreeArchive(root);
    expect(archive.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archive.fileCount).toBe(2);
    expect(archive.totalBytes).toBeGreaterThan(0);
    expect(archive.git).toBeUndefined();
    await expect(stat(archive.archivePath)).resolves.toBeTruthy();
  });

  it("writes to a custom outputPath when provided", async () => {
    const root = await makeTempRoot("custom-output-root");
    await writeFile(path.join(root, "a.txt"), "hi\n");
    const outDir = await makeTempRoot("custom-output-dest");
    const outputPath = path.join(outDir, "nested", "archive.tar.gz");

    const archive = createLocalTreeArchive(root, { outputPath });
    expect(archive.archivePath).toBe(path.resolve(outputPath));
    await expect(stat(archive.archivePath)).resolves.toBeTruthy();
  });
});

describe("adversarial-review hardening (PR #265 pre-merge findings)", () => {
  it("excludes credential-shaped filenames beyond key material, even when tracked", async () => {
    const root = await makeTempRoot("denylist-credentials");
    await writeFile(path.join(root, "app.txt"), "app\n");
    await writeFile(path.join(root, "credentials.json"), '{"private_key_id":"fake"}\n');
    await writeFile(path.join(root, "release.jks"), "fake keystore bytes\n");
    runGit(root, ["init", "-q", "."]);
    commitAll(root, ["app.txt", "credentials.json", "release.jks"], "init");
    await writeFile(path.join(root, ".npmrc"), "//registry.example.com/:_authToken=fake\n");
    await writeFile(path.join(root, "terraform.tfstate"), "{}\n");

    const { entries } = enumerateLocalTree(root);
    const relPaths = entries.map((entry) => entry.relPath);
    expect(relPaths).toContain("app.txt");
    expect(relPaths).not.toContain("credentials.json");
    expect(relPaths).not.toContain("release.jks");
    expect(relPaths).not.toContain(".npmrc");
    expect(relPaths).not.toContain("terraform.tfstate");
  });

  it("normalizes extraExclude entries with leading ./ and trailing /", async () => {
    const root = await makeTempRoot("exclude-normalize");
    await mkdir(path.join(root, "secrets-dir"));
    await writeFile(path.join(root, "secrets-dir/creds.txt"), "fake\n");
    await writeFile(path.join(root, "kept.txt"), "kept\n");
    runGit(root, ["init", "-q", "."]);
    commitAll(root, ["."], "init");

    for (const entry of ["secrets-dir/", "./secrets-dir"]) {
      const { entries } = enumerateLocalTree(root, { extraExclude: [entry] });
      const relPaths = entries.map((e) => e.relPath);
      expect(relPaths).toContain("kept.txt");
      expect(relPaths).not.toContain("secrets-dir/creds.txt");
    }
  });

  it("rejects absolute-path and glob extraExclude entries instead of silently no-op'ing", async () => {
    const root = await makeTempRoot("exclude-reject");
    await writeFile(path.join(root, "a.txt"), "a\n");
    expect(() => enumerateLocalTree(root, { extraExclude: ["/etc/secrets"] })).toThrow(/absolute path/);
    expect(() => enumerateLocalTree(root, { extraExclude: ["**/secrets"] })).toThrow(/glob syntax/);
  });

  it("packs an unborn-HEAD repo (git init, no commit) with git info absent", async () => {
    const root = await makeTempRoot("unborn-head");
    await writeFile(path.join(root, "fresh.txt"), "scaffolded\n");
    runGit(root, ["init", "-q", "."]);

    const archive = createLocalTreeArchive(root);
    expect(archive.git).toBeUndefined();
    expect(archive.fileCount).toBeGreaterThan(0);
    expect(listTarEntries(archive.archivePath).join("\n")).toContain("fresh.txt");
  });

  it("scopes the dirty flag to the packed subtree, not the whole enclosing repo", async () => {
    const repo = await makeTempRoot("subtree-dirty");
    await mkdir(path.join(repo, "packed-app"));
    await mkdir(path.join(repo, "sibling-pkg"));
    await writeFile(path.join(repo, "packed-app/app.txt"), "app\n");
    await writeFile(path.join(repo, "sibling-pkg/lib.txt"), "lib\n");
    runGit(repo, ["init", "-q", "."]);
    commitAll(repo, ["."], "init");

    const packedRoot = path.join(repo, "packed-app");

    const clean = enumerateLocalTree(packedRoot);
    expect(clean.git?.dirty).toBe(false);

    await writeFile(path.join(repo, "sibling-pkg/lib.txt"), "lib changed elsewhere\n");
    const siblingDirty = enumerateLocalTree(packedRoot);
    expect(siblingDirty.git?.dirty).toBe(false);

    await writeFile(path.join(repo, "packed-app/app.txt"), "app changed here\n");
    const selfDirty = enumerateLocalTree(packedRoot);
    expect(selfDirty.git?.dirty).toBe(true);
  });

  it("packing error messages never contain the absolute root path", async () => {
    const root = await makeTempRoot("error-paths");
    try {
      createLocalTreeArchive(root);
      expect.unreachable("empty root must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain(tmpdir());
    }
  });
});

afterAll(async () => {
  for (const dir of tempDirsToClean.splice(0, tempDirsToClean.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});
