// @ts-check
import { LAB_CONFIG_SCHEMA, parseLabConfig, runLab, stableProgressKey, verifyRun } from "humanish";
import { startLocalApp } from "./app.mjs";

/** @param {string} appUrl @returns {import("humanish").CuaExecutor} */
function createAppContractExecutor(appUrl) {
  return {
    async observe() {
      const response = await fetch(new URL("state", appUrl), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`State read failed: HTTP ${response.status}`);
      const state = await response.json();
      if (typeof state?.greeted !== "boolean" || !Number.isInteger(state?.messages)) {
        throw new Error("Unexpected app state");
      }
      const appState = { greeted: state.greeted, messages: state.messages };
      return { stateSignature: stableProgressKey(appState), appState };
    },
    async execute(action, signal) {
      signal?.throwIfAborted();
      if (action.kind !== "type") throw new Error(`Unsupported app action: ${action.kind}`);
      const response = await fetch(new URL("chat", appUrl), {
        method: "POST",
        body: action.text,
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
      });
      if (!response.ok) throw new Error(`Chat write failed: HTTP ${response.status}`);
    }
  };
}

// A deterministic rule, not an AI participant: no model SDK, requests or credentials.
/** @type {import("humanish").CuaProvider} */
const provider = {
  id: "local-app-deterministic-example",
  version: "1.0.0",
  requiresFrame: false,
  capabilities: {
    headless: true,
    structuredTrace: true,
    lanes: ["computer-use"],
    producesScreenshots: false,
    byoModel: true,
    preGrantableApprovals: false,
    inProcessTools: false,
    license: "open"
  },
  async nextTurn(request, signal) {
    signal.throwIfAborted();
    const greeted = request.observation.appState?.greeted;
    if (typeof greeted !== "boolean") throw new Error("Missing greeted observation");
    return {
      actions: greeted ? [] : [{ kind: "type", text: "hello there" }],
      pendingSafetyChecks: [],
      done: greeted,
      message: greeted ? "The app accepted the greeting." : "Sending a greeting."
    };
  }
};

const app = await startLocalApp();
try {
  // parseLabConfig accepts a decoded OBJECT, not a YAML string.
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "state-driven-local-app-example",
    title: "Deterministic local-app integration example",
    subject: { source: "local-app", appUrl: app.appUrl },
    // This registry id selects the CUA loop. buildProvider supplies the actual provider.
    actors: [{ type: "openai-computer-use", persona: "pixel-pat", mission: "Greet the app." }],
    scenario: { mode: "live" },
    execution: { timeoutMs: 15_000 }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const outcome = await runLab(parsed.config, {
    cwd: process.cwd(),
    dryRun: false,
    cuaHooks: {
      buildExecutor: async ({ appUrl }) => createAppContractExecutor(appUrl),
      buildProvider: async () => provider
    }
  });
  if (outcome.backend !== "cua") throw new Error(`Unexpected backend: ${outcome.backend}`);
  const { result } = outcome;
  const verified = await verifyRun(process.cwd(), result.runId);
  console.log(JSON.stringify({
    runId: result.runId,
    ok: result.ok,
    completionReason: result.session?.completionReason,
    provider: provider.id,
    sandboxCreated: result.sandbox !== undefined,
    screenshots: result.session?.screenshots,
    verification: verified,
    app: app.getReceipt(),
    // A mechanism statement, not an inference from missing provider usage/rates.
    costBasis: "No model calls or hosted resources; only this process and loopback HTTP."
  }, null, 2));
  if (!result.ok || !verified.ok || result.session?.completionReason !== "goal_satisfied"
    || result.sandbox !== undefined || !app.getReceipt().greeted) {
    throw new Error(result.error?.message ?? "Local-app example did not complete and verify");
  }
} finally {
  await app.close();
  console.log(JSON.stringify({ cleanup: app.getReceipt() }));
}
