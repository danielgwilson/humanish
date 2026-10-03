// After build: the built CLI, installed in each place a user can install it, names the command that
// adds the optional @e2b/desktop peer where Node will resolve it. Where humanish is installed is
// read from its own file's real path, so each case is a real copy of the package at that path,
// with its dependencies linked in and no @e2b/desktop anywhere Node looks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = await mkdtemp(join(tmpdir(), "humanish-peer-proof-"));
const app = join(base, "app");
const syntheticKey = "synthetic-peer-proof-key";

/** One copy of the package, moved from case to case: a rename keeps every file's real path new. */
let current = join(base, "package");
async function preparePackage() {
  await mkdir(current, { recursive: true });
  await cp(join(root, "dist"), join(current, "dist"), { recursive: true });
  await cp(join(root, "package.json"), join(current, "package.json"));
  await mkdir(join(current, "node_modules"));
  for (const name of Object.keys(manifest.dependencies))
    await symlink(join(root, "node_modules", name), join(current, "node_modules", name), "dir");
}
async function moveTo(packageDir) {
  await mkdir(dirname(packageDir), { recursive: true });
  await rename(current, packageDir);
  current = packageDir;
}

function humanish(cwd, env, ...args) {
  const child = spawnSync(process.execPath, [join(current, "dist/cli.js"), ...args, "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: join(base, "home"),
      XDG_CONFIG_HOME: join(base, "config"),
      DO_NOT_TRACK: "1",
      HUMANISH_STRICT_KEYS: "1",
      E2B_API_KEY: syntheticKey,
      ...env,
    },
  });
  assert.equal(child.error, undefined, `${args.join(" ")}: ${child.error}`);
  return child;
}

/** doctor's desktop SDK line, and reclaim's error when it loads the SDK for a receipt. */
function peerMessages(cwd, env) {
  const doctor = JSON.parse(humanish(cwd, env, "doctor").stdout);
  const sdk = doctor.checks.find((check) => check.name === "e2b desktop sdk");
  assert.match(sdk.message, /^optional peer @e2b\/desktop is not installed/, sdk.message);
  // From the same directory, with the run found through --cwd: the advice follows the process's
  // own working directory.
  const reclaim = humanish(cwd, env, "reclaim", "--run", "proof-run", "--cwd", app);
  return { doctor: sdk.message, reclaim: `${reclaim.stdout}\n${reclaim.stderr}` };
}

const both = "`npm i -D humanish @e2b/desktop` then `npx humanish run <study>`";
const mono = join(base, "mono");
const cases = [
  {
    name: "this project, from a nested package that does not declare humanish",
    packageDir: join(app, "node_modules", "humanish"),
    cwd: join(app, "packages", "site"),
    command: "`npm i -D --prefix ../.. @e2b/desktop`",
  },
  {
    name: "a pnpm workspace member that declares humanish when the root does not",
    packageDir: join(mono, "node_modules", ".pnpm", "humanish@0.0.0", "node_modules", "humanish"),
    cwd: join(mono, "packages", "web"),
    command: "`pnpm add -D @e2b/desktop`",
  },
  {
    name: "npm's npx cache",
    packageDir: join(base, "home", ".npm", "_npx", "4f1c2a", "node_modules", "humanish"),
    cwd: app,
    command: both,
  },
  {
    name: "npm's global root",
    packageDir: join(base, "global", "lib", "node_modules", "humanish"),
    cwd: app,
    env: { npm_config_prefix: join(base, "global") },
    command: "`npm i -g @e2b/desktop`",
  },
  {
    name: "another project",
    packageDir: join(base, "tools", "node_modules", "humanish"),
    cwd: app,
    command: both,
  },
  {
    // A global prefix set only in .npmrc, run from inside it: nothing declares what its
    // node_modules holds, and `npm i` there would prune every global tool.
    name: "a global prefix npm is not configured for, from inside it",
    packageDir: join(base, "opt", "lib", "node_modules", "humanish"),
    cwd: join(base, "opt", "lib"),
    command: `In your project's directory, run ${both}`,
  },
  {
    // npm installs into the nearest directory above that holds package.json or node_modules.
    name: "a directory below that prefix with neither",
    packageDir: join(base, "opt", "lib", "node_modules", "humanish"),
    cwd: join(base, "opt", "lib", "studies"),
    command: `In your project's directory, run ${both}`,
  },
  {
    name: "a global prefix set in the user's .npmrc",
    packageDir: join(base, "npmrc-global", "lib", "node_modules", "humanish"),
    cwd: app,
    command: "`npm i -g @e2b/desktop`",
  },
];

try {
  await preparePackage();
  const declaring = { private: true, devDependencies: { humanish: manifest.version } };
  const manifests = [
    [app, declaring],
    [join(app, "packages", "site"), { private: true }],
    [join(base, "tools"), declaring],
    [mono, { private: true }],
    [join(mono, "packages", "web"), declaring],
  ];
  await mkdir(join(base, "opt", "lib", "studies"), { recursive: true });
  await mkdir(join(base, "home"), { recursive: true });
  await writeFile(join(base, "home", ".npmrc"), "prefix=~/../npmrc-global\n");
  for (const [directory, content] of manifests) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), `${JSON.stringify(content)}\n`);
  }
  await mkdir(join(app, ".humanish", "runs", "proof-run"), { recursive: true });
  // A receipt reclaim loads the SDK for; the key is built here so this file holds no id at it.
  await writeFile(
    join(app, ".humanish", "runs", "proof-run", "sandbox-receipts.ndjson"),
    `${JSON.stringify({ at: "t", laneId: "lane-01", provider: "e2b", ["sandbox" + "Id"]: "fake-proof" })}\n`,
  );
  for (const { name, packageDir, cwd, env = {}, command } of cases) {
    await moveTo(packageDir);
    const messages = peerMessages(cwd, env);
    assert.ok(messages.doctor.includes(command), `${name}: doctor said ${messages.doctor}`);
    // Only this project or npm's own global root gets a command that installs into it.
    if (command.includes(both))
      assert.doesNotMatch(messages.doctor, /`npm i -D (?:--prefix [./]+ )?@e2b/);
    assert.ok(messages.reclaim.includes(command), `${name}: reclaim said ${messages.reclaim}`);
    process.stdout.write(`peer install proof: ${name}: ${command}\n`);
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
