// @vitest-environment jsdom
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActorTraceItem } from "../../src/actors/contract.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope } from "../../src/run/run.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import type { RunStream } from "../../src/run/streams.js";
import { PASSING_OUTCOME } from "../../tests/helpers/finished-run.js";
import { observerDataFromFeed } from "../lib/data";
import type { ObserverData } from "../lib/observer-data";
import { useObserverFeed } from "../lib/use-observer-feed";
import { decodeInMicrotasks } from "./microtask-gunzip";

// A participant that passes 100,000 items, then a new generation of its live file that scrubs a
// sandbox id the run learned late. Each body is the one the real library server answered for a run
// the real run writer wrote, polled with the cursors the body before it gave. The first body is
// about 15 MB, so the test captures the bodies as it runs instead of reading a golden.
const RUN = "synthetic-feed-item-limit";
const lateId = "synthetic-sandbox-late";
const item = (n: number): ActorTraceItem => ({
  id: `reasoning-${n}`,
  kind: "reasoning",
  lifecycle: "completed",
  title: `reasoning turn ${n}`,
  text: n === 1 ? `The page footer names ${lateId}.` : `Step ${n}.`,
  at: "2026-10-13T08:00:00.000Z",
});
// One list of objects, so each write's slice keeps the objects the writer appended before.
const items = Array.from({ length: 100_002 }, (_, index) => item(index + 1));

let cwd: string, templateRoot: string;
let template: RunBundle;
/** Each poll's `after` parameter, null when it sent none, and the body the server answered. */
let captured: { after: string | null; text: string }[];

/** The template's run with its one stream running, holding `count` items so far. */
function inProgress(count: number): RunBundle {
  const { outcome: _outcome, ...rest } = template;
  const { actor: _actor, trace: _trace, ...stream } = template.streams[0]!;
  const running: RunStream = {
    ...stream,
    status: "running",
    liveActor: {
      schema: "humanish.live-actor.v1",
      updatedAt: "2026-10-13T08:00:09.000Z",
      items: items.slice(0, count),
    },
  };
  return {
    ...rest,
    runId: RUN,
    artifactRoot: path.join(".humanish", "runs", RUN),
    streams: [running],
  };
}

/** The cursors a body gives, as the page sends them back; null when it gives none. */
function cursorsOf(text: string): string | null {
  // Each participant's entry is gzip-compressed JSON in base64.
  const body = JSON.parse(text) as { items: { streams: [string, string][] } };
  const cursors = body.items.streams.flatMap(([, packed]) => {
    const entry = JSON.parse(gunzipSync(Buffer.from(packed, "base64")).toString("utf8")) as {
      live?: string;
    };
    return entry.live === undefined ? [] : [entry.live];
  });
  return cursors.length === 0 ? null : cursors.join(",");
}

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(tmpdir(), "humanish-feed-item-limit-template-"));
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-feed-item-limit-"));
  expect((await runDryRun({ cwd: templateRoot, dryRun: true, runId: "template" })).ok).toBe(true);
  template = JSON.parse(
    await readFile(path.join(templateRoot, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
  captured = [];
  let server: { url: string; close(): Promise<void> } | undefined;
  // The server starts once the run's first write made the run library it serves.
  const poll = async (after: string | null) => {
    if (server === undefined) {
      const started = await serveObserverLibrary(cwd, {
        port: 0,
        safe: false,
        expose: false,
        edgeAuthed: false,
      });
      if (!started.ok) throw new Error(started.error.message);
      server = started.server;
    }
    const url = new URL(`/_humanish/runs/${RUN}/observer/observer-feed.json`, server.url);
    if (after !== null) url.searchParams.set("after", after);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const text = await response.text();
    captured.push({ after, text });
    return text;
  };
  try {
    await runScope(async (scope) => {
      const begun = await scope.startRun({
        cwd,
        runId: RUN,
        mintRunId: () => RUN,
        mode: "dry-run",
        renderReview: (bundle) => `# Review ${bundle.runId}\n`,
      });
      if (!begun.ok) throw new Error(begun.message);
      const run = begun.run;
      await run.writeSnapshot(inProgress(100_000));
      const full = await poll(null);
      await run.writeSnapshot(inProgress(100_001));
      const tail = await poll(cursorsOf(full));
      await appendSandboxReceipt(run.paths, {
        at: "2026-10-13T08:00:10.000Z",
        laneId: "participant-1",
        sandboxId: lateId,
      });
      await run.writeSnapshot(inProgress(100_002));
      const regenerated = await poll(cursorsOf(tail));
      await run.finish(
        { ...template, runId: RUN, artifactRoot: path.join(".humanish", "runs", RUN) },
        PASSING_OUTCOME,
      );
      await poll(cursorsOf(regenerated));
    });
  } finally {
    await server?.close();
  }
}, 120_000);
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(templateRoot, { recursive: true, force: true });
});

decodeInMicrotasks();

let container: HTMLDivElement, root: Root;
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe({ initial }: { initial: ObserverData }) {
  const { data, connection } = useObserverFeed(initial);
  const stream = data?.streams[0];
  const list = stream?.liveActor?.items;
  return (
    <pre data-state={connection.state}>
      {JSON.stringify({
        items: list?.length ?? null,
        rawId: list?.some((entry) => entry.text?.includes(lateId)) ?? null,
        labeled: list?.[0]?.text?.includes("[redacted-sandbox-id ") ?? null,
      })}
    </pre>
  );
}

const shown = () => JSON.parse(container.querySelector("pre")!.textContent!) as unknown;
const state = () => container.querySelector("pre")!.getAttribute("data-state");
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("a served page whose participant passes 100,000 items", () => {
  it("keeps updating through a generation that scrubs a sandbox id", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime("2026-10-13T09:00:00.000Z");
    const answers = captured.map((entry) => entry.text);
    const sent: (string | null)[] = [];
    vi.spyOn(window, "fetch").mockImplementation(async (input) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, "http://localhost/observer/");
      if (url.pathname !== "/observer/observer-feed.json")
        return new Response(null, { status: 404 });
      sent.push(url.searchParams.get("after"));
      return new Response(answers.length > 1 ? answers.shift()! : answers[0]!);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const initial = (await observerDataFromFeed(JSON.parse(captured[0]!.text)))!;
    expect(initial).not.toBeNull();
    await act(async () => {
      root.render(<Probe initial={initial} />);
    });
    await advance(0);
    expect(shown()).toEqual({ items: 100_000, rawId: true, labeled: false });
    expect(state()).toBe("current");
    await advance(5000);
    expect(shown()).toEqual({ items: 100_001, rawId: true, labeled: false });
    expect(state()).toBe("current");
    await advance(5000);
    expect(shown()).toEqual({ items: 100_002, rawId: false, labeled: true });
    expect(state()).toBe("current");
    await advance(5000);
    expect(shown()).toEqual({ items: null, rawId: null, labeled: null });
    // The server answered exactly these requests when the bodies were captured.
    expect(sent).toEqual(captured.map((entry) => entry.after));
  }, 60_000);
});
