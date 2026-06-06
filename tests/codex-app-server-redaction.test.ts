import { mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { publicPathForTrace, redactText } from "../src/codex-app-server.js";

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
