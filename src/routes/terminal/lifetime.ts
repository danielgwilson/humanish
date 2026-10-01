// How long a live terminal sandbox may live. Its server-side timeout has to cover everything that
// runs in it before the codex command, the command's own wall clock (scenario.caps.maxMinutes) and
// the reclamation buffer after that clock's kill. A timeout shorter than that lets E2B kill the
// sandbox before the command's deadline and before the evidence is read.

import { NODE_BOOTSTRAP_TIMEOUT_MS } from "../../subject/node-bootstrap.js";
import { TERMINAL_RUNTIME_VERSION_TIMEOUT_MS } from "./runtime.js";
import { PRODUCT_SETUP_TIMEOUT_MS, TERMINAL_SANDBOX_TIMEOUT_BUFFER_MS } from "./types.js";

/**
 * The most the sandbox runs before the codex command starts: the Node bootstrap, the runtime
 * version check and, when the lab declares `subject.product.install`, the product setup.
 */
export function terminalPreExecBudgetMs(productInstall: boolean): number {
  return (
    NODE_BOOTSTRAP_TIMEOUT_MS +
    TERMINAL_RUNTIME_VERSION_TIMEOUT_MS +
    (productInstall ? PRODUCT_SETUP_TIMEOUT_MS : 0)
  );
}

/** The terminal sandbox's server-side timeout for a codex command bounded at `maxMinutes`. */
export function terminalSandboxTimeoutMs(args: {
  maxMinutes: number;
  productInstall: boolean;
}): number {
  return (
    terminalPreExecBudgetMs(args.productInstall) +
    args.maxMinutes * 60_000 +
    TERMINAL_SANDBOX_TIMEOUT_BUFFER_MS
  );
}
