import { failureTail } from "../evidence/redaction.js";
import { needsNodeRuntime } from "./runtime.js";
import { NODE_BOOTSTRAP_COMMAND, NODE_BOOTSTRAP_TIMEOUT_MS } from "./node-bootstrap.js";
import { runDetachedStep } from "../substrates/detached.js";
import type { Shell } from "../substrates/shell.js";
import {
  emitPhaseCompleted,
  emitPhaseStarted,
  INSTALL_TIMEOUT_MS,
  type SubjectPhaseEvent,
} from "./steps.js";

/**
 * Prepare a CLI study's runtime and, only when declared, its product (#495, #515).
 *
 * The install runs unkeyed and before the session starts, for the same reason the clone route
 * provisions its subject first: what is being studied begins when the participant looks at the
 * screen. Omitting install deliberately studies product installation; Node/npm remain a
 * harness prerequisite so the participant can follow the product's public npm instructions.
 */
export async function provisionDesktopCli(
  shell: Shell,
  args: {
    product: string;
    install?: string;
    requestTimeoutMs: number;
    scrub: (value: string) => string;
    onPhase?: (event: SubjectPhaseEvent) => void;
  },
): Promise<void> {
  const install = args.install;
  const now = (): number => Date.now();
  if (install === undefined || needsNodeRuntime([install])) {
    const startedAt = now();
    emitPhaseStarted(args.onPhase, now, "runtime", "providing Node/npm for the desktop CLI study");
    const bootstrap = await runDetachedStep(shell, {
      name: "desktop-cli-runtime-node",
      command: NODE_BOOTSTRAP_COMMAND,
      cwd: "/home/user",
      timeoutMs: NODE_BOOTSTRAP_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
    });
    emitPhaseCompleted(
      args.onPhase,
      now,
      startedAt,
      "runtime",
      bootstrap.ok,
      bootstrap.ok ? "Node runtime ready" : "Node runtime bootstrap failed",
    );
    if (!bootstrap.ok) {
      throw new Error(`desktop-cli runtime bootstrap failed for "${args.product}"`);
    }
  }
  if (install === undefined) return;
  const startedAt = now();
  emitPhaseStarted(args.onPhase, now, "install", `installing ${args.product} on the desktop`);
  const result = await runDetachedStep(shell, {
    name: "desktop-cli-install",
    command: install,
    cwd: "/home/user",
    timeoutMs: INSTALL_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
  });
  emitPhaseCompleted(
    args.onPhase,
    now,
    startedAt,
    "install",
    result.ok,
    result.ok ? `${args.product} installed` : `installing ${args.product} failed`,
  );
  if (!result.ok) {
    // Fail closed: a participant handed a desktop where the product is not installed would produce
    // a transcript about a missing command, and that finding belongs to the harness, not the tool.
    // The tail rides along, scrubbed before truncation like every other provisioning failure — a
    // bare "install failed" is unactionable to whoever wrote the command.
    throw new Error(
      args.scrub(
        `desktop-cli install failed for "${args.product}" (${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`}): ${failureTail(args.scrub(result.logTail))}`,
      ),
    );
  }
}
