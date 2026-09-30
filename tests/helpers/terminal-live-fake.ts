// A compact fake @e2b/desktop module and mock codex CLI, so the live terminal route runs
// deterministically at $0. Shared by the scorer loader and RunLabOptions equivalence tests.

import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { parseLabConfig } from "../../src/lab/config.js";
import type { TerminalProductLabHooks } from "../../src/routes/terminal/types.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

const FAKE_RUNTIME_KEY = "FAKEKEY-scorer-loader-do-not-leak-1234567890";

function makeFakeModule(opts: {
  codexBehavior: (cmd: string) => { exitCode: number; stdout?: string };
  killed: string[];
}): E2BDesktopModule {
  let counter = 0;
  return {
    Sandbox: {
      async create() {
        counter += 1;
        const sandboxId = `fake-sandbox-${counter}`;
        return {
          sandboxId,
          commands: {
            async run(command: string, runOptions?: { onStdout?: (d: string) => void }) {
              if (command.endsWith(" --version"))
                return { exitCode: 0, stdout: "codex-cli 0.153.3\n" };
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command);
                if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return { exitCode: behavior.exitCode };
              }
              if (runOptions?.onStdout) runOptions.onStdout("HUMANISH_SHELL_READY\n");
              return { exitCode: 0, stdout: "HUMANISH_SHELL_READY\n" };
            },
          },
          files: {
            async write() {
              return undefined;
            },
          },
          async launch() {
            return undefined;
          },
          async wait() {
            return undefined;
          },
          async screenshot() {
            return new Uint8Array();
          },
          stream: {
            getAuthKey: () => "fake-auth",
            getUrl: () => "https://fake-stream",
            async start() {
              return undefined;
            },
          },
        };
      },
      async kill(sandboxId: string) {
        opts.killed.push(sandboxId);
        return true;
      },
    },
  } as unknown as E2BDesktopModule;
}

function nonceFrom(command: string): string {
  return /HUMANISH_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command)?.[1] ?? "unknown-nonce";
}

export function terminalConfig(extra?: Record<string, unknown>): LabConfig {
  const raw: Record<string, unknown> = {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-scorer-proof",
    title: "Terminal scorer proof",
    subject: {
      source: "terminal-product",
      product: { name: "widget-cli", publicSurfaces: ["https://example.com/widget"] },
    },
    actors: [
      {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: "Discover widget-cli from public surfaces.",
      },
    ],
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      timeoutMs: 600_000,
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
    policies: {
      allowPrivateRepoAccess: false,
      allowProviderCredentials: false,
      allowPaymentCredentials: false,
      allowGitHubMutation: false,
    },
    ...extra,
  };
  const parsed = parseLabConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

export function passingHooks(extra: Partial<TerminalProductLabHooks>): TerminalProductLabHooks {
  const killed: string[] = [];
  return {
    env: {
      OPENAI_API_KEY: FAKE_RUNTIME_KEY,
      E2B_API_KEY: "FAKE-E2B-KEY-also-do-not-leak-0987654321",
    },
    now: () => 4_000,
    loadModule: async () =>
      makeFakeModule({
        killed,
        codexBehavior: (cmd) => ({
          exitCode: 0,
          stdout: `made a durable widget\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`,
        }),
      }),
    ...extra,
  };
}
