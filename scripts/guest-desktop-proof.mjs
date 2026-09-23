// Development conformance only: actual headed Chromium in a disposable image container.
// Requires the recipe-built image, Docker, and built JS. No VM/model/host-network calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const image = process.env.HUMANISH_GUEST_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'HUMANISH_GUEST_IMAGE must be the local recipe-built image ID, not a moving tag.');
const proofRoot = join(root, '.humanish/guest-desktop-proof');
await mkdir(proofRoot, { recursive: true });
const directory = join(proofRoot, new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
await mkdir(directory, { mode: 0o700 });
const payload = join(directory, 'payload');
await mkdir(join(payload, 'dist'), { recursive: true });
await mkdir(join(payload, 'node_modules'), { recursive: true });
await mkdir(join(payload, 'output'), { recursive: true, mode: 0o777 });
await chmod(join(payload, 'output'), 0o777); // Only inside the disposable container after docker cp.
await cp(join(root, 'scripts/guest-desktop-proof-child.mjs'), join(payload, 'proof.mjs'));
await writeFile(join(payload, 'package.json'), '{"type":"module"}');
const driverModules = ['guest-desktop-executor', 'guest-desktop-native', 'guest-browser-tools', 'guest-chromium-text', 'browser-control-protocol', 'cua-executor-error', 'frame-signature'];
for (const name of driverModules) {
  await cp(join(root, 'dist', name + '.js'), join(payload, 'dist', name + '.js'));
}
for (const name of ['playwright-core', 'pngjs', 'zod']) await cp(await realpath(join(root, 'node_modules', name)), join(payload, 'node_modules', name), { recursive: true });
// Upstream Playwright's Docker profile permits the user namespaces needed by the
// Chromium sandbox. No privileged container, host mounts or host networking.
const profileUrl = 'https://raw.githubusercontent.com/microsoft/playwright/v1.60.0/utils/docker/seccomp_profile.json';
const profileHash = 'cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849';
const response = await fetch(profileUrl, { signal: AbortSignal.timeout(15_000) });
assert.equal(response.ok, true);
const chunks = []; let received = 0;
for await (const chunk of response.body) {
  received += chunk.length; assert.ok(received <= 65_536, 'Profile download exceeds its bound'); chunks.push(Buffer.from(chunk));
}
const profile = Buffer.concat(chunks);
assert.equal(createHash('sha256').update(profile).digest('hex'), profileHash);
const profilePath = join(directory, 'seccomp.json'); await writeFile(profilePath, profile);
async function hashes(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (path === 'output') continue;
    if (entry.isDirectory()) Object.assign(result, await hashes(directory, path));
    else if (entry.isFile()) result[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    else throw new Error('Unexpected nonregular proof payload');
  }
  return result;
}
const sourceHashes = {};
for (const name of [...driverModules.map(name => 'src/' + name + '.ts'), 'scripts/guest-desktop-proof.mjs', 'scripts/guest-desktop-proof-child.mjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json']) {
  sourceHashes[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
}
const payloadHashes = await hashes(payload);
await writeFile(join(directory, 'payload-sha256.json'), JSON.stringify(payloadHashes, null, 2));
const expectedCases = [
  'native address bar navigation', 'Unicode exact readback', 'rapid consecutive text stays ordered',
  'stalled renderer Unicode readback', 'large Unicode transfer and literal multiline text',
  'cancel after actual content preparation makes no input',
  'isolated focus probe resists page prototype replacement', 'address bar rejects Unicode and controls without typing',
  'additional tab is rejected without mutating either page', 'iframe text is explicitly unsupported',
  'navigation invalidates a prepared insertion', 'native click uses full-frame coordinates',
  'double click and multi-point drag', 'native wheel scroll', 'reject bad key without input',
  'modal dialog rejects text without accepting or filling it', 'revocation during drag sends no release'
];
let container;
let failure;
const receipt = { image, profileUrl, profileHash, sourceHashes, scope: 'native headed guest driver, not VM/study qualification', network: 'none', privileged: false };
try {
  receipt.acquisition = 'attempted';
  const created = await exec('docker', ['create', '--network', 'none', '--init', '--shm-size', '1g', '--security-opt', `seccomp=${profilePath}`, image, 'node', '/opt/proof/proof.mjs'], { timeout: 30_000 });
  const candidate = created.stdout.trim(); assert.match(candidate, /^[a-f0-9]{64}$/);
  container = candidate; receipt.acquisition = 'owned';
  await exec('docker', ['cp', payload + '/.', `${container}:/opt/proof`], { timeout: 30_000 });
  try {
    const run = await exec('docker', ['start', '--attach', container], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    await writeFile(join(directory, 'container.log'), run.stdout + run.stderr);
  } catch (error) {
    failure = error;
    await writeFile(join(directory, 'container.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  }
  const inspected = JSON.parse((await exec('docker', ['inspect', container], { timeout: 10_000 })).stdout)[0];
  receipt.exitCode = inspected.State.ExitCode;
  receipt.exited = inspected.State.Status === 'exited';
  await mkdir(join(directory, 'output'));
  await exec('docker', ['cp', `${container}:/opt/proof/output/.`, join(directory, 'output')], { timeout: 30_000 });
  const result = JSON.parse(await readFile(join(directory, 'output/result.json'), 'utf8'));
  receipt.result = result;
  assert.equal(receipt.exited, true); assert.equal(receipt.exitCode, 0);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.cases.map(c => c.name), expectedCases);
  assert.ok(result.cases.every(c => c.passed));
  assert.deepEqual(result.payloadHashes, payloadHashes);
  assert.equal(result.cleanup.errors.length, 0);
  if (failure) throw failure;
} catch (error) { failure = error; receipt.failure = String(error).slice(0, 500); }
finally {
  if (container) {
    try {
      await exec('docker', ['rm', '--force', container], { timeout: 30_000 });
      const remaining = (await exec('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'], { timeout: 10_000 })).stdout.trim().split('\n');
      receipt.containerAbsent = !remaining.includes(container);
      assert.equal(receipt.containerAbsent, true);
    } catch (error) { failure ??= error; receipt.cleanupError = String(error).slice(0, 500); receipt.containerAbsent = false; }
  }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  try { await rm(payload, { recursive: true, force: true }); } catch (error) { failure ??= error; receipt.payloadCleanupError = String(error).slice(0, 500); await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2)); }
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const images = ['address-bar', 'unicode', 'saved', 'scroll'];
const capturedFiles = new Set(await readdir(join(directory, 'output')).catch(() => []));
const rows = expectedCases.map(name => {
  const item = receipt.result?.cases.find(c => c.name === name);
  return `<tr><td>${escape(name)}</td><td class="${item?.passed ? 'pass' : 'fail'}">${item ? (item.passed ? 'Passed' : 'Failed') : 'Not reached'}</td><td>${escape(item?.error ?? '')}</td></tr>`;
}).join('');
await writeFile(join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Headed guest driver proof</title>
<style>body{font:16px/1.5 system-ui;color:#1a2533;background:#f4f6f8;margin:0}main{max-width:1080px;margin:auto;padding:40px 24px}h1{font-size:36px;line-height:1.1}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;background:white}td,th{text-align:left;padding:10px;border-bottom:1px solid #d9e0e8}.pass{color:#116143}.fail{color:#aa2437}figure{margin:24px 0}img{max-width:100%;border:1px solid #c3ccd9;border-radius:8px}a{color:#264bcc}</style>
<main><p>DEVELOPMENT CONFORMANCE · AMD64 · CHROMIUM</p><h1>Headed input: ${failure ? 'qualification failed' : 'verified in this image'}</h1>
<p>Actual sandboxed Chromium with a synthetic NoteShelf app. This proves the bounded input driver, not a Firecracker VM, model participant, managed installation or completed study.</p>
<p>Image <code>${escape(image)}</code><br>Container removed: <b>${escape(receipt.containerAbsent ?? 'unconfirmed')}</b></p>
<p><a href="receipt.json">Full receipt and source hashes</a> · <a href="container.log">Execution log</a></p>
<table><thead><tr><th>Required case</th><th>Result</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Full desktop captures</h2>${images.map(name => capturedFiles.has(name + '.png') ? `<figure><a href="output/${name}.png"><img alt="${name} capture; unavailable if the case did not reach capture" src="output/${name}.png"></a><figcaption>${name}</figcaption></figure>` : `<p>${name}: not captured</p>`).join('')}
<h2>Outside this proof</h2><p>ARM64, VM boot, network policy, independent lifecycle enforcement, model actors, multi-window/iframe text, native prompts, media and the installed Linux/Mac study journey remain unqualified.</p></main>`);
console.log(JSON.stringify({ directory, passed: !failure, cases: receipt.result?.cases, containerAbsent: receipt.containerAbsent }));
if (failure) process.exitCode = 1;
