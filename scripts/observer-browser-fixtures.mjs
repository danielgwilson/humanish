import { PNG } from "pngjs";

// Synthetic renderer-contract fixtures, not provider wire fixtures or real research.
export const PHONE = "Avery-Phone-Participant-With-An-Intentionally-Long-Unbroken-Display-Name";
// Fresh running evidence, with one stable clock shared across this invocation.
export const START = Date.now() - 60_000;
export const stamp = (index) => new Date(START + index * 7000).toISOString();

export function screenshot(width, height, index = 0) {
  const png = new PNG({ width, height });
  const corners = [[241, 55, 76], [46, 181, 113], [52, 120, 238], [245, 181, 32]];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (width * y + x) * 4;
      const corner = x < 48 && y < 48 ? 0 : x >= width - 48 && y < 48 ? 1
        : x < 48 && y >= height - 48 ? 2 : x >= width - 48 && y >= height - 48 ? 3 : -1;
      const color = corner >= 0 ? corners[corner] : y > height * 0.72
        ? [205, 218, 226] : [(x + index * 35) % 80 + 150, 186, 203];
      png.data.set([...color, 255], at);
    }
  }
  return PNG.sync.write(png);
}

export function frame(laneId, index, shape = "portrait") {
  return { id: `${laneId}-frame-${index}`, kind: "screenshot", lifecycle: "completed",
    title: `Synthetic ${shape} capture ${index}`, at: stamp(index),
    screenshotRef: { path: `screenshots/${shape}-${index}.png`, redaction: "none" } };
}

export function fixture({ running = false, live = false, laneCount = 3, frames = 4, rows = 0, origin = "" } = {}) {
  const streams = Array.from({ length: laneCount }, (_, n) => {
    const id = `lane-${n + 1}`;
    const shape = n % 2 === 0 ? "portrait" : "landscape";
    const items = [];
    for (let i = 1; i <= frames; i += 1) {
      items.push(frame(id, i, shape));
      items.push({ id: `${id}-action-${i}`, kind: "ui_action", lifecycle: "completed",
        title: `click (120, 240) — synthetic action ${i}`, at: stamp(i), coord: { x: 120, y: 240 } });
    }
    for (let i = 0; i < rows; i += 1) {
      items.push({ id: `${id}-wait-${i}`, kind: "ui_action", lifecycle: "completed",
        title: `wait 1s`, at: stamp(frames), text: `Synthetic wait ${i + 1}` });
    }
    items.push({ id: `${id}-final`, kind: "message", lifecycle: "completed", title: "Final observation",
      text: "FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE", at: stamp(frames) });
    const label = n === 0 ? PHONE : `Synthetic participant ${n + 1}`;
    const sim = { id: `sim-${n + 1}`, index: n + 1, personaId: `persona-${n + 1}`, scenarioId: "synthetic-observer",
      status: running ? "running" : "passed", streamKind: "browser", currentStep: "Inspect evidence",
      mode: "browser-sim", progress: running ? 0.5 : 1,
      summary: "Synthetic participant explored a fictional interface.", streamIds: [id], startedAt: stamp(0), updatedAt: stamp(frames) };
    const actor = { schema: "humanish.actor-trace.v1", provider: "synthetic-browser-proof", providerVersion: "fixture-v1",
      protocol: "cua-loop", lane: "computer-use", status: "passed", startedAt: stamp(0),
      persona: { id: `persona-${n + 1}`, traitsApplied: [], promptDigest: "synthetic" },
      completedAt: stamp(frames), durationMs: frames * 7000, completionReason: "goal_satisfied", reason: "Synthetic task completed.",
      ids: {}, counts: { turns: frames, actions: frames, materialActions: frames, screenshots: frames,
        reasonings: 0, messages: 1, idleTurns: rows, noProgressTurns: 0 }, items,
      redaction: { status: "passed", screenshots: "raw", notes: "Generated synthetic pixels only; no actual user data." } };
    return { id, simId: sim.id, laneId: label, kind: "browser", label, status: sim.status,
      transport: live ? "sse" : "snapshot", updatedAt: stamp(frames),
      embed: live ? { kind: "iframe", url: `${origin}/desktop/${id}`, title: "Controlled local desktop fixture" }
        : { kind: "screenshot", url: `screenshots/${shape}-${frames}.png`, title: "Synthetic recording" },
      viewport: { width: shape === "portrait" ? 390 : 1200, height: shape === "portrait" ? 844 : 750,
        deviceScaleFactor: 1, isMobile: shape === "portrait" },
      ui: { route: "/synthetic", state: "Synthetic evidence", intent: "Inspect a fictional interface" },
      ...(running ? { liveActor: { schema: "humanish.live-actor.v1", updatedAt: stamp(frames), items } } : { actor }),
      sim, kindLabel: "Browser", statusLabel: running ? "Running" : "Passed", terminalPlain: "", timeline: [], artifacts: [] };
  });
  return { schema: "humanish.observer-data.v1", schemaVersion: 1, generatedAt: new Date().toISOString(),
    run: { runId: "synthetic-observer-browser-proof", mode: "live", status: running ? "contract_proof_only" : "pass",
      title: "Synthetic mixed-screen evidence review", createdAt: stamp(0), simCount: laneCount,
      persona: { id: "synthetic", name: "Synthetic participants", source: "fixture", sourceDigest: "synthetic" },
      scenario: { id: "synthetic-observer", title: "Synthetic mixed-screen evidence review", goal: "Inspect generated evidence.", source: "fixture", sourceDigest: "synthetic" },
      packageName: "fictional-interface", redaction: { status: "passed", notes: "Synthetic pixels and text only." },
      lifecycle: [], knownGaps: [], participantsLine: `${laneCount} synthetic participants` },
    summary: { streams: laneCount, byKind: { ui: 0, browser: laneCount, terminal: 0, tui: 0, "codex-ui": 0, artifact: 0, summary: 0 },
      active: running ? laneCount : 0, blocked: 0, warnings: 0 }, laneGroups: [], streams, events: [], artifactLinks: [],
    publicSafety: { publishable: false, note: "Synthetic local browser acceptance fixture." },
    raw: { bundleSchema: "humanish.run.v1", artifactRoot: ".humanish/synthetic-observer-browser-proof" } };
}

export function appendFrame(data) {
  for (const [index, stream] of data.streams.entries()) {
    const trace = stream.actor ?? stream.liveActor;
    const next = trace.items.filter((item) => item.kind === "screenshot").length + 1;
    trace.items.push(frame(stream.id, next, index % 2 === 0 ? "portrait" : "landscape"));
    stream.updatedAt = stamp(next);
    if (stream.actor) stream.actor.durationMs = next * 7000;
    if (stream.liveActor) stream.liveActor.updatedAt = stamp(next);
  }
  data.generatedAt = new Date().toISOString();
}
