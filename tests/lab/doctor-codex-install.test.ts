import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodexCliVersion } from "../../src/actors/codex/codex-admission.js";
import { restrictedCodexNpmTarget } from "../../src/actors/codex/restricted-executable.js";
import { localCodexParticipantCheck } from "../../src/lab/doctor.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A project with Codex installed by `npm install -D @openai/codex`: node_modules/.bin/codex links
 * to the npm launcher, whose native package holds the executable. The native is this node binary,
 * so `--version` answers with no Codex release and the launch stops at the version check.
 */
async function projectWithLocalCodex(): Promise<{ project: string; bin: string }> {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "humanish-local-codex-")));
  directories.push(project);
  const target = restrictedCodexNpmTarget(process.platform, process.arch);
  if (target === undefined) throw new Error("this host has no Codex npm target");
  const modules = path.join(project, "node_modules");
  const launcher = path.join(modules, "@openai", "codex", "bin", "codex.js");
  const bin = path.join(modules, ".bin");
  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(bin);
  await writeFile(launcher, "#!/usr/bin/env node\nthrow Error('npm shim executed');\n", {
    mode: 0o755,
  });
  await symlink(launcher, path.join(bin, "codex"));
  const nativeRoot = path.join(modules, "@openai", target.packageName);
  await mkdir(path.join(nativeRoot, "vendor", target.triple, "bin"), { recursive: true });
  await writeFile(
    path.join(nativeRoot, "package.json"),
    JSON.stringify({ name: `@openai/${target.packageName}`, version: "0.150.0" }),
  );
  await symlink(process.execPath, path.join(nativeRoot, "vendor", target.triple, "bin", "codex"));
  return { project, bin };
}

describe("doctor's Codex recovery for a project-local Codex", () => {
  it.skipIf(restrictedCodexNpmTarget(process.platform, process.arch) === undefined)(
    "names the project's binary and the command that replaces it there, as the 0.106.1 live pass found",
    async () => {
      const { project, bin } = await projectWithLocalCodex();
      const home = await mkdtemp(path.join(tmpdir(), "humanish-local-codex-home-"));
      directories.push(home);

      const check = await localCodexParticipantCheck({ env: { HOME: home, PATH: bin } });

      const version = defaultCodexCliVersion();
      expect(check.ok).toBe(false);
      expect(check.message).toContain("codex_unsupported_version");
      expect(check.message).toContain(`\`${path.join(bin, "codex")}\``);
      expect(check.message).toContain(
        `run \`npm install -D @openai/codex@${version}\` in \`${project}\``,
      );
      expect(check.message).toContain("`npm uninstall @openai/codex`");
      // A global install leaves this binary first on PATH, so it is not the advice.
      expect(check.message).not.toContain("npm install -g");
    },
  );
});
