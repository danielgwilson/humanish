import { describe, expect, it } from "vitest";

import type { ShellCallOptions, ShellResult } from "../../src/substrates/shell.js";
import type { SubjectPhaseEvent } from "../../src/subject/steps.js";
import {
  NODE_BOOTSTRAP_COMMAND,
  NODE_BOOTSTRAP_TIMEOUT_MS,
} from "../../src/subject/node-bootstrap.js";
import { runSubjectServePipeline, serveProvisioningBudgetMs } from "../../src/subject/serve.js";

// The serve pipeline's Node bootstrap inside a sandbox, on a fake shell and a fake clock. A step
// reports completion through its status file; a stalled step never writes one.

const NODE_STEP = "subject-runtime-node";
const serve = {
  install: "npm ci",
  start: "npx vite preview --port 3000",
  url: "http://127.0.0.1:3000/",
};

/** A shell whose detached steps finish with the given exit codes, in order; null never finishes. */
function fakeShell(exits: Record<string, Array<number | null>>) {
  const scripts: Record<string, string> = {};
  const launched: string[] = [];
  // Detached steps live under /tmp/humanish-subject/<step>/ (src/substrates/detached.ts).
  const stepOf = (text: string) => /\/tmp\/humanish-subject\/([\w-]+)/.exec(text)?.[1];
  const ok = (stdout = ""): ShellResult => ({ exitCode: 0, stdout, stderr: "" });
  const shell = {
    async run(command: string, _options?: ShellCallOptions): Promise<ShellResult> {
      if (command.startsWith("cat ")) {
        const step = stepOf(command) ?? "";
        const attempt = launched.filter((name) => name === step).length - 1;
        const base = step.replace(/-retry$/, "");
        const code = (exits[base] ?? [0])[step.endsWith("-retry") ? 1 : Math.max(0, attempt)];
        return ok(code === null || code === undefined ? "" : `${code}\n`);
      }
      if (command.includes("curl -sf")) return ok("READY\n");
      return ok();
    },
    async start(command: string): Promise<ShellResult> {
      const step = stepOf(command);
      if (step !== undefined) launched.push(step);
      return ok();
    },
    async writeFile(path: string, data: string | ArrayBuffer): Promise<void> {
      const step = stepOf(path);
      if (step !== undefined) scripts[step] = String(data);
    },
  };
  return { shell, scripts, launched };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

async function run(exits: Record<string, Array<number | null>>) {
  const { shell, scripts, launched } = fakeShell(exits);
  const time = clock();
  const phases: SubjectPhaseEvent[] = [];
  const outcome = await runSubjectServePipeline(shell, {
    serve: { ...serve, installTimeoutMs: 600_000 },
    requestTimeoutMs: 1_000,
    scrub: (text) => text,
    onPhase: (event) => phases.push(event),
    now: time.now,
    sleep: time.sleep,
  }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  return { outcome, scripts, launched, phases, elapsedMs: time.now() };
}

describe("the serve pipeline's Node bootstrap", () => {
  it("installs Node from the pinned archive, with no apt", async () => {
    const { outcome, scripts } = await run({});
    expect(outcome).toBeUndefined();
    expect(scripts[NODE_STEP]).toContain(NODE_BOOTSTRAP_COMMAND);
    expect(scripts[NODE_STEP]).not.toMatch(/apt(-get)?\s/);
  });

  it("gives up on a stalled bootstrap at its own bound, not the lab's install budget", async () => {
    // The bootstrap never finishes, the way an apt refresh hung for ten minutes on a live lane.
    const { outcome, launched, elapsedMs } = await run({ [NODE_STEP]: [null] });
    expect(outcome?.message).toMatch(/needs a Node runtime/);
    expect(elapsedMs).toBeGreaterThanOrEqual(NODE_BOOTSTRAP_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThan(600_000);
    // A timed-out step is not run again, and nothing after it runs.
    expect(launched).toEqual([NODE_STEP]);
  });

  it("runs a bootstrap that exited non-zero once more and goes on", async () => {
    const { outcome, launched, phases } = await run({ [NODE_STEP]: [28, 0] });
    expect(outcome).toBeUndefined();
    expect(launched.slice(0, 2)).toEqual([NODE_STEP, `${NODE_STEP}-retry`]);
    expect(launched).toContain("subject-install");
    expect(
      phases.some(
        (event) => event.type === "cua-lab.subject.runtime-retry.completed" && event.ok === true,
      ),
    ).toBe(true);
  });

  it("counts two bootstrap attempts at their own bound in the provisioning budget", () => {
    const withNode = serveProvisioningBudgetMs({ ...serve, installTimeoutMs: 600_000 }, undefined);
    const withoutNode = serveProvisioningBudgetMs(
      {
        install: "pip install -r requirements.txt",
        start: "python3 app.py",
        url: serve.url,
        installTimeoutMs: 600_000,
      },
      undefined,
    );
    expect(withNode - withoutNode).toBe(2 * NODE_BOOTSTRAP_TIMEOUT_MS);
  });
});
