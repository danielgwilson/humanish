import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServeRequestHandler, createShareSafetyAdmission } from "../src/observer-serve.js";
import { pinDirectory } from "../src/observer.js";
import { resolveRunPath, runDryRun, verifyRun } from "../src/run.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { writeStudyAnalysis, writeStudyAnalysisExecutionReceipt } from "../src/study-analysis-store.js";
import { syntheticArtifact } from "./study-analysis-fixtures.js";

// Constructed synthetic marker, not a credential; never output its value in assertions.
const marker = "sk-" + "syntheticvalue1234567890abcdef";

describe("analysis sharing through a warmed serving cache", () => {
  it.each(["summary", "excluded concern"])("denies unsafe %s text in raw records and the exact companion payload", async (field) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-sharing-"));
    let server: Server | undefined;
    try {
      await runDryRun({ cwd, dryRun: true, runId: "synthetic-study" });
      const prepared = (await resolveRunPath(cwd, "synthetic-study"))!;
      const source = await readFile(path.join(prepared.physicalRunRoot, "run.json"));
      const input = await captureStudyEvidence(prepared, source);
      const admission = createShareSafetyAdmission(cwd, { ttlMs: 30000 });
      expect((await verifyRun(cwd, "synthetic-study")).shareSafety.status).toBe("share_ready");
      expect(await admission.admit("synthetic-study")).toBe(true);
      const artifact = syntheticArtifact(input);
      if (field === "summary") artifact.result!.summary = marker;
      else artifact.result!.concernReviews = [{ claim: "A reported concern was not established.", basis: "inference",
        evidenceIds: [input.evidence[0]!.id], limitation: "Synthetic fixture.", disposition: "unsupported", findingId: null, reason: marker }];
      await writeStudyAnalysisExecutionReceipt(prepared, artifact);
      await writeStudyAnalysis(prepared, artifact);
      // Atomic writer files are private even during publication. Older ordinary
      // files under analysis/ retain the generic contained-file serving contract.
      await writeFile(path.join(prepared.physicalRunRoot, "analysis", artifact.id, ".humanish-write-synthetic.tmp"), marker);
      await writeFile(path.join(prepared.physicalRunRoot, "analysis-attempts", artifact.id, ".humanish-write-synthetic.tmp"), marker);
      await writeFile(path.join(prepared.physicalRunRoot, "analysis", "legacy-notes.txt"), "Synthetic legacy evidence");
      expect((await verifyRun(cwd, "synthetic-study")).shareSafety.status).toBe("blocked");
      // run.json has not changed, so the old admission is deliberately still warm.
      expect(await admission.admit("synthetic-study")).toBe(true);
      const allowedHosts = new Set<string>();
      const handler = createServeRequestHandler({
        proofRoot: await pinDirectory(prepared.physicalRunsRoot), safe: true,
        admit: admission.admit, hostAllowlist: allowedHosts, renderLibrary: () => ""
      });
      server = createServer((request, response) => { void handler(request, response); });
      await new Promise<void>((done) => { server!.listen(0, "127.0.0.1", done); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Synthetic server has no address.");
      allowedHosts.add(`127.0.0.1:${address.port}`);
      const base = `http://127.0.0.1:${address.port}/_humanish/runs/synthetic-study/`;
      for (const route of [
        `analysis/${artifact.id}/analysis.json`,
        `anal%79sis/${artifact.id}/analysis.json`,
        `analysis//${artifact.id}/analysis.json`,
        `observer/../analysis/${artifact.id}/analysis.json`,
        `analysis-attempts/${artifact.id}/receipt.json`,
        `analysis/${artifact.id}/.humanish-write-synthetic.tmp`,
        `analysis-attempts/${artifact.id}/.humanish-write-synthetic.tmp`
      ]) {
        const response = await fetch(new URL(route, base));
        expect(response.status, route).toBe(404);
        expect((await response.text()).includes(marker)).toBe(false);
      }
      const companion = await fetch(new URL("observer/study-analysis.json", base));
      expect(companion.status).toBe(200);
      const text = await companion.text();
      expect(text.includes(marker)).toBe(false);
      expect(JSON.parse(text)).toMatchObject({ state: "invalid", analysis: null,
        warnings: ["ANALYSIS_SENSITIVE_TEXT_QUARANTINED"] });
      const legacy = await fetch(new URL("analysis/legacy-notes.txt", base));
      expect(legacy.status).toBe(200);
      expect(await legacy.text()).toBe("Synthetic legacy evidence");
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done) => { server!.close(() => done()); });
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
