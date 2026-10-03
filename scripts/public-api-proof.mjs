#!/usr/bin/env node
// Checks the package as npm publishes it. Packs the built repo and extracts the tarball into a
// temporary project with the declared dependencies symlinked from the repo: a package-content
// check, not a clean install. Then it compares the export names and kinds that `import "humanish"`
// exposes (runtime values and names declared in dist/index.d.ts) with
// tests/golden/public-api.json. This is an export-name guard: a change inside a named type is
// caught only where the probe, an example or a consumer file in scripts/api-consumers/ uses it.
// Last, it typechecks a probe importing every name, the examples and the consumer files, and runs
// each example from the packed copy. It also compares the packed file paths outside `dist/` with
// `tests/golden/package-files.json`, so a doc or folder joins or leaves the package only in a
// reviewed diff. `dist/` is left out because it follows `src/`. Run after `pnpm build`.
// `--update` rewrites both goldens.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = join(root, "tests/golden/public-api.json");
const filesGoldenPath = join(root, "tests/golden/package-files.json");
const update = process.argv.includes("--update");
const timings = {};

async function timed(label, fn) {
  const started = Date.now();
  const result = await fn();
  timings[label] = Date.now() - started;
  return result;
}

/** Pack as `npm publish` would, then install the tarball and the declared dependencies. */
async function install(work) {
  const packed = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", work],
    { cwd: root, encoding: "utf8" },
  );
  const [pack] = JSON.parse(packed);
  const tarball = join(work, pack.filename);
  const app = join(work, "app");
  const modules = join(app, "node_modules");
  await mkdir(modules, { recursive: true });
  await writeFile(join(app, "package.json"), '{ "private": true, "type": "module" }\n');
  execFileSync("tar", ["-xzf", tarball, "-C", modules]);
  await rename(join(modules, "package"), join(modules, "humanish"));
  // Only declared dependencies are linked, so an import the package does not declare cannot
  // resolve. Optional peers stay absent, as after a plain `npm install humanish`. Node's types are
  // what a TypeScript consumer adds for the typecheck.
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const name of [...Object.keys(pkg.dependencies ?? {}), "@types/node"]) {
    const from = join(root, "node_modules", name);
    if (!existsSync(from)) throw new Error(`${name} is not installed in the repo`);
    const to = join(modules, name);
    await mkdir(dirname(to), { recursive: true });
    await symlink(await realpath(from), to, "dir");
  }
  const files = pack.files
    .map((file) => file.path)
    .filter((path) => !path.startsWith("dist/"))
    .sort();
  return { app, files };
}

/** Copy each shipped example out of the installed package, as a user would run it. */
async function copyExamples(app) {
  const shipped = join(app, "node_modules/humanish/examples");
  if (!existsSync(shipped))
    throw new Error("the package ships no examples/; check package.json files");
  const names = (await readdir(shipped, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names)
    await cp(join(shipped, name), join(app, "examples", name), { recursive: true });
  return names;
}

function runtimeNames(app, env) {
  const script =
    'const api = await import("humanish"); process.stdout.write(JSON.stringify(Object.keys(api)));';
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: app,
    env,
    encoding: "utf8",
  });
  return JSON.parse(out).sort();
}

/** Names the installed package's entry declaration exports, split into values and types. */
async function declaredNames(app) {
  const file = join(app, "node_modules/humanish/dist/index.d.ts");
  const { program, errors } = parseSync(file, await readFile(file, "utf8"));
  if (errors.length > 0) throw new Error(`dist/index.d.ts did not parse: ${errors[0]?.message}`);
  const values = [];
  const types = [];
  for (const node of program.body) {
    if (node.type === "ExportAllDeclaration") throw new Error("export * is not supported here");
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of node.specifiers) {
      const typeOnly = node.exportKind === "type" || specifier.exportKind === "type";
      (typeOnly ? types : values).push(specifier.exported.name);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

/**
 * Typecheck a probe that imports every declared name, and the examples, against the installed
 * package, with the options the participant example's readme documents.
 */
async function typecheck(app, names) {
  // Consumer files use public fields one by one; they are typechecked, never run.
  await cp(join(root, "scripts/api-consumers"), join(app, "consumers"), { recursive: true });
  await writeFile(
    join(app, "probe.ts"),
    `import type {\n${names.map((name) => `  ${name},`).join("\n")}\n} from "humanish";\n`,
  );
  const tsconfig = {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
      types: ["node"],
    },
    include: ["probe.ts", "examples/**/*.mjs", "consumers/**/*.ts"],
  };
  await writeFile(join(app, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  try {
    execFileSync(
      join(root, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.json", "--pretty", "false"],
      {
        cwd: app,
        encoding: "utf8",
      },
    );
    return [];
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return output.split("\n").filter((line) => line.length > 0);
  }
}

function difference(label, expected, actual, verb = "exported") {
  const missing = expected.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !expected.includes(name));
  return [
    ...missing.map((name) => `${label}: ${name} is no longer ${verb}`),
    ...added.map((name) => `${label}: ${name} is newly ${verb}`),
  ];
}

function runExamples(app, names, env) {
  for (const name of names) {
    const started = Date.now();
    execFileSync(process.execPath, ["run.mjs"], {
      cwd: join(app, "examples", name),
      env,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    });
    timings[`example ${name}`] = Date.now() - started;
  }
}

const work = await mkdtemp(join(tmpdir(), "humanish-api-proof-"));
// No machine credentials, no telemetry, and example temp projects land inside `work`.
const env = {
  ...process.env,
  TMPDIR: work,
  HUMANISH_STRICT_KEYS: "1",
  HUMANISH_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
};
try {
  const { app, files } = await timed("pack and install", () => install(work));
  const examples = await copyExamples(app);
  const runtime = await timed("runtime exports", () => runtimeNames(app, env));
  const api = await timed("declared exports", () => declaredNames(app));
  const typeErrors = await timed("typecheck", () =>
    typecheck(app, [...api.values, ...api.types].sort()),
  );
  const problems = [
    ...typeErrors,
    ...difference("declared values vs runtime", api.values, runtime),
  ];
  const current = { values: runtime, types: api.types };
  if (update) {
    await writeFile(goldenPath, `${JSON.stringify(current, null, 2)}\n`);
    await writeFile(filesGoldenPath, `${JSON.stringify(files, null, 2)}\n`);
  } else {
    const golden = JSON.parse(await readFile(goldenPath, "utf8"));
    problems.push(...difference("values", golden.values, current.values));
    problems.push(...difference("types", golden.types, current.types));
    const packedGolden = JSON.parse(await readFile(filesGoldenPath, "utf8"));
    problems.push(...difference("packed files outside dist/", packedGolden, files, "packed"));
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.stderr.write(
      "The package differs from tests/golden/public-api.json or tests/golden/package-files.json. If intended, run `pnpm api:proof --update` and review the diff.\n",
    );
    process.exitCode = 1;
  } else {
    runExamples(app, examples, env);
    const summary = Object.entries(timings)
      .map(([label, ms]) => `${label} ${(ms / 1000).toFixed(1)}s`)
      .join(", ");
    process.stdout.write(
      `public API: ${runtime.length} values and ${api.types.length} types match; examples ${examples.join(", ")} passed (${summary})\n`,
    );
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
