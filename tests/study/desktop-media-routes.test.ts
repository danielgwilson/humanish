import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  concurrentSharedWorldValidationReason,
  desktopMediaValidationReason,
} from "../../src/study/validation.js";
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
    desktop: { browser?: string; media?: unknown };
  };
  review: { analysis: boolean };
};

const base: Manifest = {
  schema: STUDY_SCHEMA,
  id: "camera-route",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use" },
  execution: {
    target: "e2b-desktop",
    desktop: { browser: "chrome", media: { camera: { source: "synthetic" } } },
  },
  review: { analysis: false },
};
// The routes that do not read execution.desktop.browser refuse it, so their cases remove it.
const cases: Array<[string, (study: Manifest) => void, string]> = [
  [
    "shared world",
    (c) => {
      c.route = "shared-world";
      c.subject = {
        source: "clone",
        repos: ["example-org/collab-app"],
        exposure: "synthetic",
        serve: { start: "npm start -- --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
        state: { checkpoint: [{ name: "count", command: "echo 0" }] },
      };
      c.participants = [
        { id: "author", instruction: "Create a note." },
        { id: "reader", instruction: "Read a note." },
      ];
      c.execution.concurrency = 2;
    },
    "shared-world routes",
  ],
  [
    "Firefox",
    (c) => {
      c.execution.desktop.browser = "firefox";
    },
    "requires Chrome or Chromium",
  ],
  [
    "desktop CLI",
    (c) => {
      c.subject = {
        source: "desktop-cli",
        product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] },
      };
    },
    "computer-use browser participants",
  ],
  [
    "in-process app",
    (c) => {
      c.subject.source = "local-app";
      c.execution.target = "local";
      delete c.execution.desktop.browser;
    },
    "computer-use browser participants",
  ],
  [
    "scripted browser",
    (c) => {
      c.route = "scripted";
      c.actor.type = "scripted-browser";
      c.execution.target = "local";
      delete c.execution.desktop.browser;
      c.scenario = "scripted-first-run";
    },
    "computer-use browser participants",
  ],
  [
    "terminal",
    (c) => {
      c.route = "terminal";
      c.subject = {
        source: "terminal-product",
        product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] },
      };
      c.actor.type = "codex-exec";
      c.execution.target = "e2b-terminal";
      delete c.execution.desktop.browser;
    },
    "computer-use browser participants",
  ],
];

function changed(change: (study: Manifest) => void, media = true): Manifest {
  const study = structuredClone(base);
  change(study);
  if (!media) delete study.execution.desktop.media;
  return study;
}

describe("declared camera capabilities must reach an implemented route", () => {
  it.each(cases)("rejects %s during manifest parsing", (_label, change, reason) => {
    const study = changed(change);
    const baseline = parseStudy(changed(change, false));
    expect(baseline.ok, baseline.ok ? undefined : baseline.error.message).toBe(true);
    expect(desktopMediaValidationReason(libraryConfig(study))).toContain(reason);
    const parsed = parseStudy(study);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? undefined : parsed.error.message).toContain(reason);
  });

  it("keeps supported Chrome/Chromium and camera-free routes unchanged", () => {
    expect(desktopMediaValidationReason(libraryConfig(base))).toBeUndefined();
    for (const [, change] of cases) {
      expect(desktopMediaValidationReason(libraryConfig(changed(change, false)))).toBeUndefined();
    }
    const study = structuredClone(base);
    study.execution.desktop.browser = "chromium";
    expect(parseStudy(study).ok).toBe(true);
  });

  it("rechecks direct backend calls before desktop creation or participant dispatch", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-media-routes-"));
    const loadDesktopModule = vi.fn(async () => {
      throw new Error("must not create a desktop");
    });
    const runSession = vi.fn(async () => {
      throw new Error("must not dispatch participant");
    });
    const seams = { desktopModule: loadDesktopModule, runSession };
    try {
      const firefox = libraryConfig(changed((c) => (c.execution.desktop.browser = "firefox")));
      // A shared world with no participants list: parseStudy refuses it, and a library caller can
      // still pass it.
      const shared = libraryConfig({ ...structuredClone(base), route: "shared-world" });
      const scripted = libraryConfig(
        changed((c) => {
          c.route = "scripted";
          c.actor.type = "scripted-browser";
        }),
      );
      const terminal = libraryConfig(
        changed((c) => {
          c.route = "terminal";
          c.subject.source = "terminal-product";
        }),
      );
      const outcomes = await Promise.all([
        runComputerUse({ cwd, config: firefox, dryRun: false, env: {}, deps: seams }),
        runComputerUse({
          cwd,
          config: libraryConfig(base),
          dryRun: false,
          env: {},
          deps: seams,
          inProcess: {
            executor: async () => {
              throw new Error("must not build executor");
            },
          },
        }),
        runSharedWorld({
          cwd,
          config: shared,
          dryRun: false,
          env: {},
          deps: { desktopModule: loadDesktopModule, runSession },
        }),
        runScripted({
          cwd,
          config: scripted,
          dryRun: false,
          env: {},
          deps: { desktopModule: loadDesktopModule },
        }),
        runTerminal({
          cwd,
          config: terminal,
          dryRun: false,
          env: {},
          deps: { desktopModule: loadDesktopModule },
        }),
      ]);
      for (const result of outcomes) {
        expect(result.ok).toBe(false);
        expect(result.runId).toBe("not-created");
        expect(result.error?.message).toContain("execution.desktop.media");
      }
      expect(loadDesktopModule).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects camera declarations in the direct shared backend without a topology declaration", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-media-direct-shared-"));
    const config = libraryConfig(
      changed((c) => {
        c.subject = {
          source: "clone",
          repos: ["example-org/collab-app"],
          exposure: "synthetic",
          serve: { start: "npm start -- --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
          state: { checkpoint: [{ name: "count", command: "echo 0" }] },
        };
        c.participants = [
          { id: "author", instruction: "Create a note." },
          { id: "reader", instruction: "Read a note." },
        ];
        c.execution.concurrency = 2;
      }),
    );
    const loadDesktopModule = vi.fn(async () => {
      throw new Error("must not create a desktop");
    });
    const runSession = vi.fn(async () => {
      throw new Error("must not dispatch participant");
    });
    try {
      // The config is valid for a hosted computer-use participant, and all shared-backend
      // structural checks pass. Rejection must come from the actual backend's media support.
      expect(config.route).not.toBe("shared-world");
      expect(desktopMediaValidationReason(config)).toBeUndefined();
      expect(concurrentSharedWorldValidationReason(config)).toBeNull();
      const result = await runSharedWorld({
        cwd,
        config,
        dryRun: false,
        env: {},
        deps: { desktopModule: loadDesktopModule, runSession },
      });
      expect(result.ok).toBe(false);
      expect(result.runId).toBe("not-created");
      expect(result.error?.message).toContain("execution.desktop.media");
      expect(loadDesktopModule).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
