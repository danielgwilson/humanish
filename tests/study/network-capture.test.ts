// execution.network turns on each browser participant's network log. It is read only where
// humanish launches Chrome or Chromium for a computer-use participant on its own hosted desktop, so
// every other route refuses it at parse with the field and the reason, and a library caller that
// skips the parser gets the same refusal from the route before any desktop exists.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";
import { libraryConfig } from "../helpers/library-config.js";
import { runComputerUse, runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";

type Manifest = {
  schema: string;
  id: string;
  route: string;
  mode: string;
  subject: Record<string, unknown>;
  actor: { type: string };
  participants?: unknown;
  scenario?: string;
  execution: {
    target: string;
    concurrency?: number;
    desktop?: { browser?: string };
    network?: unknown;
  };
  review: { analysis: boolean };
};

const base: Manifest = {
  schema: STUDY_SCHEMA,
  id: "network-route",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use" },
  execution: { target: "e2b-desktop", network: true },
  review: { analysis: false },
};

function study(change: (manifest: Manifest) => void = () => {}): Manifest {
  const manifest = structuredClone(base);
  change(manifest);
  return manifest;
}

function refusal(manifest: Manifest): string {
  const parsed = parseStudy(manifest);
  if (parsed.ok) throw new Error("the study parsed");
  return parsed.error.message;
}

const SHARED_WORLD = (manifest: Manifest): void => {
  manifest.route = "shared-world";
  manifest.subject = {
    source: "clone",
    repos: ["example-org/collab-app"],
    exposure: "synthetic",
    serve: { start: "npm start -- --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
    state: { checkpoint: [{ name: "count", command: "echo 0" }] },
  };
  manifest.participants = [
    { id: "author", instruction: "Create a note." },
    { id: "reader", instruction: "Read a note." },
  ];
  manifest.execution.concurrency = 2;
};

// Each route that cannot record requests, and words its refusal must say why with.
const routes: Array<[string, (manifest: Manifest) => void, string]> = [
  [
    "the terminal route",
    (manifest) => {
      manifest.route = "terminal";
      manifest.subject = {
        source: "terminal-product",
        product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] },
      };
      manifest.actor.type = "codex-exec";
      manifest.execution.target = "e2b-terminal";
    },
    "launches no browser",
  ],
  [
    "a desktop-cli subject",
    (manifest) => {
      manifest.subject = {
        source: "desktop-cli",
        product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] },
      };
    },
    "opens a terminal",
  ],
  ["a shared world", SHARED_WORLD, "lobby code"],
  [
    "Firefox",
    (manifest) => {
      manifest.execution.desktop = { browser: "firefox" };
    },
    "no DevTools port",
  ],
  [
    "the scripted route",
    (manifest) => {
      manifest.route = "scripted";
      manifest.actor.type = "scripted-browser";
      manifest.execution.target = "local";
      manifest.scenario = "scripted-first-run";
    },
    "route: scripted",
  ],
  [
    "a local desktop",
    (manifest) => {
      manifest.execution.target = "local";
    },
    "execution.target: local",
  ],
];

describe("execution.network in a study file", () => {
  it("turns capture on with true or with origins to keep beside the target's", () => {
    const on = parseStudy(study());
    expect(on.ok && on.config.execution?.network).toBe(true);
    const listed = parseStudy(
      study((manifest) => {
        manifest.execution.network = { origins: ["https://api.example.com"] };
      }),
    );
    expect(listed.ok && listed.config.execution?.network).toEqual({
      origins: ["https://api.example.com"],
    });
    const off = parseStudy(
      study((manifest) => {
        manifest.execution.network = false;
      }),
    );
    expect(off.ok && off.config.execution?.network).toBeUndefined();
  });

  it.each([
    ["a path", "https://api.example.com/v1"],
    ["a query", "https://api.example.com/?key=1"],
    ["user info", "https://user:pass@example.com"],
    ["the ftp scheme", "ftp://files.example.com"],
  ])("refuses an origin with %s", (_label, origin) => {
    const message = refusal(
      study((manifest) => {
        manifest.execution.network = { origins: [origin] };
      }),
    );
    expect(message).toContain("`execution.network.origins`");
    expect(message).toContain("exact http(s) origins");
  });

  it("refuses more than 16 origins", () => {
    const origins = Array.from({ length: 17 }, (_, index) => `https://api${index}.example.com`);
    const message = refusal(
      study((manifest) => {
        manifest.execution.network = { origins };
      }),
    );
    expect(message).toContain("`execution.network.origins`");
    expect(message).toContain("at most 16");
  });

  it("refuses an origin the evidence scan reads as sensitive", () => {
    // A hosted sandbox's address is sensitive text in a run file. Built here, so this file holds
    // none.
    const sandboxOrigin = `https://3000-${"abcdefghij".repeat(2)}.e2b.app`;
    const message = refusal(
      study((manifest) => {
        manifest.execution.network = { origins: [sandboxOrigin] };
      }),
    );
    expect(message).toContain("`execution.network.origins`");
    expect(message).toContain("looks like a secret");
  });

  it.each(routes)("refuses %s, naming the field and the reason", (_label, change, reason) => {
    const baseline = parseStudy(
      study((manifest) => {
        change(manifest);
        delete manifest.execution.network;
      }),
    );
    expect(baseline.ok, baseline.ok ? undefined : baseline.error.message).toBe(true);
    const message = refusal(study(change));
    expect(message).toContain("`execution.network`");
    expect(message).toContain(reason);
  });

  it("is refused by each route a library caller reaches without the parser, before a desktop", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-network-routes-"));
    const desktopModule = vi.fn(async () => {
      throw new Error("must not create a desktop");
    });
    const runSession = vi.fn(async () => {
      throw new Error("must not dispatch a participant");
    });
    const config = (change: (manifest: Manifest) => void) => libraryConfig(study(change));
    try {
      const outcomes = await Promise.all([
        runComputerUse({
          cwd,
          config: config((manifest) => (manifest.execution.desktop = { browser: "firefox" })),
          dryRun: false,
          env: {},
          deps: { desktopModule, runSession },
        }),
        runComputerUse({
          cwd,
          config: config((manifest) => (manifest.execution.target = "local")),
          dryRun: false,
          env: {},
          deps: { desktopModule, runSession },
        }),
        runSharedWorld({
          cwd,
          config: config(SHARED_WORLD),
          dryRun: false,
          env: {},
          deps: { desktopModule, runSession },
        }),
        runScripted({
          cwd,
          config: config(routes[4]![1]),
          dryRun: false,
          env: {},
          deps: { desktopModule },
        }),
        runTerminal({
          cwd,
          config: config(routes[0]![1]),
          dryRun: false,
          env: {},
          deps: { desktopModule },
        }),
      ]);
      for (const result of outcomes) {
        expect(result.ok).toBe(false);
        expect(result.runId).toBe("not-created");
        expect(result.error?.message).toContain("`execution.network`");
      }
      expect(desktopModule).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
