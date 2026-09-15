#!/usr/bin/env node
// Opt-in evaluator. Generated source, captures, wire data and usage stay outside the repo.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases, renderFrame } from "../fixtures/analysis-quality/cases.mjs";

const exec = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [command, ...argv] = process.argv.slice(2);
const args = Object.fromEntries(argv.map((value, i) => value.startsWith("--") ? [value.slice(2), argv[i + 1]] : []).filter(row => row.length));
const required = name => { if (!args[name] || args[name].startsWith("--")) throw new Error(`Missing --${name}`); return args[name]; };
const out = path.resolve(required("out"));
if (out === repository || !path.relative(repository, out).startsWith("..")) throw new Error("Evaluation output must be outside the repository.");
const packageRoot = path.resolve(required("package"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async (file, value, exclusive = false) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: exclusive ? "wx" : "w", mode: 0o600 });
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const mod = name => import(pathToFileURL(path.join(packageRoot, "dist", `${name}.js`)).href);
const runtime = await mod("run");
const evidence = await mod("study-analysis-evidence");
const service = await mod("study-analysis-service");
const engine = await mod("study-analysis-engine");
const config = { model: "gpt-6-astra", question: null, maxCostUsd: 3, timeoutMs: 300000, maxOutputTokens: 16384 };
const provenance = "Scripted reconstruction with fictional data and authored participant accounts; not a live autonomous actor recording. Stage timings are reconstruction timestamps, not measured human durations.";

async function packagePin() {
  const metadata = await readJson(path.join(packageRoot, "package.json"));
  const files = {};
  for (const name of ["study-analysis-engine", "study-analysis-provider", "study-analysis-validation", "study-analysis-evidence", "study-analysis-service"]) {
    files[`dist/${name}.js`] = hash(await readFile(path.join(packageRoot, "dist", `${name}.js`)));
  }
  return { version: metadata.version, promptVersion: engine.STUDY_ANALYSIS_PROMPT_VERSION, files };
}

if (command === "author") {
  await mkdir(out, { recursive: true });
  const corpusRoot = path.join(out, "corpus");
  await mkdir(corpusRoot); // Never overwrite frozen source.
  const sourceHash = hash(await readFile(new URL("../fixtures/analysis-quality/cases.mjs", import.meta.url)));
  await json(path.join(corpusRoot, "gold.json"), { frozenAt: new Date().toISOString(), corpusSourceSha256: sourceHash,
    provenance, cases: cases.map(({ id, gold }) => ({ id, ...gold })) }, true);
  const routes = new Map();
  const server = createServer((req, res) => {
    const html = routes.get(req.url);
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html ?? "Not found");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = `analysis-quality-${process.pid}`;
  const browser = async (...options) => (await exec("agent-browser", ["--session", session, ...options], { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const entries = [];
  try {
    await browser("open", "about:blank");
    await browser("set", "viewport", "1280", "900");
    for (const spec of cases) {
      const caseRoot = path.join(corpusRoot, spec.id);
      const cwd = path.join(caseRoot, "project");
      await mkdir(caseRoot);
      await cp(path.join(repository, "fixtures/minimal-app"), cwd, { recursive: true });
      const runId = `quality-${spec.id}`;
      await runtime.runDryRun({ cwd, dryRun: true, runId });
      const prepared = await runtime.resolveRunPath(cwd, runId);
      const root = prepared.physicalRunRoot;
      const bundle = await readJson(path.join(root, "run.json"));
      const template = bundle.streams[0];
      const simulation = bundle.simulations[0];
      const sourceFrames = [];
      bundle.mode = "live"; // Service admission mode, qualified by explicit source provenance below.
      bundle.streams = []; bundle.simulations = []; bundle.simCount = spec.participants.length;
      bundle.feedbackCandidates = [];
      bundle.scenario.title = `Scripted reconstruction: ${spec.title}`;
      bundle.scenario.goal = provenance;
      bundle.review.summary = provenance;
      bundle.events = [];
      await mkdir(path.join(root, "captures"));
      for (const participant of spec.participants) {
        const simId = `${participant.id}-simulation`;
        const startedAt = new Date().toISOString();
        const items = [{ id: `${participant.id}-provenance`, kind: "notice", lifecycle: "completed", title: "Source provenance", text: provenance, at: startedAt }];
        for (const [index, frame] of participant.frames.entries()) {
          const route = `/${spec.id}/${participant.id}/${index}`;
          const html = renderFrame(frame);
          routes.set(route, html);
          const at = new Date().toISOString();
          const url = `${origin}${route}`;
          await browser("open", url);
          const actualUrl = await browser("get", "url");
          if (actualUrl !== url) throw new Error("The rendered fixture did not retain its expected origin.");
          const framePath = `captures/${participant.id}-${index}.png`;
          await browser("screenshot", path.join(root, framePath));
          const screenshot = await readFile(path.join(root, framePath));
          const frameId = `${participant.id}-capture-${index}`;
          await writeFile(path.join(caseRoot, `${participant.id}-${index}.html`), html);
          items.push({ id: `${participant.id}-stage-${index}`, kind: "ui_action", lifecycle: "completed", at,
            title: "Scripted fixture state rendered", text: `${frame.action} Browser reported URL: ${actualUrl}. Configured origin: ${origin}.` });
          items.push({ id: frameId, kind: "screenshot", lifecycle: "completed", at,
            title: "Rendered local reconstruction", screenshotRef: { path: framePath, redaction: "none" } });
          items.push({ id: `${participant.id}-account-${index}`, kind: "message", lifecycle: "completed", at,
            title: "Authored participant account", text: frame.account });
          sourceFrames.push({ streamId: participant.id, eventId: frameId, path: framePath, sha256: hash(screenshot), actualUrl, configuredOrigin: origin });
        }
        const completedAt = new Date().toISOString();
        items.push({ id: `${participant.id}-closing`, kind: "message", lifecycle: "completed", at: completedAt,
          title: "Authored closing account", text: participant.closing });
        const stream = { ...template, id: participant.id, simId, label: `${participant.id} · scripted reconstruction`,
          status: participant.status, assignment: { mission: `${participant.mission}\nConfigured local origin: ${origin}.` },
          transport: "snapshot", updatedAt: completedAt, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
          artifacts: sourceFrames.filter(frame => frame.streamId === participant.id).map(frame => ({ kind: "screenshot", label: "Rendered fictional fixture", path: frame.path })),
          ui: { intent: participant.mission, appUrl: origin, screenshotUrl: sourceFrames.filter(frame => frame.streamId === participant.id).at(-1).path },
          actor: { schema: "humanish.actor-trace.v1", provider: "scripted-reconstruction", protocol: "scripted-steps", lane: "scripted-browser",
            persona: { id: participant.id, traitsApplied: [], promptDigest: hash(Buffer.from(provenance)) },
            redaction: { status: "passed", screenshots: "raw", notes: "Full-fidelity local renders; every displayed value is fictional." },
            startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt), status: participant.status,
            completionReason: "turn_completed", reason: provenance, ids: {}, counts: {}, items,
            capabilities: { headless: true, structuredTrace: true, lanes: ["scripted-browser"], producesScreenshots: true,
              byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "open" } } };
        delete stream.embed; delete stream.codex; delete stream.terminal;
        bundle.streams.push(stream);
        bundle.simulations.push({ ...simulation, id: simId, index: bundle.simulations.length + 1,
          streamIds: [participant.id], status: participant.status, summary: provenance });
        bundle.events.push({ id: `${participant.id}-source`, at: startedAt, level: "info", type: "evaluation.reconstruction", streamId: participant.id, simId, message: provenance });
      }
      await json(path.join(root, "run.json"), bundle);
      await writeFile(path.join(root, "events.ndjson"), bundle.events.map(event => JSON.stringify(event)).join("\n") + "\n");
      await rm(path.join(root, "status.json"), { force: true });
      const verification = await runtime.verifyRun(cwd, runId);
      await json(path.join(caseRoot, "verify.json"), verification);
      if (!verification.ok && verification.recordingOk !== true) throw new Error(`Source verification failed: ${spec.id}`);
      const source = await readFile(path.join(root, "run.json"));
      const packet = await evidence.captureStudyEvidence(prepared, source);
      const { images, ...metadata } = packet;
      await json(path.join(caseRoot, "selected-packet.json"), metadata);
      const manifest = { id: spec.id, runId, cwd, sourceRunSha256: hash(source), inputDigest: packet.inputDigest,
        provenance, frames: sourceFrames, coverage: packet.coverage };
      await json(path.join(caseRoot, "source-freeze.json"), manifest, true);
      entries.push(manifest);
      console.log(JSON.stringify({ authored: spec.id, captures: images.length, complete: packet.coverage.complete }));
    }
    await json(path.join(corpusRoot, "manifest.json"), { frozenAt: new Date().toISOString(), provenance,
      corpusSourceSha256: sourceHash, goldSha256: hash(await readFile(path.join(corpusRoot, "gold.json"))), package: await packagePin(), cases: entries }, true);
  } finally {
    await browser("close").catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
} else if (command === "prepare" || command === "run") {
  const tag = required("tag");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tag)) throw new Error("Invalid attempt tag.");
  const manifest = await readJson(path.join(out, "corpus/manifest.json"));
  const attemptRoot = path.join(out, "attempts", tag);
  if (command === "prepare") {
    await mkdir(attemptRoot, { recursive: true });
    await json(path.join(attemptRoot, "package.json"), await packagePin(), true);
    for (const sourceCase of manifest.cases) {
      const caseRoot = path.join(attemptRoot, sourceCase.id); await mkdir(caseRoot);
      const cwd = path.join(caseRoot, "project");
      await cp(sourceCase.cwd, cwd, { recursive: true });
      const prepared = await runtime.resolveRunPath(cwd, sourceCase.runId);
      const bytes = await readFile(path.join(prepared.physicalRunRoot, "run.json"));
      if (hash(bytes) !== sourceCase.sourceRunSha256) throw new Error("Source copy changed.");
      const packet = await evidence.captureStudyEvidence(prepared, bytes);
      const { images, ...metadata } = packet;
      const admission = await service.analyzeStudy(cwd, sourceCase.runId, { config, dryRun: true }, { apiKey: "" });
      await json(path.join(caseRoot, "selected-packet.json"), metadata);
      await json(path.join(caseRoot, "admission.json"), admission);
      await json(path.join(caseRoot, "freeze.json"), { ...sourceCase, cwd, config, preparedAt: new Date().toISOString(),
        inputDigest: packet.inputDigest, images: images.map(image => ({ evidenceId: image.evidenceId,
          sha256: hash(Buffer.from(image.dataUrl.split(",")[1], "base64")) })) }, true);
      console.log(JSON.stringify({ prepared: sourceCase.id, allowed: admission.admission?.allowed,
        estimatedCostUsd: admission.admission?.estimatedCostUsd, inputDigest: packet.inputDigest }));
    }
  } else {
    if (!argv.includes("--execute")) throw new Error("Paid calls require --execute.");
    if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is missing.");
    const pinned = await readJson(path.join(attemptRoot, "package.json"));
    if (JSON.stringify(pinned) !== JSON.stringify(await packagePin())) throw new Error("Prepared package changed.");
    const lock = path.join(out, ".evaluation-budget-lock");
    await mkdir(lock);
    try {
      const ledgerPath = path.join(out, "usage-ledger.json");
      const ledger = await readJson(ledgerPath).catch(error => { if (error.code !== "ENOENT") throw error; return { ceilingUsd: 25, attempts: [] }; });
      for (const sourceCase of manifest.cases) {
        const caseRoot = path.join(attemptRoot, sourceCase.id);
        const freeze = await readJson(path.join(caseRoot, "freeze.json"));
        const admission = await readJson(path.join(caseRoot, "admission.json"));
        if (!admission.admission?.allowed) throw new Error("Prepared admission refused.");
        if (ledger.attempts.some(attempt => attempt.tag === tag && attempt.caseId === sourceCase.id)) throw new Error("Attempt already consumed; no automatic retry.");
        if (ledger.attempts.reduce((sum, attempt) => sum + attempt.reservedUsd, 0) + config.maxCostUsd > ledger.ceilingUsd) throw new Error("Evaluation reservation ceiling reached.");
        const prepared = await runtime.resolveRunPath(freeze.cwd, sourceCase.runId);
        if (hash(await readFile(path.join(prepared.physicalRunRoot, "run.json"))) !== sourceCase.sourceRunSha256) throw new Error("Frozen source changed.");
        const record = { tag, caseId: sourceCase.id, reservedUsd: config.maxCostUsd, state: "reserved", startedAt: new Date().toISOString(), requestCount: 0 };
        ledger.attempts.push(record); await json(ledgerPath, ledger);
        const captureFetch = async (url, options) => {
          record.requestCount++;
          if (record.requestCount !== 1) throw new Error("Unexpected repeated transport request.");
          await json(ledgerPath, ledger);
          await writeFile(path.join(caseRoot, "request-body.json"), String(options.body), { flag: "wx", mode: 0o600 });
          const response = await fetch(url, options);
          await writeFile(path.join(caseRoot, "response-body.json"), await response.clone().text(), { flag: "wx", mode: 0o600 });
          await json(path.join(caseRoot, "response-meta.json"), { status: response.status, receivedAt: new Date().toISOString() }, true);
          return response;
        };
        const result = await service.analyzeStudy(freeze.cwd, sourceCase.runId, { config }, { expectedRun: prepared, fetch: captureFetch });
        await json(path.join(caseRoot, "result.json"), result, true);
        const artifactPath = result.artifactPath ? path.join(freeze.cwd, result.artifactPath) : null;
        if (artifactPath) await cp(artifactPath, path.join(caseRoot, "raw-artifact.json"), { errorOnExist: true, force: false });
        record.state = result.ok ? "accepted" : "failed"; record.completedAt = new Date().toISOString();
        record.usage = result.usage ?? null; record.error = result.error?.code ?? null; record.analysisId = result.analysisId ?? null;
        await json(ledgerPath, ledger);
        console.log(JSON.stringify({ caseId: sourceCase.id, status: result.status, ok: result.ok, requestCount: record.requestCount,
          estimatedCostUsd: result.usage?.estimatedCostUsd ?? null, error: record.error }));
      }
    } finally { await rmdir(lock).catch(() => {}); }
  }
} else throw new Error("Use author, prepare, or run.");
