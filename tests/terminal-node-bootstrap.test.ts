import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_NODE_BOOTSTRAP_COMMAND, TERMINAL_NODE_NPM_PREFIX_SCRIPT } from "../src/terminal-node-bootstrap.js";

const execFileAsync = promisify(execFile);

// Exercise the actual shell command without networking or privilege. These are local executable
// stand-ins, not vendor response fixtures. Real sha256sum rejects the synthetic corrupt download.
describe("terminal Node bootstrap", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "humanish-node-bootstrap-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function executable(name: string, script: string) {
    const file = path.join(root, name);
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
  }

  async function run(options: { nodeMajor?: number; npmWorks?: boolean; arch?: string; networkFails?: boolean; missingPrerequisite?: boolean; failingExitHook?: boolean } = {}) {
    await executable("node", `echo '${options.nodeMajor ?? 18}'`);
    await executable("npm", options.npmWorks === false ? "exit 1" : "echo '10.9.4'");
    await executable("uname", `if [ "$1" = '-s' ]; then echo Linux; else echo '${options.arch ?? "x86_64"}'; fi`);
    await executable("sudo", `echo unexpected-privilege >> "$BOOTSTRAP_TEST_ROOT/privilege.log"; exit 91`);
    await executable("tar", `echo unexpected-extraction >> "$BOOTSTRAP_TEST_ROOT/extraction.log"; exit 92`);
    await executable("curl", [
      `printf '%s\\n' "$@" > "$BOOTSTRAP_TEST_ROOT/curl-args.txt"`,
      ...(options.networkFails ? ["exit 28"] : [
        `while [ "$#" -gt 0 ]; do if [ "$1" = '--output' ]; then shift; output="$1"; fi; shift; done`,
        `printf '%s' 'deliberately corrupt local archive fixture' > "$output"`
      ])
    ].join("\n"));
    try {
      const command = options.failingExitHook
        ? `exit() { builtin exit 73; };\n${TERMINAL_NODE_BOOTSTRAP_COMMAND}`
        : TERMINAL_NODE_BOOTSTRAP_COMMAND;
      const result = await execFileAsync("/bin/bash", ["-c", command], {
        env: { PATH: options.missingPrerequisite ? root : `${root}:/usr/bin:/bin`, BOOTSTRAP_TEST_ROOT: root }, timeout: 5_000
      });
      return { code: 0, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code: number; stderr: string };
      return { code: failure.code, stderr: failure.stderr };
    }
  }

  async function neverPrivileged() {
    expect(await stat(path.join(root, "privilege.log")).catch(() => undefined)).toBeUndefined();
    expect(await stat(path.join(root, "extraction.log")).catch(() => undefined)).toBeUndefined();
  }

  it("sets the installed npm distribution default once without replacing its other settings", async () => {
    const config = path.join(root, "npmrc");
    const original = "fund=false\naudit=false";
    await writeFile(config, original);
    await execFileAsync(process.execPath, ["-e", TERMINAL_NODE_NPM_PREFIX_SCRIPT, config]);
    await execFileAsync(process.execPath, ["-e", TERMINAL_NODE_NPM_PREFIX_SCRIPT, config]);
    expect(await readFile(config, "utf8")).toBe(`${original}\nprefix=/usr/local\n`);
  });

  it("creates a missing built-in config without requiring a user/global config file", async () => {
    const config = path.join(root, "npmrc");
    await execFileAsync(process.execPath, ["-e", TERMINAL_NODE_NPM_PREFIX_SCRIPT, config]);
    expect(await readFile(config, "utf8")).toBe("\nprefix=/usr/local\n");
  });

  it("preserves an existing distribution prefix and all original file bytes", async () => {
    const config = path.join(root, "npmrc");
    const original = "# distribution settings\n\t prefix = /custom/distribution\nfund=false\n";
    await writeFile(config, original);
    await execFileAsync(process.execPath, ["-e", TERMINAL_NODE_NPM_PREFIX_SCRIPT, config]);
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("does not treat a commented prefix as an active distribution default", async () => {
    const config = path.join(root, "npmrc");
    await writeFile(config, "# prefix=/old/example\n");
    await execFileAsync(process.execPath, ["-e", TERMINAL_NODE_NPM_PREFIX_SCRIPT, config]);
    expect(await readFile(config, "utf8")).toContain("\nprefix=/usr/local\n");
  });

  it("reuses working Node >=20 and npm without network or privilege", async () => {
    expect((await run({ nodeMajor: 22 })).code).toBe(0);
    expect(await stat(path.join(root, "curl-args.txt")).catch(() => undefined)).toBeUndefined();
    await neverPrivileged();
  });

  it("finishes the working-runtime path without calling an explicit exit hook", async () => {
    expect((await run({ nodeMajor: 22, failingExitHook: true })).code).toBe(0);
    expect(await stat(path.join(root, "curl-args.txt")).catch(() => undefined)).toBeUndefined();
    await neverPrivileged();
  });

  it.each(["x86_64", "aarch64"])("rejects a corrupt %s archive before privileged extraction", async (arch) => {
    const result = await run({ arch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum did not match the trusted release");
    await neverPrivileged();
    const args = (await readFile(path.join(root, "curl-args.txt"), "utf8")).trim().split("\n");
    expect(args.at(-1)).toMatch(new RegExp(`/node-v22\\.23\\.2-linux-${arch === "x86_64" ? "x64" : "arm64"}\\.tar\\.gz$`));
    expect(args[args.indexOf("--proto") + 1]).toBe("=https");
    expect(args[args.indexOf("--proto-redir") + 1]).toBe("=https");
    expect(Number(args[args.indexOf("--max-time") + 1])).toBeLessThan(300);
    expect(Number(args[args.indexOf("--retry-max-time") + 1])).toBeLessThan(300);
    const archive = args[args.indexOf("--output") + 1];
    expect(await stat(path.dirname(archive!)).catch(() => undefined)).toBeUndefined();
  });

  it("does not accept an installed Node whose npm cannot run", async () => {
    const result = await run({ nodeMajor: 22, npmWorks: false });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum did not match");
    expect(await stat(path.join(root, "curl-args.txt"))).toBeDefined();
    await neverPrivileged();
  });

  it("fails closed on a download failure before installation", async () => {
    expect((await run({ networkFails: true })).code).toBe(28);
    await neverPrivileged();
  });

  it("refuses an unsupported architecture before network or privilege", async () => {
    const result = await run({ arch: "riscv64" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("supported Linux x64/arm64");
    expect(await stat(path.join(root, "curl-args.txt")).catch(() => undefined)).toBeUndefined();
    await neverPrivileged();
  });

  it("names a missing prerequisite before network or privilege", async () => {
    const result = await run({ missingPrerequisite: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("bootstrap requires sha256sum");
    expect(await stat(path.join(root, "curl-args.txt")).catch(() => undefined)).toBeUndefined();
    await neverPrivileged();
  });
});
