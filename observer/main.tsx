import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/newsreader/wght-italic.css";
import "./styles/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { readInlineObserverData } from "./lib/data";
import type { ObserverData } from "./lib/observer-data";

async function boot(): Promise<void> {
  let data: ObserverData | null = readInlineObserverData(document);

  // Dev only: render the committed contract goldens (?fixture=first-run|oss). The
  // dynamic import is dead-code-eliminated from the production artifact, which the
  // smoke test proves by asserting the fixture's run id never appears in the build.
  if (data === null && import.meta.env.DEV) {
    const { loadDevFixture } = await import("./lib/dev-fixtures");
    data = await loadDevFixture(new URLSearchParams(window.location.search).get("fixture"));
  }

  if (data !== null) {
    document.title = `Humanish Observer — ${data.run.runId}`;
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("observer: #root missing");
  createRoot(root).render(
    <StrictMode>
      <App data={data} />
    </StrictMode>
  );
}

void boot();
