import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportRun, formatExportHuman, localOnlyBanner } from "../src/export.js";
import { renderObserverHtml } from "../src/observer.js";
import type { ObserverData } from "../src/observer-data.js";
import type { VerifyResult } from "../src/run.js";
import { syntheticPng1x1 } from "./image-fixtures.js";
import { writeFixtureRun } from "./helpers/run-fixtures.js";

const PNG = syntheticPng1x1();
const RUN = "r-export";

function verified(status: VerifyResult["shareSafety"]["status"], ok = true): () => Promise<VerifyResult> {
  return async () => ({
    schema: "humanish.verify-result.v1",
    ok,
    cwd: "/x",
    run: RUN,
    checks: [],
    shareSafety: { status, reasons: status === "share_ready" ? [] : [{ code: "RAW_SCREENSHOTS", message: "raw" }] }
  } as unknown as VerifyResult);
}

// A run is a directory; sharing it meant a tunnel or a hand-zipped bundle (#471). Export writes
// one file, and it runs verify and the share_ready gate INSIDE the flow, fail-closed.
describe("humanish export", () => {
  let cwd: string;
  let runDir: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-export-"));
    await writeFixtureRun(cwd, { runId: RUN, labId: "try-live", mode: "live", state: "finished", verdict: "pass", estimatedCostUsd: 0.16 });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    await mkdir(path.join(runDir, "screenshots", "lane-01"), { recursive: true });
    await writeFile(path.join(runDir, "screenshots", "lane-01", "turn-01.png"), PNG);
    await mkdir(path.join(runDir, "observer"), { recursive: true });
    const data = {
      schema: "humanish.observer-data.v1",
      run: { runId: RUN },
      streams: [{ id: "s1", frames: [{ href: "screenshots/lane-01/turn-01.png", title: "t1" }, { href: "screenshots/lane-01/missing.png", title: "gone" }] }],
      links: [{ href: "../run.json", kind: "bundle" }, { href: "https://example.test/x.png", kind: "remote" }]
    };
    await writeFile(
      path.join(runDir, "observer", "index.html"),
      `<!doctype html><html><head><script id="observer-data" type="application/json">${JSON.stringify(data)}</script></head><body><div id="root"></div></body></html>`,
      "utf8"
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("writes ONE file with every in-run image inlined, and leaves what it cannot vouch for alone", async () => {
    const result = await exportRun(cwd, RUN, {}, { verify: verified("share_ready") });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.path).toBe(path.join(".humanish", "exports", `${RUN}.html`));
    expect(result.embeddedImages).toBe(1);
    expect(result.watermarked).toBe(false);
    const html = await readFile(path.join(cwd, result.path), "utf8");
    expect(html).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    // The missing frame keeps its path and is named in a warning, never invented.
    expect(html).toContain("screenshots/lane-01/missing.png");
    expect(result.warnings.some((w) => w.includes("missing.png"))).toBe(true);
    // A remote URL and a non-image link are untouched.
    expect(html).toContain("https://example.test/x.png");
    expect(html).toContain("../run.json");
    expect(html).not.toContain("humanish-local-only");
    expect(formatExportHuman(result)).toContain("1 image(s) embedded");
    // The file says what verify said, so its chrome can agree with the result envelope (#584).
    expect(html).toMatch(/"share":\{"status":"share_ready","verifiedAt":"[^"]+","reasons":\[\]\}/);
  });

  it("renders old recordings with the current packaged UI without changing the source", async () => {
    const index = path.join(runDir, "observer", "index.html");
    const oldHtml = (await readFile(index, "utf8")).replace("<body>", '<body><script>window.OBSOLETE_RENDERER_SENTINEL=true</script>');
    await writeFile(index, oldHtml);
    const result = await exportRun(cwd, RUN, {}, { verify: verified("share_ready") });
    if (!result.ok) throw new Error(result.error.message);
    const exported = await readFile(path.join(cwd, result.path), "utf8");
    const slot = /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(exported);
    expect(slot).not.toBeNull();
    const data = JSON.parse(slot![1]!) as ObserverData;
    expect(exported).toBe(renderObserverHtml(data));
    expect(exported).not.toContain("OBSOLETE_RENDERER_SENTINEL");
    expect(exported).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(await readFile(index, "utf8")).toBe(oldHtml);
  });

  it("removes saved runtime grants and liveness from portable HTML", async () => {
    const index = path.join(runDir, "observer", "index.html");
    const html = await readFile(index, "utf8");
    const replaced = html.replace(/(<script id="observer-data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_slot, start: string, json: string, end: string) => {
      const data = JSON.parse(json);
      data.runtime = { state: "running", source: "local-run-status", observedAt: "2026-09-08T00:00:00Z" };
      data.streams[0].embed = { kind: "iframe", url: "https://desktop.example/view", runtimeDesktop: true };
      return `${start}${JSON.stringify(data)}${end}`;
    });
    await writeFile(index, replaced);
    const result = await exportRun(cwd, RUN, {}, { verify: verified("share_ready") });
    if (!result.ok) throw new Error(result.error.message);
    const exported = await readFile(path.join(cwd, result.path), "utf8");
    const slot = /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(exported);
    expect(slot).not.toBeNull();
    const data = JSON.parse(slot![1]!) as ObserverData;
    expect(data).not.toHaveProperty("runtime");
    expect(data.streams[0]?.embed).not.toHaveProperty("runtimeDesktop");
    expect(data.streams[0]?.embed?.url).toBe("https://desktop.example/view");
    // The source recording remains untouched; export produces the portable projection.
    expect(await readFile(index, "utf8")).toBe(replaced);
  });

  it("refuses a bundle that is not share_ready, and says how to get one", async () => {
    const result = await exportRun(cwd, RUN, {}, { verify: verified("local_only") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED");
    expect(result.error.message).toContain("RAW_SCREENSHOTS");
    expect(result.error.message).toContain("--local-only");
  });

  it("--local-only exports the same bundle with a banner nothing can miss", async () => {
    const result = await exportRun(cwd, RUN, { localOnly: true }, { verify: verified("local_only") });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.watermarked).toBe(true);
    const html = await readFile(path.join(cwd, result.path), "utf8");
    expect(html).toContain(localOnlyBanner(["RAW_SCREENSHOTS"]));
    expect(html.indexOf("humanish-local-only")).toBeLessThan(html.indexOf('<div id="root">'));
    expect(formatExportHuman(result)).toContain("WATERMARKED LOCAL ONLY");
    expect(html).toMatch(/"share":\{"status":"local_only","verifiedAt":"[^"]+","reasons":\["RAW_SCREENSHOTS"\]\}/);
  });

  it("refuses to package a run that fails its own verify, and a run it cannot find", async () => {
    const failed = await exportRun(cwd, RUN, {}, { verify: verified("share_ready", false) });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("HUMANISH_EXPORT_VERIFY_FAILED");
    const missing = await exportRun(cwd, "r-nope", {}, { verify: verified("share_ready") });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("HUMANISH_EXPORT_RUN_NOT_FOUND");
  });

  it("stops at the size cap and says what it would have written", async () => {
    const result = await exportRun(cwd, RUN, { maxBytes: 200 }, { verify: verified("share_ready") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_EXPORT_TOO_LARGE");
    expect(result.error.message).toMatch(/\d+ bytes \(1 images/);
  });

  it("renders the Observer for a `run` bundle that has none, so what produced the run never decides whether it can be sent (#597)", async () => {
    await rm(path.join(runDir, "observer", "index.html"));
    let rendered = 0;
    const render = async () => {
      rendered += 1;
      await writeFile(path.join(runDir, "observer", "index.html"), `<!doctype html><html><head><script id="observer-data" type="application/json">{"run":{"runId":"r-export"},"streams":[{"frames":[{"href":"screenshots/lane-01/turn-01.png"}]}]}</script></head><body></body></html>`, "utf8");
      return { ok: true };
    };
    const result = await exportRun(cwd, RUN, {}, { verify: verified("share_ready"), render });
    if (!result.ok) throw new Error(result.error.message);
    expect(rendered).toBe(1);
    expect(result.embeddedImages).toBe(1);
    expect(result.warnings.some((w) => w.includes("rendered for this export"))).toBe(true);
    // A run that cannot be rendered still fails, named.
    await rm(path.join(runDir, "observer", "index.html"));
    const failed = await exportRun(cwd, RUN, {}, { verify: verified("share_ready"), render: async () => ({ ok: false }) });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("HUMANISH_EXPORT_NO_OBSERVER");
  });

  it("honours --out", async () => {
    const result = await exportRun(cwd, RUN, { out: "share/study.html" }, { verify: verified("share_ready") });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.path).toBe(path.join("share", "study.html"));
    await readFile(path.join(cwd, "share", "study.html"), "utf8");
  });
});
