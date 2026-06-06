import { mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { containsSensitive, publicPathForTrace, redactText, redactToSecretLabel } from "../src/redaction.js";

describe("codex app-server trace redaction", () => {
  it("labels a symlinked target cwd as [target-cwd] even when the actor reports the realpath form", async () => {
    // Reproduces the macOS /tmp -> /private/tmp class of bug deterministically on
    // any host: the configured root is the symlinked form, the actor reports the
    // resolved realpath form. Without symlink-aware canonicalization, path.relative
    // returns a "../"-prefixed path and the absolute temp path leaks into the trace.
    const realRoot = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "mimetic-redaction-real-")));
    const linkRoot = `${realRoot}-link`;
    await symlink(realRoot, linkRoot);

    try {
      const reportedCwd = path.join(realRoot, "workspace");
      const reportedRealpath = realpathSync.native(realRoot);

      // root passed in symlinked form, value in resolved form -> still [target-cwd].
      expect(publicPathForTrace(reportedRealpath, linkRoot)).toBe("[target-cwd]");
      expect(publicPathForTrace(reportedCwd, linkRoot)).toBe("[target-cwd]/workspace");
      // And no absolute temp path survives in the labeled output.
      expect(publicPathForTrace(reportedCwd, linkRoot)).not.toContain(realRoot);
    } finally {
      await rm(linkRoot, { force: true });
      await rm(realRoot, { force: true, recursive: true });
    }
  });

  it("redacts absolute temp paths that fall outside the target cwd", () => {
    // Defense in depth: when an actor reports a path that cannot be relativized to
    // the target cwd, redactText must not let a raw temp path through.
    expect(redactText("ran from /private/tmp/claude-501/job/x")).not.toContain("/private/tmp/");
    expect(redactText("ran from /tmp/build-7f/output")).not.toContain("/tmp/build-7f/output");
    expect(redactText("ran from /var/folders/aa/bb/T/run")).not.toContain("/var/folders/aa/bb/T/run");
    expect(redactText("/private/tmp/secret/path")).toContain("[REDACTED_LOCAL_PATH]");
  });

  it("falls back to redaction for an absolute path under a different root", () => {
    const root = realpathSync.native(os.tmpdir());
    expect(publicPathForTrace("/tmp/some-other-root/file", `${root}/mimetic-unrelated-root`)).toContain(
      "[REDACTED_LOCAL_PATH]"
    );
  });
});

describe("shared redaction helpers", () => {
  // Build secret-shaped values at runtime so the literal source carries no
  // scannable token (the public-surface scanner also reads test files).
  const fakeOpenAiKey = `sk-proj-${"abcdefghijklmnopqrstuvwxyz0123"}`;
  const fakeE2bKey = `e2b_${"0123456789abcdef0123"}`;

  it("detects secret-shaped tokens and known local paths", () => {
    expect(containsSensitive(`token ${fakeOpenAiKey}`)).toBe(true);
    expect(containsSensitive(fakeE2bKey)).toBe(true);
    expect(containsSensitive("ran from /tmp/build-7f/out")).toBe(true);
    expect(containsSensitive("ran from /var/folders/aa/bb/T/run")).toBe(true);
    expect(containsSensitive("a perfectly safe synthetic line")).toBe(false);
  });

  it("detection is stable across repeated calls (no sticky lastIndex state)", () => {
    const text = "ran from /tmp/build-7f/out";
    expect(containsSensitive(text)).toBe(true);
    expect(containsSensitive(text)).toBe(true);
    expect(containsSensitive(text)).toBe(true);
  });

  it("redactToSecretLabel collapses both secrets and paths to one label", () => {
    const out = redactToSecretLabel(`key ${fakeOpenAiKey} at /tmp/x/y`);
    expect(out).toContain("[REDACTED_SECRET]");
    expect(out).not.toContain(fakeOpenAiKey);
    expect(out).not.toContain("/tmp/x/y");
    expect(out).not.toContain("[REDACTED_LOCAL_PATH]");
  });
});
