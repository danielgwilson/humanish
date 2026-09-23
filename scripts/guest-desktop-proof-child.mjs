// Scoped native-driver proof inside a disposable, networkless guest-image container.
// App assertions are independent of the bounded native/CDP input ports.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createGuestDesktopExecutor } from './dist/guest-desktop-executor.js';
import { createGuestDesktopNativeTools } from './dist/guest-desktop-native.js';
import { createGuestBrowserTools } from './dist/guest-browser-tools.js';
import { createGuestChromiumText } from './dist/guest-chromium-text.js';

async function payloadHashes(directory, prefix = '') {
  const hashes = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (path === 'output') continue;
    if (entry.isDirectory()) Object.assign(hashes, await payloadHashes(directory, path));
    else if (entry.isFile()) hashes[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    else throw new Error('Unexpected nonregular proof payload');
  }
  return hashes;
}
const output = '/opt/proof/output';
await mkdir(output, { recursive: true });
const owned = await mkdtemp('/tmp/humanish-driver-proof-');
const authorityFile = join(owned, 'Xauthority');
await writeFile(authorityFile, '', { mode: 0o600 });
execFileSync('/usr/bin/xauth', ['-f', authorityFile, 'source', '-'], { input: `add :0 . ${randomBytes(16).toString('hex')}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
const env = { ...process.env, DISPLAY: ':0', XAUTHORITY: authorityFile, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
let xvfb, wm, context, server, proofPage, content;
const children = [];
const result = { payloadHashes: await payloadHashes('/opt/proof'), cases: [], cleanup: {}, scope: 'headed native guest driver; not a VM or study proof' };
function child(binary, args) {
  const process = spawn(binary, args, { env, stdio: 'ignore' });
  const closed = new Promise(resolve => process.once('close', (code, signal) => resolve({ code, signal })));
  const record = { process, closed, exited: false }; process.once('exit', () => record.exited = true); children.push(record); return record;
}
async function bounded(work, ms, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function test(name, action) {
  try { const detail = await action(); result.cases.push({ name, passed: true, ...detail }); }
  catch (error) { result.cases.push({ name, passed: false, error: String(error).slice(0, 500), url: proofPage?.url(), pages: context?.pages().map(p => p.url()), value: await proofPage?.locator('#note').inputValue({timeout:500}).catch(() => 'missing') }); }
  console.log(JSON.stringify({ event: 'case', ...result.cases.at(-1) }));
}
try {
  xvfb = child('/usr/bin/Xvfb', [':0', '-screen', '0', '960x720x24', '-nolisten', 'tcp', '-auth', authorityFile]);
  for (let i = 0; i < 100; i++) {
    try { execFileSync('/usr/bin/xdpyinfo', [], { env, stdio: 'ignore' }); break; }
    catch { if (i === 99) throw new Error('X server was not ready'); await delay(50); }
  }
  wm = child('/usr/bin/openbox', ['--config-file', '/etc/xdg/openbox/rc.xml']);
  const html = `<!doctype html><meta charset="utf-8"><title>NoteShelf native input proof</title>
<style>body{font:20px system-ui;margin:28px;background:#f7f8fb}textarea{width:780px;height:100px;font:20px monospace}button{font-size:20px;padding:10px}#pad{width:400px;height:130px;background:#dbeafe;margin-top:24px}#spacer{height:1600px}</style>
<h1>NoteShelf</h1><label for="note">Draft</label><br><textarea id="note" autofocus></textarea><br><button id="save">Save note</button><p id="count">Saved 0</p><div id="pad">Pointer test area</div><div id="spacer"></div><p>End of page</p>
<script>window.proof={saves:0,downs:0,ups:0,moves:0,double:0,savedText:null};save.onclick=()=>{proof.saves++;proof.savedText=note.value;count.textContent='Saved '+proof.saves};pad.onmousedown=()=>proof.downs++;pad.onmouseup=()=>proof.ups++;pad.onmousemove=()=>proof.moves++;pad.ondblclick=()=>proof.double++;</script>`;
  server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/notes`;
  context = await chromium.launchPersistentContext(join(owned, 'browser'), {
    executablePath: '/usr/bin/chromium', headless: false, chromiumSandbox: true, viewport: null, env,
    args: ['--window-size=960,680', '--window-position=0,20', '--disable-background-networking', '--disable-component-update', '--no-first-run']
  });
  const page = context.pages()[0]; proofPage = page; context.setDefaultTimeout(5000);
  const diagnostic = await context.newPage(); await diagnostic.goto('chrome://sandbox');
  result.sandboxReport = await diagnostic.locator('body').innerText();
  for (const label of ['PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox']) assert.match(result.sandboxReport, new RegExp(label + '\\s+Yes'));
  assert.match(result.sandboxReport, /You are adequately sandboxed/);
  await diagnostic.close(); await page.bringToFront();
  const owner = new AbortController();
  let terminalCount = 0;
  const native = createGuestDesktopNativeTools({ display: ':0', temporaryDirectory: owned, xauthority: authorityFile });
  const ownedWindowId = await native.activeWindowId(owner.signal); // Acquired on the fresh owner-launched blank browser.
  content = createGuestChromiumText({ context, page, assertFocusedWindow: async signal => {
    assert.equal(await native.activeWindowId(signal), ownedWindowId, 'Owner browser window lost focus');
  } });
  const tools = createGuestBrowserTools(native, content);
  const executor = createGuestDesktopExecutor({ width: 960, height: 720, tools, authoritySignal: owner.signal, onTerminal: () => { terminalCount++; } });
  const action = a => executor.execute(a);
  const key = (...keys) => action({ kind: 'keypress', keys });
  async function capture(name) { const shot = await executor.observe(); await writeFile(join(output, name + '.png'), shot.screenshot); }
  async function target(selector) {
    const box = await page.locator(selector).boundingBox();
    const dims = await page.evaluate(() => ({ x: screenX, y: screenY, width: outerWidth, height: outerHeight, innerWidth, innerHeight }));
    const border = (dims.width - dims.innerWidth) / 2;
    return { x: Math.round(dims.x + border + box.x + box.width / 2), y: Math.round(dims.y + dims.height - dims.innerHeight - border + box.y + box.height / 2) };
  }
  await test('native address bar navigation', async () => {
    await key('CTRL', 'l'); await action({ kind: 'type', text: url }); await key('ENTER');
    await page.waitForURL(url); await page.locator('#note').waitFor(); await page.waitForFunction(() => document.activeElement?.id === 'note');
    await capture('address-bar'); return { urlMatched: page.url() === url };
  });
  await test('Unicode exact readback', async () => {
    const text = 'Cafe\u0301 café 日本語 中文 한글 🙂 👩‍💻';
    await key('CTRL', 'a'); await action({ kind: 'type', text });
    await page.waitForFunction(text => document.querySelector('#note').value === text, text, { timeout: 4000 });
    await capture('unicode'); return { expected: text, actual: await page.locator('#note').inputValue() };
  });
  await test('rapid consecutive text stays ordered', async () => {
    await key('CTRL', 'a');
    for (const text of ['A🙂', 'B日本', 'Ce\u0301', 'D한글']) await action({ kind: 'type', text });
    const expected = 'A🙂B日本Ce\u0301D한글';
    await page.waitForFunction(text => document.querySelector('#note').value === text, expected, { timeout: 4000 });
    return { expected, actual: await page.locator('#note').inputValue() };
  });
  await test('stalled renderer Unicode readback', async () => {
    await key('CTRL', 'a');
    let observedStart, observedEnd, receivedStart, receivedEnd, prepareAt, goAt, deliveredAt, beginStall;
    const started = new Promise(resolve => { beginStall = resolve; });
    const listener = event => {
      if (event.text().startsWith('fixture-stall-start:')) { observedStart = Number(event.text().split(':')[1]); receivedStart = Date.now(); beginStall(); }
      if (event.text().startsWith('fixture-stall-end:')) { observedEnd = Number(event.text().split(':')[1]); receivedEnd = Date.now(); }
    };
    page.on('console', listener);
    try {
      await page.evaluate(() => setTimeout(() => { console.log('fixture-stall-start:' + Date.now()); const until = performance.now() + 1200; while (performance.now() < until) {} console.log('fixture-stall-end:' + Date.now()); }, 0));
      await bounded(started, 2000, 'renderer stall start');
      assert.equal(observedEnd, undefined, 'renderer already resumed before text preparation');
      const text = '日本🙂e\u0301한글👩‍💻';
      const timed = createGuestDesktopExecutor({ width: 960, height: 720, authoritySignal: owner.signal, onTerminal: () => {}, tools: {
        ...tools, prepareText: async (value, signal) => { prepareAt = Date.now(); const prepared = await tools.prepareText(value, signal); return {
          paste: async () => { goAt = Date.now(); await prepared.paste(); deliveredAt = Date.now(); }, close: prepared.close
        }; }
      } });
      await timed.execute({ kind: 'type', text });
      await page.waitForFunction(text => document.querySelector('#note').value === text, text, { timeout: 4000 });
      assert.ok(observedStart <= prepareAt && prepareAt < observedEnd && observedEnd <= goAt && goAt <= deliveredAt, 'focus probe must wait for the observed renderer stall before insertion');
      return { expected: text, actual: await page.locator('#note').inputValue(), observedStart, prepareAt, goAt, observedEnd, deliveredAt, receivedStart, receivedEnd };
    } finally { page.off('console', listener); }
  });
  await test('large Unicode transfer and literal multiline text', async () => {
    const text = ('日本🙂e\u0301' + String.fromCharCode(10)).repeat(500) + String.fromCharCode(9) + 'literal --window; $(example)';
    await key('CTRL', 'a'); await action({ kind: 'type', text });
    await page.waitForFunction(text => document.querySelector('#note').value === text, text, { timeout: 4000 });
    return { bytes: Buffer.byteLength(text), exact: (await page.locator('#note').inputValue()) === text };
  });
  await test('cancel after actual content preparation makes no input', async () => {
    const before = await page.locator('#note').inputValue();
    const cancel = new AbortController(); let pasted = false;
    const guarded = createGuestDesktopExecutor({ width: 960, height: 720, authoritySignal: cancel.signal, onTerminal: () => {}, tools: {
      ...tools, prepareText: async (text, signal) => { const prepared = await tools.prepareText(text, signal); cancel.abort(); return { paste: async () => { pasted = true; await prepared.paste(); }, close: prepared.close }; }
    } });
    await assert.rejects(guarded.execute({ kind: 'type', text: 'must never appear' }), { disposition: 'not_dispatched' });
    assert.equal(pasted, false); assert.equal(await page.locator('#note').inputValue(), before);
    return { noPaste: !pasted, unchanged: true };
  });
  await test('isolated focus probe resists page prototype replacement', async () => {
    await page.evaluate(() => { window.savedHasFocus = Document.prototype.hasFocus; Document.prototype.hasFocus = () => false; });
    try {
      await key('CTRL', 'a'); await action({ kind: 'type', text: 'Isolated 日本🙂' });
      assert.equal(await page.locator('#note').inputValue(), 'Isolated 日本🙂');
    } finally { await page.evaluate(() => { Document.prototype.hasFocus = window.savedHasFocus; delete window.savedHasFocus; }); }
  });
  await test('address bar rejects Unicode and controls without typing', async () => {
    const before = await page.locator('#note').inputValue(); const beforeUrl = page.url();
    for (const text of ['日本', 'line\nfeed', 'tab\ttext']) {
      await key('CTRL', 'l');
      await assert.rejects(action({ kind: 'type', text }), { disposition: 'not_dispatched' });
      await key('ESC');
    }
    assert.equal(page.url(), beforeUrl); assert.equal(await page.locator('#note').inputValue(), before);
    await action({ kind: 'click', ...await target('#note') });
  });
  await test('additional tab is rejected without mutating either page', async () => {
    const before = await page.locator('#note').inputValue();
    const other = await context.newPage(); await other.goto(url); await other.locator('#note').focus();
    try {
      await assert.rejects(action({ kind: 'type', text: 'wrong target' }), { disposition: 'not_dispatched' });
      assert.equal(await page.locator('#note').inputValue(), before); assert.equal(await other.locator('#note').inputValue(), '');
    } finally { await other.close(); }
    await action({ kind: 'click', ...await target('#note') });
  });
  await test('iframe text is explicitly unsupported', async () => {
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id='child'; frame.srcdoc='<textarea id="inside"></textarea>'; document.body.prepend(frame); });
    const field = page.frameLocator('#child').locator('#inside'); await field.focus();
    try {
      await assert.rejects(action({ kind: 'type', text: 'wrong frame' }), { disposition: 'not_dispatched' });
      assert.equal(await field.inputValue(), '');
    } finally { await page.locator('#child').evaluate(element => element.remove()); }
    await action({ kind: 'click', ...await target('#note') });
  });
  await test('navigation invalidates a prepared insertion', async () => {
    const prepared = await tools.prepareText('stale text', owner.signal);
    try { await page.reload(); await page.locator('#note').focus(); await assert.rejects(prepared.paste(), { disposition: 'not_dispatched' }); }
    finally { await prepared.close(); }
    assert.equal(await page.locator('#note').inputValue(), '');
    await action({ kind: 'type', text: 'Saved exact: 日本語 🙂 e\u0301' });
  });
  await test('native click uses full-frame coordinates', async () => {
    const point = await target('#save'); await action({ kind: 'click', ...point });
    await page.waitForFunction(() => window.proof.saves === 1);
    assert.equal(await page.evaluate(() => proof.savedText), await page.locator('#note').inputValue());
    await capture('saved'); return { saves: await page.evaluate(() => proof.saves), savedBytes: Buffer.byteLength(await page.locator('#note').inputValue()), point };
  });
  await test('double click and multi-point drag', async () => {
    const point = await target('#pad'); await action({ kind: 'double_click', ...point });
    await action({ kind: 'drag', path: [point, { x: point.x + 30, y: point.y + 10 }, { x: point.x + 60, y: point.y + 10 }] });
    await page.waitForFunction(() => proof.double === 1 && proof.ups === 3);
    return await page.evaluate(() => ({ ...proof }));
  });
  await test('native wheel scroll', async () => {
    await action({ kind: 'scroll', x: 750, y: 550, dx: 0, dy: 720 });
    await page.waitForFunction(() => scrollY > 0); await capture('scroll');
    await key('CTRL', 'HOME'); await page.waitForFunction(() => scrollY === 0);
  });
  await test('reject bad key without input', async () => {
    await assert.rejects(action({ kind: 'keypress', keys: ['a key Return'] }), { disposition: 'not_dispatched' });
  });
  await test('modal dialog rejects text without accepting or filling it', async () => {
    const before = await page.locator('#note').inputValue();
    let captured; const dialogSeen = new Promise(resolve => page.once('dialog', dialog => { captured = dialog; resolve(); }));
    const prompt = page.evaluate(() => { window.promptResult = prompt('Synthetic modal', 'unchanged'); });
    await dialogSeen;
    await assert.rejects(action({ kind: 'type', text: 'must not enter modal' }), { disposition: 'not_dispatched' });
    assert.equal(captured.defaultValue(), 'unchanged'); await captured.dismiss(); await prompt;
    assert.equal(await page.evaluate(() => window.promptResult), null); assert.equal(await page.locator('#note').inputValue(), before);
  });
  await test('revocation during drag sends no release', async () => {
    const point = await target('#pad'); const before = await page.evaluate(() => ({ ...proof }));
    const revoke = new AbortController(); const sent = [];
    const guarded = createGuestDesktopExecutor({ width: 960, height: 720, authoritySignal: revoke.signal, onTerminal: () => {}, tools: {
      ...tools, input: async (args, signal) => { sent.push(args[0]); await tools.input(args, signal); if (args[0] === 'mousedown') revoke.abort(); }
    } });
    await assert.rejects(guarded.execute({ kind: 'drag', path: [point, { x: point.x + 30, y: point.y }] }), { disposition: 'outcome_uncertain' });
    await delay(100); const after = await page.evaluate(() => ({ ...proof }));
    assert.equal(after.ups, before.ups); assert.deepEqual(sent, ['mousemove', 'mousedown']);
    return { sent, before, after };
  });
  result.browser = context.browser()?.version(); result.chromiumSandbox = true; result.terminalCount = terminalCount;
} catch (error) { result.error = String(error).slice(-1200); await writeFile(join(output, 'failure.txt'), String(error)); }
finally {
  const cleanupErrors = [];
  async function reclaim(name, work) {
    try { await work(); result.cleanup[name] = true; }
    catch (error) { result.cleanup[name] = false; cleanupErrors.push({ name, error: String(error).slice(0, 200) }); }
  }
  if (content) await reclaim('textPortClosed', () => bounded(content.close(), 2000, 'text port close'));
  if (context) await reclaim('browserClosed', () => bounded(context.close(), 4000, 'browser close'));
  if (server) await reclaim('serverClosed', () => bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000, 'server close'));
  for (const [index, record] of children.reverse().entries()) {
    await reclaim('child' + index + 'Exited', async () => {
      if (!record.exited) record.process.kill('SIGTERM');
      try { await bounded(record.closed, 2000, 'child exit'); }
      catch { if (!record.exited) record.process.kill('SIGKILL'); await bounded(record.closed, 2000, 'killed child exit'); }
    });
  }
  if (!cleanupErrors.length) await reclaim('privateDirectoryRemoved', () => rm(owned, { recursive: true, force: true }));
  else result.cleanup.privateDirectoryRemoved = false;
  result.cleanup.errors = cleanupErrors;
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = result.error || result.cases.some(c => !c.passed) || cleanupErrors.length ? 1 : 0;
  // The outer acquired container owns any unresolved descendants, and must fail
  // this run while reclaiming them. Do not let a wedged child hide the receipt.
  if (cleanupErrors.length) process.exit(1);
}
