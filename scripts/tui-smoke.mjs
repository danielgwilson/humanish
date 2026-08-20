// Load the BUILT TUI bundle and render one real frame (#455).
//
// Unit tests cover the CLI's refusals with a fake module; they cannot catch what actually breaks in
// a bundled Ink app, which is everything that happens at load: a CommonJS dependency that needs a
// real `require`, an optional peer left as a bare import, a WASM layout engine that did not get
// inlined. Every one of those produces a bundle that builds cleanly, passes every unit test, and
// crashes the first time a person runs `npx humanish tui`.
//
// So this executes the shipped artifact the way a user's machine will, in-process with fake TTY
// streams, and asserts a frame containing real content came out.

import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const bundle = pathToFileURL(path.resolve("dist/tui-app.js"));
const { startTui } = await import(bundle.href);

if (typeof startTui !== "function") {
  throw new Error("tui bundle does not export startTui — the build produced the wrong shape.");
}

// Ink enables raw mode on mount, so the fake stdin has to look like a real TTY or `useInput`
// refuses. This is exactly the surface the command guarantees before it ever loads the bundle.
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => stdin;
stdin.unref = () => stdin;

const frames = [];
const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 80;
stdout.rows = 24;
const realWrite = stdout.write.bind(stdout);
stdout.write = (chunk, ...rest) => {
  frames.push(String(chunk));
  return realWrite(Buffer.from([]), ...rest.filter((value) => typeof value === "function"));
};

const cwd = await mkdtemp(path.join(tmpdir(), "humanish-tui-smoke-"));
try {
  const exitCode = await startTui({
    cwd,
    version: { cli: "0.0.0-smoke" },
    capabilities: {
      // An empty project: the surface must render its ordinary empty state, not an error.
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd, runs: [], unreadable: [] }),
        listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd, labs: [], warnings: [] }),
      readRunDetail: async () => null,
      readLabSummary: async () => null,
      readProjectState: () => ({ schema: "humanish.tui-project.v1", initialized: false, hasRuntime: false })
    },
    stdin,
    stdout,
    exitAfterFirstFrame: true
  });

  const output = frames.join("");
  const expectations = [
    ["the product name", "humanish"],
    // A bare temp directory is NOT a humanish project, and the surface has to say that rather than
    // "no labs here" — which someone in the wrong directory cannot act on.
    ["the empty state", "not a humanish project"],
    ["the next step", "humanish init"],
    ["the key hints", "q quit"]
  ];
  for (const [what, needle] of expectations) {
    if (!output.includes(needle)) {
      throw new Error(`tui smoke: rendered frame is missing ${what} (${JSON.stringify(needle)}).`);
    }
  }
  if (exitCode !== 0) {
    throw new Error(`tui smoke: expected a clean exit, got ${exitCode}.`);
  }
  console.log(`tui smoke ok: bundle mounted, rendered ${output.length} bytes, exited ${exitCode}`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
