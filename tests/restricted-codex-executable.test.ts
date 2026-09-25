import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRestrictedCodexAnalysisReadiness } from "../src/restricted-codex-analysis.js";
import { restrictedCodexNpmTarget } from "../src/restricted-codex-session.js";
import type { RestrictedCodexSpawn } from "../src/restricted-codex-transport.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const platforms = [
  { platform: "darwin", arch: "arm64", packageName: "codex-darwin-arm64", triple: "aarch64-apple-darwin", magic: "cffaedfe" },
  { platform: "linux", arch: "x64", packageName: "codex-linux-x64", triple: "x86_64-unknown-linux-musl", magic: "7f454c46" }
] as const;

describe("restricted Codex npm executable resolution", () => {
  it("matches the official npm launcher map for operator Unix architectures", () => {
    expect(restrictedCodexNpmTarget("linux", "x64")).toEqual({ packageName: "codex-linux-x64", triple: "x86_64-unknown-linux-musl" });
    expect(restrictedCodexNpmTarget("linux", "arm64")).toEqual({ packageName: "codex-linux-arm64", triple: "aarch64-unknown-linux-musl" });
    expect(restrictedCodexNpmTarget("darwin", "x64")).toEqual({ packageName: "codex-darwin-x64", triple: "x86_64-apple-darwin" });
    expect(restrictedCodexNpmTarget("darwin", "arm64")).toEqual({ packageName: "codex-darwin-arm64", triple: "aarch64-apple-darwin" });
    expect(restrictedCodexNpmTarget("win32", "x64")).toBeUndefined();
  });
  for (const target of platforms) {
    it.each(["hoisted", "nested", "bundled"] as const)(`resolves the ${target.platform} %s layout to a directly owned native executable`, async layout => {
      const directory = await mkdtemp(path.join(tmpdir(), "humanish-codex-layout-")); directories.push(directory);
      const modules = path.join(directory, "node_modules"), packageRoot = path.join(modules, "@openai", "codex");
      const launcher = path.join(packageRoot, "bin", "codex.js"), bin = path.join(modules, ".bin");
      await mkdir(path.dirname(launcher), { recursive: true }); await mkdir(bin);
      // This launcher must never execute: the production boundary owns the native child.
      await writeFile(launcher, "#!/usr/bin/env node\nthrow Error('npm shim executed');\n", { mode: 0o755 });
      await symlink(launcher, path.join(bin, "codex"));
      const nativeRoot = layout === "bundled" ? packageRoot : path.join(layout === "hoisted" ? modules : path.join(packageRoot, "node_modules"), "@openai", target.packageName);
      await mkdir(nativeRoot, { recursive: true });
      if (layout !== "bundled") await writeFile(path.join(nativeRoot, "package.json"), JSON.stringify({ name: `@openai/${target.packageName}`, version: "0.154.0" }));
      const native = path.join(nativeRoot, "vendor", target.triple, "bin", "codex");
      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(native, Buffer.from(target.magic, "hex"), { mode: 0o755 });
      const tempRoot = path.join(directory, "temp"), authHome = path.join(directory, "empty-auth");
      await mkdir(tempRoot); await mkdir(authHome);
      const calls: { file: string; args: string[]; detached: boolean }[] = [];
      const spawnFn: RestrictedCodexSpawn = (file, args, settings) => {
        calls.push({ file, args, detached: settings.detached });
        // Exercise version admission without executing a foreign-architecture fixture.
        return spawn(process.execPath, ["-e", "console.log('codex-cli 0.154.0')"], settings);
      };
      const result = await checkRestrictedCodexAnalysisReadiness({}, {
        platform: target.platform, arch: target.arch, authHome, tempRoot, spawnFn,
        env: { HOME: directory, PATH: bin }
      });
      expect(result).toEqual({ ready: false, errorCode: "codex_login_required" });
      expect(calls).toEqual([{ file: await realpath(native), args: ["--version"], detached: false }]);
      expect(await readdir(tempRoot)).toEqual([]);
      expect(await readdir(authHome)).toEqual([]);
    });
  }
});
