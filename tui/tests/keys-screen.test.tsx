import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { COMMS_PROVIDERS } from "../../src/comms/connections.js";
import type { TuiKeyStatus, TuiOptions } from "../../src/tui/contract.js";
import { App } from "../src/app.js";
import { KEY, normalizeFrame, renderToText } from "../src/testing/render-to-text.js";

// `c keys and accounts` lists the provider keys `humanish keys` lists, with the line it prints for
// each, and hands the key a person picks to the host's hidden prompt.

/** The lines `humanish keys` prints for this store, from tests/keys/key-status.test.ts. */
const STATUS: TuiKeyStatus[] = [
  {
    name: "E2B_API_KEY",
    set: false,
    line: "E2B_API_KEY (hosted desktops): missing; run `e2b auth login`, or `humanish keys set e2b`",
  },
  {
    name: "OPENAI_API_KEY",
    set: true,
    line: "OPENAI_API_KEY (participant model and analysis): set, from ~/.config/humanish/keys.env",
  },
  {
    name: "GH_TOKEN",
    set: false,
    line: "GH_TOKEN (private repository subjects): missing; run `gh auth login`, or `humanish keys set github`",
  },
  {
    name: "AGENTMAIL_API_KEY",
    set: false,
    line: "AGENTMAIL_API_KEY (email in studies): missing; run `humanish keys set agentmail`",
  },
];

function options(overrides: Partial<TuiOptions> = {}): TuiOptions {
  return {
    cwd: "/projects/example-app",
    version: { cli: "9.9.9" },
    stdin: process.stdin,
    stdout: process.stdout,
    capabilities: {
      keys: { status: async () => STATUS },
      comms: {
        read: async () => ({
          schema: "humanish.comms-setup.v1",
          ok: true,
          configPath: ".humanish/local/comms.yaml",
          providers: COMMS_PROVIDERS,
          connections: [],
          credential: {
            present: false,
            source: null,
            stored: false,
            strict: false,
            explicitlyEmpty: false,
          },
          message: "Checks are local. Authentication has not been verified.",
        }),
        save: async () => ({ ok: true, message: "Connection saved." }),
      },
      readRunIndex: async () => ({
        schema: "humanish.run-index.v1",
        cwd: "/projects/example-app",
        runs: [],
        unreadable: [],
      }),
      listStudies: async () => ({
        schema: "humanish.study-list.v1",
        retired: [],
        ok: true,
        cwd: "/projects/example-app",
        studies: [],
        warnings: [],
      }),
      readProjectState: () => ({
        schema: "humanish.tui-project.v1",
        initialized: true,
        hasRuntime: false,
      }),
      readStudySummary: async () => null,
      readRunDetail: async () => null,
      readLaunchLog: async () => "",
      startRun: async () => ({
        ok: false,
        error: { code: "HUMANISH_LAUNCH_FAILED", message: "not used" },
      }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "" }),
      stopRun: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "" }),
      initProject: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "" }),
      reclaimRun: async () => ({
        schema: "humanish.reclaim-result.v1",
        ok: true,
        state: "clean" as const,
        mode: "kill" as const,
        tagSearch: { status: "done" as const, found: 0 },
        createsInFlight: 0,
        cwd: "/x",
        runId: "r",
        receiptCount: 0,
        outcomes: [],
        warnings: [],
      }),
    },
    ...overrides,
  };
}

async function golden(name: string, frame: string): Promise<void> {
  const file = path.join(import.meta.dirname, "golden", `${name}.txt`);
  const text = normalizeFrame(frame);
  if (process.env.UPDATE_TUI_GOLDENS === "1") await writeFile(file, `${text}\n`);
  expect(text).toBe((await readFile(file, "utf8")).trimEnd());
}

describe("c keys and accounts", () => {
  it.each([80, 45])(
    "lists every provider key with the status humanish keys prints at %i columns",
    async (columns) => {
      const surface = await renderToText(<App options={options()} />, {
        columns,
        until: (frame) => frame.includes("c keys and accounts"),
      });
      try {
        const frame = await surface.press("c", (candidate) => candidate.includes("❯ E2B_API_KEY"));
        await golden(`keys-${columns}`, frame);
        const text = normalizeFrame(frame).replace(/\s+/g, " ");
        for (const row of STATUS) expect(text).toContain(row.line);
        expect(
          normalizeFrame(frame)
            .split("\n")
            .every((line) => line.length <= columns),
        ).toBe(true);
      } finally {
        surface.unmount();
      }
    },
  );

  it("hands the selected key to the host's hidden entry", async () => {
    const keyEntry = vi.fn();
    const surface = await renderToText(<App options={options()} onKeyEntry={keyEntry} />, {
      until: (frame) => frame.includes("c keys and accounts"),
    });
    try {
      await surface.press("c", (frame) => frame.includes("❯ E2B_API_KEY"));
      await surface.press(KEY.down, (frame) => /❯ OPENAI_API_KEY/.test(frame));
      await surface.press(KEY.enter, () => keyEntry.mock.calls.length === 1);
      expect(keyEntry).toHaveBeenCalledExactlyOnceWith({
        action: "provider-key",
        name: "OPENAI_API_KEY",
      });
    } finally {
      surface.unmount();
    }
  });

  it("opens the email connection from its row and comes back to the keys", async () => {
    const surface = await renderToText(<App options={options()} />, {
      until: (frame) => frame.includes("c keys and accounts"),
    });
    try {
      await surface.press("c", (frame) => frame.includes("❯ E2B_API_KEY"));
      for (let index = 0; index < STATUS.length; index += 1) await surface.press(KEY.down);
      const email = await surface.press(KEY.enter, (frame) =>
        frame.includes("AgentMail · hosted email"),
      );
      expect(email).toContain("‹ connections");
      const back = await surface.press(KEY.escape, (frame) => frame.includes("❯ Email connection"));
      expect(back).toContain("‹ keys and accounts");
      await surface.press(KEY.escape, (frame) => frame.includes("No studies here yet."));
    } finally {
      surface.unmount();
    }
  });

  it("reopens on the keys with the host's notice after key entry", async () => {
    const surface = await renderToText(
      <App
        options={options({
          initialScreen: "keys",
          connectionNotice: "E2B_API_KEY stored for every project.",
        })}
      />,
      { until: (frame) => frame.includes("E2B_API_KEY stored for every project.") },
    );
    try {
      expect(surface.last).toContain("‹ keys and accounts");
    } finally {
      surface.unmount();
    }
  });
});
