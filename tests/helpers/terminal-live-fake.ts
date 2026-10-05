// A compact fake @e2b/desktop module and mock codex CLI, so the live terminal route runs
// deterministically at $0. Shared by the scorer loader and RunStudyOptions equivalence tests.

import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { parseStudy } from "../../src/study/config.js";
import type { TerminalRunInput } from "../../src/routes/terminal/types.js";
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

export function terminalConfig(extra?: Record<string, unknown>): StudyConfig {
  const raw: Record<string, unknown> = {
    schema: STUDY_SCHEMA,
    id: "terminal-scorer-proof",
    title: "Terminal scorer proof",
    route: "terminal",
    mode: "live",
    subject: {
      source: "terminal-product",
      product: { name: "widget-cli", publicSurfaces: ["https://example.com/widget"] },
    },
    actor: {
      type: "codex-exec",
      persona: "autonomous-creative-agent",
      mission: "Discover widget-cli from public surfaces.",
    },
    caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 },
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    policies: {
      allowPrivateRepoAccess: false,
      allowProviderCredentials: false,
      allowPaymentCredentials: false,
      allowGitHubMutation: false,
    },
    ...extra,
  };
  const parsed = parseStudy(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** A terminal run's typed options and test seams, as a test spreads them into the runner's options. */
export type TerminalTestInputs = Pick<TerminalRunInput, "env" | "scorer" | "deps">;

/** A passing live run; each codex command (which carries the prompt) is pushed to `codexCommands`. */
export function passingRun(
  extra: TerminalTestInputs = {},
  codexCommands: string[] = [],
): TerminalTestInputs {
  const killed: string[] = [];
  return {
    env: extra.env ?? {
      OPENAI_API_KEY: FAKE_RUNTIME_KEY,
      E2B_API_KEY: "FAKE-E2B-KEY-also-do-not-leak-0987654321",
    },
    ...(extra.scorer === undefined ? {} : { scorer: extra.scorer }),
    deps: {
      now: () => 4_000,
      desktopModule: async () =>
        makeFakeModule({
          killed,
          codexBehavior: (cmd) => {
            codexCommands.push(cmd);
            return {
              exitCode: 0,
              stdout: `made a durable widget\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`,
            };
          },
        }),
      ...extra.deps,
    },
  };
}
