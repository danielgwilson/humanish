// The registry-facing wrapper for the OpenAI Computer Use (CUA) actor. runComputerUseLoop needs
// fully-constructed provider/executor instances; exposing that raw through the actor registry
// would leak adapter construction to every call site. So runCuaActorSession takes intent-level
// fields and constructs the provider/executor internally — with DI seams (provider/executor/now)
// so CI can drive the real loop with fakes and zero network/zero spend (mirrors how the Claude
// adapter injects its queryFn).
//
// The loop already returns a fully-formed ActorTrace at result.trace, so there is no separate
// toActorTrace mapper — runCuaActorSession returns the CuaLoopResult unchanged.

import type { ActorPersonaRef } from "./actor-contract.js";
import {
  runComputerUseLoop,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaLoopResult,
  type CuaProvider
} from "./computer-use.js";
import {
  createE2BDesktopExecutor,
  type E2BDesktopExecutorOptions,
  type E2BDesktopLike
} from "./e2b-desktop-executor.js";
import {
  createOpenAiResponsesProvider,
  type OpenAiResponsesProviderOptions
} from "./openai-responses-cu.js";
import { defaultRedactionHooks, type RedactionHooks } from "./redaction.js";

export interface CuaActorSessionOptions {
  /** The composed mission (persona + scenario/lane instruction) handed to the model. */
  instructions: string;
  /** Provenance of the persona this actor embodies (id + applied traits + prompt digest). */
  persona: ActorPersonaRef;
  /** Hard wall-clock runaway guard — the only count-free hard stop the loop honors. */
  timeoutMs: number;
  signal?: AbortSignal;

  /** Live provider construction (used when `provider` is not injected). */
  openai?: OpenAiResponsesProviderOptions;
  /** Live executor construction (used when `executor` is not injected). */
  desktop?: E2BDesktopLike;
  executorOptions?: E2BDesktopExecutorOptions;

  /** DI seams — inject to bypass live construction (CI uses these for zero-spend tests). */
  provider?: CuaProvider;
  executor?: CuaExecutor;
  redaction?: RedactionHooks;
  now?: () => number;
  /**
   * Decide which model-flagged safety checks to acknowledge. Omitted here means the loop's own
   * fail-closed default applies (pause on any check). PR scope deliberately does NOT auto-ack.
   */
  acknowledgeSafetyChecks?: (checks: string[]) => string[] | null;
  idleSteps?: number;
  noProgressSteps?: number;
  /** Persist a redacted screenshot, returning the ref path recorded in the trace. */
  writeScreenshot?: (name: string, bytes: Buffer) => Promise<string>;
}

export async function runCuaActorSession(options: CuaActorSessionOptions): Promise<CuaLoopResult> {
  const provider = options.provider ?? buildProvider(options.openai);
  const executor = options.executor ?? buildExecutor(options.desktop, options.executorOptions);

  const loopOptions: CuaLoopOptions = {
    instructions: options.instructions,
    provider,
    executor,
    persona: options.persona,
    redaction: options.redaction ?? defaultRedactionHooks,
    timeoutMs: options.timeoutMs,
    now: options.now ?? (() => Date.now()),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.idleSteps === undefined ? {} : { idleSteps: options.idleSteps }),
    ...(options.noProgressSteps === undefined ? {} : { noProgressSteps: options.noProgressSteps }),
    ...(options.acknowledgeSafetyChecks === undefined ? {} : { acknowledgeSafetyChecks: options.acknowledgeSafetyChecks }),
    ...(options.writeScreenshot === undefined ? {} : { writeScreenshot: options.writeScreenshot })
  };

  return runComputerUseLoop(loopOptions);
}

function buildProvider(openai: OpenAiResponsesProviderOptions | undefined): CuaProvider {
  if (!openai) {
    throw new Error("runCuaActorSession requires either `provider` (injected) or `openai` provider options.");
  }
  return createOpenAiResponsesProvider(openai);
}

function buildExecutor(desktop: E2BDesktopLike | undefined, executorOptions: E2BDesktopExecutorOptions | undefined): CuaExecutor {
  if (!desktop) {
    throw new Error("runCuaActorSession requires either `executor` (injected) or `desktop` to build one.");
  }
  return createE2BDesktopExecutor(desktop, executorOptions ?? {});
}
