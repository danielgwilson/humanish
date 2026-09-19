import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { fixture, analysisFixture, screenshot } from './observer-browser-fixtures.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const baseline = process.argv.includes('--baseline');
const axePath = option('--axe', createRequire(import.meta.url).resolve('axe-core/axe.min.js'));
const axeSource = await readFile(path.resolve(axePath), 'utf8');
const output = path.resolve(option('--output', path.join(root, '.humanish/observer-reliability', new Date().toISOString().replace(/[:.]/g, '-'))));
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const html = await readFile(path.resolve(option('--artifact', path.join(root, 'observer/dist/index.html'))), 'utf8');
const data = fixture({ laneCount: 4, frames: 5 });
// Recorded pixels, not a possibly stale declared viewport, are authoritative.
for (const stream of data.streams)
    stream.viewport = { width: 1280, height: 800 };
const analysis = analysisFixture(data);
let artifact = html;
for (const [id, value] of [['observer-data', data], ['study-analysis', analysis]])
    artifact = artifact.replace(new RegExp(`<script id="${id}"[^>]*>[\\s\\S]*?<\\/script>`), () => `<script id="${id}" type="application/json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`);
const delays = new Map(), pixels = new Map(), requests = [];
const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('cache-control', 'no-store');
    if (pathname === '/observer/index.html') {
        res.setHeader('content-type', 'text/html');
        res.end(artifact);
        return;
    }
    if (pathname === '/observer/observer-data.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data));
        return;
    }
    if (pathname === '/observer/study-analysis.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(analysis));
        return;
    }
    if (pathname === '/_humanish/history.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ runs: [] }));
        return;
    }
    const match = /^\/screenshots\/(portrait|landscape)-(\d+)\.png$/.exec(pathname);
    if (!match) {
        res.writeHead(404);
        res.end();
        return;
    }
    requests.push({ path: pathname, at: Date.now(), delay: delays.get(pathname) ?? 0 });
    if (delays.has(pathname))
        await new Promise(r => setTimeout(r, delays.get(pathname)));
    if (!pixels.has(pathname))
        pixels.set(pathname, screenshot(match[1] === 'portrait' ? 390 : 1200, match[1] === 'portrait' ? 844 : 750, Number(match[2])));
    res.setHeader('content-type', 'image/png');
    res.end(pixels.get(pathname));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let executablePath;
for (const candidate of [process.env.HUMANISH_BROWSER_EXECUTABLE, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean)) {
    try {
        await access(candidate);
        executablePath = candidate;
        break;
    }
    catch { }
}
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
async function seek(page, value) { await page.getByRole('slider', { name: 'Seek study recording', exact: true }).evaluate((el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value); }
async function ready(page, selector, ending) { await page.waitForFunction(({ selector, ending }) => { const image = document.querySelector(selector); return image?.src.endsWith(ending) && image.complete && image.naturalWidth > 0 && getComputedStyle(image).visibility !== 'hidden'; }, { selector, ending }); }
async function sample(page, selector, ms) { return page.evaluate(async ({ selector, ms }) => { const values = [], start = performance.now(); while (performance.now() - start < ms) {
    const image = document.querySelector(selector), box = image?.getBoundingClientRect(), style = image && getComputedStyle(image);
    values.push({ t: performance.now() - start, src: image?.getAttribute('src'), visible: !!image && image.complete && image.naturalWidth > 0 && style.visibility !== 'hidden' && box.width > 0, width: box?.width, height: box?.height, scroll: document.querySelector('.content')?.scrollTop, notice: document.querySelector('.evidence-message,.capture-loading')?.textContent });
    await new Promise(requestAnimationFrame);
} return values; }, { selector, ms }); }
try {
    for (const phone of [false, true]) {
        const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone });
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const record = { id: phone ? 'phone' : 'desktop', checks: {}, errors: [] };
        results.push(record);
        page.on('pageerror', e => record.errors.push(e.message));
        try {
            await page.goto(`${origin}/observer/index.html`);
            await seek(page, 0);
            await ready(page, '.card .keyframe', 'portrait-1.png');
            delays.set('/screenshots/portrait-2.png', 650);
            await seek(page, 7000);
            const gridSampling = sample(page, '.card .keyframe', 800);
            await page.waitForTimeout(100);
            await page.screenshot({ path: path.join(output, `${record.id}-grid-during-load.png`) });
            record.checks.gridSlow = await gridSampling;
            await ready(page, '.card .keyframe', 'portrait-2.png');
            await page.screenshot({ path: path.join(output, `${record.id}-grid.png`) });
            await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/0`);
            await ready(page, '.stage-box img', 'portrait-1.png');
            await seek(page, 7000);
            const playerSampling = sample(page, '.stage-box img', 800);
            await page.waitForTimeout(100);
            await page.screenshot({ path: path.join(output, `${record.id}-player-during-load.png`) });
            record.checks.playerSlow = await playerSampling;
            await ready(page, '.stage-box img', 'portrait-2.png');
            await page.screenshot({ path: path.join(output, `${record.id}-player.png`) });
            await seek(page, 0);
            await ready(page, '.stage-box img', 'portrait-1.png');
            delays.set('/screenshots/portrait-4.png', 650);
            delays.set('/screenshots/portrait-5.png', 80);
            await seek(page, 21000);
            await seek(page, 28000);
            record.checks.rapid = await sample(page, '.stage-box img', 850);
            assert(record.checks.rapid.at(-1).src.endsWith('portrait-5.png'), 'Late response replaced the selected frame');
            if (!baseline) {
                for (const name of ['gridSlow', 'playerSlow', 'rapid'])
                    assert(record.checks[name].every(v => v.visible), `${name} blanked decoded evidence`);
                for (const name of ['gridSlow', 'playerSlow'])
                    assert(new Set(record.checks[name].map(v => `${v.width}/${v.height}`)).size === 1, `${name} changed same-raster geometry`);
            }
            await page.getByRole('button', { name: 'Back to participants', exact: true }).click();
            for (const reduced of [false, true]) {
                await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
                const card = page.locator('[data-stream-id="lane-2"]');
                await card.getByRole('button', { name: /^Participant details:/ }).click();
                const pin = page.getByRole('button', { name: /^Pin(?:ned)? participant Synthetic participant 2$/ });
                await pin.focus();
                await page.screenshot({ path: path.join(output, `${record.id}-pin-${reduced ? 'reduced' : 'motion'}-before.png`) });
                const movingPromise = pin.evaluate(async (button) => {
                    const grid = document.querySelector('.gallery'), scroll = document.querySelector('.content').scrollTop;
                    const cards = [...grid.querySelectorAll('.card')];
                    const values = [];
                    button.click();
                    const start = performance.now();
                    while (performance.now() - start < 350) {
                        await new Promise(requestAnimationFrame);
                        values.push({ t: performance.now() - start, scroll: document.querySelector('.content').scrollTop, cards: cards.map(card => ({ id: card.dataset.streamId, transform: getComputedStyle(card).transform, rect: card.getBoundingClientRect().toJSON(), sameNode: card.isConnected })) });
                    }
                    return { beforeScroll: scroll, values, focusRetained: document.activeElement === button, first: grid.firstElementChild.dataset.streamId };
                });
                await page.waitForTimeout(80);
                await page.screenshot({ path: path.join(output, `${record.id}-pin-${reduced ? 'reduced' : 'motion'}-during.png`) });
                const movement = await movingPromise;
                record.checks[reduced ? 'pinReduced' : 'pinMotion'] = movement;
                if (!baseline) {
                    assert.equal(movement.first, reduced ? 'lane-1' : 'lane-2');
                    assert(movement.focusRetained, 'Pinning lost keyboard focus');
                    assert(movement.values.every(v => Math.abs(v.scroll - movement.beforeScroll) < 1), 'Pinning jumped the evidence scroller');
                    const moving = new Set(movement.values.flatMap(v => v.cards.filter(c => c.transform !== 'none').map(c => c.id)));
                    assert(reduced ? moving.size === 0 : moving.size >= 2, 'Selected and displaced participants did not respect motion preference');
                }
                await page.getByRole('button', { name: 'Close participant details', exact: true }).click();
            }
            if (axeSource) {
                record.checks.accessibility = [];
                for (const theme of ['light', 'dark'])
                    for (const view of ['grid', 'player', 'report']) {
                        await page.goto(`${origin}/observer/index.html${view === 'player' ? '#/lane/lane-1/f/0' : view === 'report' ? '#/report' : ''}`);
                        await page.locator('.study-views').waitFor();
                        await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
                        await page.addScriptTag({ content: axeSource });
                        await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map(a => a.finished.catch(() => { }))); });
                        const audit = await page.evaluate(async () => { const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } }); return { violations: result.violations, incomplete: result.incomplete, passes: result.passes.map(p => p.id), contrast: result.passes.find(p => p.id === 'color-contrast')?.nodes.map(n => ({ target: n.target, checks: n.any.map(c => c.data) })) }; });
                        if (phone && view === 'player') {
                            const final = page.locator('[data-entry-id="lane-1-final"]');
                            await final.scrollIntoViewIfNeeded();
                            audit.scrolledRow = await page.evaluate(async () => { const result = await axe.run(document.querySelector('[data-entry-id="lane-1-final"]'), { runOnly: ['color-contrast'] }); return { violations: result.violations, incomplete: result.incomplete, passes: result.passes }; });
                            if (!baseline) {
                                assert.equal(audit.scrolledRow.violations.length, 0);
                                assert.equal(audit.scrolledRow.incomplete.length, 0, 'Scrolled action text still obscured');
                            }
                        }
                        record.checks.accessibility.push({ theme, view, ...audit });
                        await page.screenshot({ path: path.join(output, `${record.id}-${theme}-${view}.png`) });
                        if (!baseline)
                            assert.equal(audit.violations.length, 0, `Accessibility failures in ${theme} ${view}`);
                    }
            }
            assert.deepEqual(record.errors, [], 'Observer raised an uncaught error');
            record.status = 'passed';
        }
        catch (error) {
            record.status = 'failed';
            record.error = String(error.stack ?? error);
            await page.screenshot({ path: path.join(output, `${record.id}-failure.png`) }).catch(() => { });
        }
        finally {
            await context.close();
            delays.clear();
        }
        process.stdout.write(`${record.status.toUpperCase()} ${record.id}\n`);
    }
}
finally {
    await browser.close();
    await new Promise(r => server.close(r));
    await writeFile(path.join(output, 'proof.json'), JSON.stringify({ baseline, scope: 'Controlled renderer proof; original synthetic capture identities preserved', results, requests }, null, 2));
    process.stdout.write(`${output}\n`);
}
if (results.some(r => r.status !== 'passed'))
    process.exitCode = 1;
