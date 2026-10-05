// After build: every command in skills/humanish/SKILL.md's "First Proof Run" block runs to
// completion for an agent. Each runs against the built CLI, installed as a dev dependency of a fresh
// project, with a fresh home directory, no provider keys and no terminal, and must exit 0 within its timeout.
// Lines the block marks `# live only` need keys and spend money, so they are skipped. The setup
// step the skill gives before the block, `init --yes`, runs first, and its printed next steps must
// use the invocation a project install gets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const COMMAND_TIMEOUT_MS = 120_000;
const INVOCATION = "npx humanish";

/** The fenced bash block under `## First Proof Run`, as command lines. */
function firstProofCommands(skill) {
  const section = skill.split(/^## /m).find((part) => part.startsWith("First Proof Run"));
  assert.ok(section, "SKILL.md has no First Proof Run section");
  const block = /```bash\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(block, "First Proof Run has no bash block");
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

const base = await mkdtemp(join(tmpdir(), "humanish-skill-proof-"));
try {
  const app = join(base, "app");
  const installed = join(app, "node_modules", "humanish");
  await mkdir(join(installed, "node_modules"), { recursive: true });
  await cp(join(root, "dist"), join(installed, "dist"), { recursive: true });
  await cp(join(root, "package.json"), join(installed, "package.json"));
  for (const name of Object.keys(manifest.dependencies))
    await symlink(join(root, "node_modules", name), join(installed, "node_modules", name), "dir");
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ name: "skill-proof-app", private: true, devDependencies: { humanish: "*" } }),
  );
  const cli = join(installed, "dist", "cli.js");
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, "home"),
    XDG_CONFIG_HOME: join(base, "config"),
    DO_NOT_TRACK: "1",
    HUMANISH_STRICT_KEYS: "1",
  };

  /** Runs one suggested command line with the built CLI in place of `npx humanish`. */
  function run(line) {
    assert.ok(line.startsWith(`${INVOCATION} `), `not a humanish command: ${line}`);
    const args = line.slice(INVOCATION.length).trim().split(/\s+/);
    const started = Date.now();
    const child = spawnSync(process.execPath, [cli, ...args], {
      cwd: app,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    assert.equal(child.error, undefined, `${line}: ${child.error}`);
    assert.equal(child.signal, null, `${line} did not finish in ${COMMAND_TIMEOUT_MS} ms`);
    assert.equal(
      child.status,
      0,
      `${line} exited ${child.status}:\n${child.stdout}${child.stderr}`,
    );
    process.stdout.write(`ok ${seconds}s ${line}\n`);
    return child.stdout;
  }

  const init = run(`${INVOCATION} init --yes`);
  const next = init.slice(init.indexOf("\nnext:\n"));
  const suggested = next
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim());
  assert.ok(suggested.length > 0, `init printed no next steps:\n${init}`);
  for (const command of suggested)
    assert.ok(command.startsWith(`${INVOCATION} `), `init suggested ${command}`);
  const agents = await readFile(join(app, "AGENTS.md"), "utf8");
  const agentCommands = agents.split("\n").filter((line) => /^(npx )?humanish /.test(line));
  assert.ok(agentCommands.length > 0, "AGENTS.md lists no commands");
  for (const command of agentCommands)
    assert.ok(command.startsWith(`${INVOCATION} `), `AGENTS.md suggests ${command}`);

  const skill = await readFile(join(root, "skills", "humanish", "SKILL.md"), "utf8");
  let runId;
  let ran = 0;
  for (const line of firstProofCommands(skill)) {
    if (/#\s*live only\s*$/.test(line)) {
      process.stdout.write(`skip (live only) ${line}\n`);
      continue;
    }
    const command = line.replace(/\s+#.*$/, "");
    if (command.includes("<id>")) assert.ok(runId, `${command} needs a run id from an earlier run`);
    const stdout = run(command.replaceAll("<id>", runId ?? "<id>"));
    if (command.includes("--json")) {
      const result = JSON.parse(stdout);
      if (/ run /.test(` ${command} `) && typeof result.runId === "string") runId = result.runId;
    }
    ran += 1;
  }
  assert.ok(ran >= 3, `ran only ${ran} commands from the First Proof Run block`);
  process.stdout.write(`skill first-run proof: ${ran} commands finished\n`);
} finally {
  await rm(base, { recursive: true, force: true });
}
