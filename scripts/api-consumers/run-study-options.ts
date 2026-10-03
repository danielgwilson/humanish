// A library consumer's use of the typed homes, the scorer contract and the bundle, field by field.
// scripts/public-api-proof.mjs typechecks it against the packed package; it never runs. A change
// to the shape of a field used here fails the proof, where the export-name golden would not.
import type {
  AdapterScorerModule,
  ComputerUseExecutor,
  ComputerUseProvider,
  StudyEvent,
  ProviderContext,
  RunAdapterScore,
  RunBundle,
  RunStudyOptions,
} from "humanish";

declare const executor: ComputerUseExecutor;
declare const provider: ComputerUseProvider;

export async function createProvider(ctx: ProviderContext): Promise<ComputerUseProvider> {
  const { config, participant } = ctx;
  const label: string = `${config.id}:${participant.id}:${participant.index}/${participant.count}`;
  if (label.length === 0 || ctx.executor === undefined) throw new Error("unreachable");
  return provider;
}

export function describeEvent(event: StudyEvent): string {
  switch (event.type) {
    case "plan":
      return `${event.route}: ${event.participants
        .map((p) => `${p.id}/${p.persona}/${p.device ?? "-"}/${p.instructionDigest}`)
        .join(", ")}`;
    case "subject-phase": {
      const target = event.target;
      const where =
        target.kind === "subject"
          ? "subject"
          : `${target.participant.id} (${target.participant.index + 1}/${target.participant.count})`;
      const ok: boolean | undefined = event.ok;
      const durationMs: number | undefined = event.durationMs;
      return `${event.at} ${where} ${event.name}: ${event.message} ${ok ?? ""} ${durationMs ?? ""}`;
    }
    case "analysis-started":
    case "analysis-finished":
      return event.type;
  }
}

export const scorer: AdapterScorerModule = {
  score: (ctx): RunAdapterScore => ({
    schema: "humanish.adapter-score.v1",
    namespace: "consumer",
    status: ctx.bundle.review.verdict === "fail" ? "fail" : "pass",
    score: ctx.bundle.streams.length,
    summary: `scored ${ctx.runId}`,
  }),
  deriveFeedback: () => [],
  deriveArtifacts: (ctx) => (ctx.runDir.length > 0 ? [] : []),
};

export const options: RunStudyOptions[] = [
  {
    cwd: ".",
    runId: "consumer",
    dryRun: true,
    env: { OPENAI_API_KEY: undefined },
    scorer,
    prepareDesktop: async (desktop, target) => {
      if (target.kind === "participant" && target.participant.count > 1) await desktop.wait(1);
    },
    onEvent: (event) => {
      process.stderr.write(`${describeEvent(event)}\n`);
    },
    onStream: async (event) => {
      if (event.type === "ready")
        process.stderr.write(`${event.participantId} ${event.sandboxId}\n`);
      else process.stderr.write(`${event.participantId} ${event.streamId} ended\n`);
    },
    analysisSignal: AbortSignal.timeout(60_000),
    createProvider,
    rerun: { sourceRunId: "previous", participantIds: ["lane-02"] },
  },
  {
    cwd: ".",
    inProcess: {
      executor: async ({ config, appUrl }) => {
        if (config.id.length === 0 || appUrl.length === 0) throw new Error("unreachable");
        return executor;
      },
    },
    createProvider,
  },
];

// @ts-expect-error An in-process executor returns no frame, so it needs createProvider.
export const inProcessWithoutProvider: RunStudyOptions = {
  cwd: ".",
  inProcess: { executor: async () => executor },
};

export function summarize(bundle: RunBundle): string[] {
  return [
    bundle.runId,
    bundle.mode,
    bundle.review.verdict,
    bundle.adapterScore?.namespace ?? "no score",
    ...bundle.streams.map((stream) => `${stream.id}: ${stream.status}`),
  ];
}
