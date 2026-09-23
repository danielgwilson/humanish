// Build-time, unprivileged fixed guest payload. This is not a privileged importer.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(root, prefix = '') {
  const files = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(root, path));
    else if (entry.isFile()) files[path] = sha(await readFile(join(root, path)));
    else throw new Error('Nonregular package source');
  }
  return files;
}
async function closure() {
  const seen = new Set(), packages = new Set();
  async function visit(name) {
    if (seen.has(name)) return;
    if (!/^[a-z0-9-]+\.js$/.test(name)) throw new Error('Unqualified runtime import');
    seen.add(name);
    const source = ts.createSourceFile(name, await readFile(join(repository, 'dist', name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const references = [];
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) references.push(node.moduleSpecifier);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1) throw new Error('Dynamic runtime import');
        references.push(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    for (const node of references) {
      if (!ts.isStringLiteral(node)) throw new Error('Dynamic runtime import');
      if (node.text.startsWith('node:')) continue;
      if (node.text.startsWith('./')) await visit(node.text.slice(2));
      else {
        if (!['playwright-core','pngjs','zod'].includes(node.text)) throw new Error('Unqualified guest dependency');
        packages.add(node.text);
      }
    }
  }
  await visit('guest-runtime-main.js');
  return { modules: [...seen].sort(), packages: [...packages].sort() };
}
export async function packageGuestRuntime(destination) {
  const output = resolve(destination), root = join(output, 'root');
  await mkdir(output, { mode: 0o700 }); // Refuse reusing a stale output.
  await mkdir(root, { mode: 0o755 });
  const selected = await closure();
  const sourceFiles = {}, dependencyFiles = {};
  const fixed = join(repository, 'runtime/browser-guest/control/root');
  const fixedHashes = await inventory(fixed);
  for (const [path, hash] of Object.entries(fixedHashes)) sourceFiles['runtime/browser-guest/control/root/' + path] = hash;
  const linksPath = 'runtime/browser-guest/control/links.json';
  const links = JSON.parse(await readFile(join(repository, linksPath), 'utf8'));
  for (const file of [...selected.modules.map(name => 'src/' + name.replace(/\.js$/, '.ts')), linksPath, 'scripts/guest-runtime-package.mjs']) {
    sourceFiles[file] = sha(await readFile(join(repository, file)));
  }
  // Bind the bytes actually executed, including stale/modified compiler output.
  // The generated revision itself is excluded to avoid a self-hash cycle.
  for (const name of selected.modules.filter(name => name !== 'guest-runtime-revision.js')) {
    sourceFiles['dist/' + name] = sha(await readFile(join(repository, 'dist', name)));
  }
  for (const name of selected.packages) {
    const packageRoot = await realpath(join(repository, 'node_modules', name));
    const hashes = await inventory(packageRoot);
    for (const [path, hash] of Object.entries(hashes)) dependencyFiles[name + '/' + path] = hash;
  }
  const buildInputs = {
    architecture: 'amd64', nodeVersion: process.version, typescriptVersion: require('typescript/package.json').version,
    packageLockSha256: sha(await readFile(join(repository, 'pnpm-lock.yaml'))),
    tsconfigSha256: sha(await readFile(join(repository, 'tsconfig.json'))),
    tsconfigBuildSha256: sha(await readFile(join(repository, 'tsconfig.build.json'))), bootstrapVersion: 1, browserControlVersion: 1
  };
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only native Linux amd64 packaging is qualified');
  const inputs = { sourceFiles, dependencyFiles, buildInputs };
  const runtimeRevision = 'guest-api1-' + sha(canonical(inputs));
  const control = join(root, 'opt/humanish/control');
  await cp(fixed, root, { recursive: true, dereference: false });
  for (const name of selected.modules) {
    const target = join(control, name);
    if (name === 'guest-runtime-revision.js') await writeFile(target, `export const GUEST_RUNTIME_REVISION = ${JSON.stringify(runtimeRevision)};\n`);
    else await cp(join(repository, 'dist', name), target);
  }
  await writeFile(join(control, 'package.json'), '{"type":"module"}\n');
  for (const name of selected.packages) {
    await mkdir(join(control, 'node_modules'), { recursive: true });
    await cp(await realpath(join(repository, 'node_modules', name)), join(control, 'node_modules', name), { recursive: true });
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await symlink(target, join(root, path));
  }
  const files = {};
  async function finalize(directory, prefix = '') {
    await chmod(directory, 0o755);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const path = prefix ? prefix + '/' + entry.name : entry.name, full = join(directory, entry.name);
      if (entry.isDirectory()) await finalize(full, path);
      else if (entry.isSymbolicLink()) {
        if (!Object.hasOwn(links, path)) throw new Error('Unqualified payload link');
        files[path] = { type: 'symlink', target: links[path], mode: 0o777, uid: 0, gid: 0 };
      } else if (entry.isFile()) {
        const stat = await lstat(full);
        const mode = path.startsWith('opt/') ? (stat.mode & 0o111 ? 0o555 : 0o444) : path === 'etc/machine-id' ? 0o444 : 0o644;
        await chmod(full, mode);
        files[path] = { type: 'file', sha256: sha(await readFile(full)), mode, uid: 0, gid: 0 };
      } else throw new Error('Nonregular payload');
    }
  }
  await finalize(root);
  const expectedLeaves = new Set([...Object.keys(fixedHashes), ...Object.keys(links),
    ...selected.modules.map(name => 'opt/humanish/control/' + name), 'opt/humanish/control/package.json',
    ...Object.keys(dependencyFiles).map(path => 'opt/humanish/control/node_modules/' + path)]);
  if (Object.keys(files).length !== expectedLeaves.size || Object.keys(files).some(path => !expectedLeaves.has(path))) {
    throw new Error('Payload leaf set changed during snapshot');
  }
  for (const [path, expected] of Object.entries(sourceFiles)) {
    if (sha(await readFile(join(repository, path))) !== expected) throw new Error('Package source changed during snapshot');
    const payloadPath = path.startsWith('runtime/browser-guest/control/root/') ? path.slice('runtime/browser-guest/control/root/'.length)
      : path.startsWith('dist/') ? 'opt/humanish/control/' + path.slice(5) : undefined;
    if (payloadPath && files[payloadPath]?.sha256 !== expected) throw new Error('Copied source differs from captured input');
  }
  for (const [path, expected] of Object.entries(dependencyFiles)) {
    if (files['opt/humanish/control/node_modules/' + path]?.sha256 !== expected) throw new Error('Dependency changed during snapshot');
  }
  for (const [path, expected] of [['pnpm-lock.yaml', buildInputs.packageLockSha256], ['tsconfig.json', buildInputs.tsconfigSha256], ['tsconfig.build.json', buildInputs.tsconfigBuildSha256]]) {
    if (sha(await readFile(join(repository, path))) !== expected) throw new Error('Build input changed during snapshot');
  }
  const manifest = { schema: 'humanish.guest-runtime-package.v1', runtimeRevision, inputs, files };
  await writeFile(join(output, 'manifest.json'), canonical(manifest) + '\n', { mode: 0o600 });
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/guest-runtime-package.mjs NEW_OUTPUT_DIRECTORY');
  const manifest = await packageGuestRuntime(process.argv[2]);
  console.log(JSON.stringify({ schema: manifest.schema, runtimeRevision: manifest.runtimeRevision, files: Object.keys(manifest.files).length }));
}
