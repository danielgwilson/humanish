/** Types for gate.mjs, which scripts/gate.mjs runs under plain node. */
export interface GateStage {
  name: string;
  command: string[];
}

export interface DeferredCheck {
  name: string;
  reason: string;
}

export interface GatePlan {
  stages: GateStage[];
  deferred: DeferredCheck[];
}

export function planGate(
  changedPaths: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): GatePlan;

export function runGate(options: {
  cwd: string;
  plan: GatePlan;
  write: (text: string) => void;
}): Promise<number>;
