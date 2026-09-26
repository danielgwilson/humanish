import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDryRun, verifyRun, type RunBundle } from "../src/run.js";
import { parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { collectDesktopRecording } from "../src/desktop-recording-artifact.js";
import { prepareRunArtifactPaths } from "../src/run-paths.js";
import { exportRun } from "../src/export.js";
import { renderObserver } from "../src/observer.js";

// Structural MP4 header only: these tests validate evidence handling, not decoding.
const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
const metadata = { mimeType: "video/mp4" as const, startedAt: "2026-09-26T10:00:00.000Z", durationMs: 2000,
  bytes: MP4.length, audioSources: [] as [], complete: true };

describe("optional recording evidence", () => {
  let cwd: string;
  let root: string;
  let bundle: RunBundle;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-recording-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const run = await runDryRun({ cwd, dryRun: true, runId: "recording-evidence" });
    expect(run.ok).toBe(true);
    root = path.join(cwd, ".humanish/runs/recording-evidence");
    bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8"));
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  async function addRecording() {
    const recording = await collectDesktopRecording(await prepareRunArtifactPaths(cwd, "recording-evidence"), "lane-01", async destination => {
      await pipeline(Readable.from([MP4]), destination);
      return metadata;
    });
    bundle.streams[0]!.recording = recording;
    bundle.streams[0]!.artifacts.push({ label: "desktop recording", path: recording.path, kind: "recording" });
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
    return recording;
  }
  it("streams the file and retains a local-only share grade even when screenshots are shareable", async () => {
    const recording = await addRecording();
    expect(await readFile(path.join(root, recording.path))).toEqual(MP4);
    const verified = await verifyRun(cwd, "recording-evidence");
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    expect(verified.shareSafety.status).toBe("local_only");
    expect(verified.shareSafety.reasons.map(reason => reason.code)).toContain("CONTINUOUS_MEDIA");
  });
  it("rejects missing or damaged media and unregistered MP4 files", async () => {
    const recording = await addRecording();
    await writeFile(path.join(root, recording.path), Buffer.alloc(MP4.length));
    expect((await verifyRun(cwd, "recording-evidence")).ok).toBe(false);
    await rm(path.join(root, recording.path));
    expect((await verifyRun(cwd, "recording-evidence")).ok).toBe(false);
    delete bundle.streams[0]!.recording;
    bundle.streams[0]!.artifacts = bundle.streams[0]!.artifacts.filter(item => item.kind !== "recording");
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
    await writeFile(path.join(root, "stray.mp4"), MP4);
    expect((await verifyRun(cwd, "recording-evidence")).ok).toBe(false);
  });
  it("removes video paths from portable HTML and visibly explains the omission", async () => {
    const recording = await addRecording();
    await renderObserver(cwd, "recording-evidence", { open: false });
    const result = await exportRun(cwd, "recording-evidence", { localOnly: true });
    if (!result.ok) throw new Error(result.error.message);
    const html = await readFile(path.join(cwd, result.path), "utf8");
    const data = JSON.parse(/<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(data.streams[0].recording).toBeUndefined();
    expect(data.streams[0].artifacts.some((item: {path: string}) => item.path === recording.path)).toBe(false);
    expect(html).toContain("Continuous video/audio is excluded from this HTML export");
    expect(await readFile(path.join(root, recording.path))).toEqual(MP4);
  });
  it("does not leave a file after a failed transfer", async () => {
    const paths = await prepareRunArtifactPaths(cwd, "recording-evidence");
    await expect(collectDesktopRecording(paths, "lane-01", async destination => {
      await pipeline(Readable.from([MP4]), destination);
      return { ...metadata, bytes: MP4.length + 1 };
    })).rejects.toThrow("size");
    await expect(readFile(path.join(root, "recordings/lane-01/desktop.mp4"))).rejects.toThrow();
  });
});

it("keeps capture optional and rejects declarations that no runtime will consume", () => {
  const config: LabConfig = { schema: "humanish.lab.v2", id: "record-browser", subject: {source: "app-url", appUrl: "http://127.0.0.1:3000"},
    actors: [{type: "openai-computer-use"}], execution: {target: "e2b-desktop", desktop: {recording: {audio: true}}}, scenario: {mode: "live"} };
  expect(parseLabConfig(config).ok).toBe(true);
  config.actors[0]!.type = "scripted-browser";
  config.execution!.target = "local";
  config.scenario!.ref = "scripted-first-run";
  expect(parseLabConfig(config).ok).toBe(false);
  delete config.execution!.desktop!.recording;
  expect(parseLabConfig(config).ok).toBe(true);
});
