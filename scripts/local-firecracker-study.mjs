#!/usr/bin/env node
// Opt-in live integration: uses the operator's Codex account and prepared VM assets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLabConfig } from '../dist/lab-config.js';
import { runLocalFirecrackerStudy } from '../dist/local-firecracker-study.js';
import { verifyRun } from '../dist/run.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/local-firecracker-study.mjs <assets.json>');
const assets = JSON.parse(await readFile(process.argv[2], 'utf8'));
const fixture = await readFile(new URL('../runtime/browser-guest/control/root/opt/humanish/control/neutral.html', import.meta.url), 'utf8');
const html = fixture.replace('</script>', `
save.addEventListener('click', () => fetch('/saved', { method: 'POST', body: JSON.stringify({
  reader: new URLSearchParams(location.search).get('reader'), text: note.value
}) }));</script>`);
const saves = [];
const server = createServer(async (req, res) => {
  if (req.url === '/saved' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
    try { saves.push(JSON.parse(body)); res.end('ok'); }
    catch { res.writeHead(400).end(); }
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
});
const abort = new AbortController();
const cancel = () => abort.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${server.address().port}/`;
  const parsed = parseLabConfig({ schema: 'humanish.lab.v2', id: 'local-note-study', title: 'Two isolated note readers',
    subject: { source: 'app-url', appUrl }, actors: [{ type: 'local-agent', localAgent: 'codex', model: 'gpt-6-astra',
      mission: 'Save your assigned note, then describe whether the confirmation is clear.', lanes: [
        { id: 'reader-a', target: appUrl + '?reader=a', instruction: 'Your note is exactly: Bring a notebook.' },
        { id: 'reader-b', target: appUrl + '?reader=b', instruction: 'Your note is exactly: Bring a pencil.' }
      ] }], scenario: { mode: 'live' }, execution: { target: 'local', concurrency: 2, timeoutMs: 120_000,
      desktop: { resolution: [960, 720] } }, review: { analysis: { provider: 'codex' } }, policies: { redactScreenshots: false } });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const outcome = await runLocalFirecrackerStudy({ cwd: process.cwd(), config: parsed.config, dryRun: false, open: false, assets,
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)]) });
  const result = outcome.result;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.laneSummary.passed, 2);
  assert.equal(result.automaticAnalysis.state, 'complete');
  assert(saves.some(s => s.reader === 'a' && s.text === 'Bring a notebook.'));
  assert(saves.some(s => s.reader === 'b' && s.text === 'Bring a pencil.'));
  const verified = await verifyRun(process.cwd(), result.runId);
  assert.equal(verified.ok, true);
  const proof = { runId: result.runId, verified: true, saves, analysis: result.automaticAnalysis.state,
    observer: result.observer.observerPath };
  await writeFile(path.join(process.cwd(), '.humanish', 'local-runtime', 'study-proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally {
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
