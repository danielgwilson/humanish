// The computer-use run's live phase: the in-progress bundle and its live-trace flush, email
// receiving, the lanes themselves, and the drain of an operator-hosted inbox.

import { prepareReceivingRun } from "../../comms/receiving-runtime.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { liveObserverResult } from "../../observer/live.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { runAllCuaLanes } from "./lanes.js";
import { startLiveTraceFlush } from "./live-flush.js";
import { drainExternalComms } from "./external-comms.js";
import { buildCuaRunBundle, judgeComputerUseRun } from "./assemble.js";
import { type LaneRunOutcome } from "./types.js";
import type { CuaRunSetup } from "./setup.js";

/**
 * Runs the lanes (a dry run runs none). Returns the refusal when real email setup fails, or the
 * lane outcomes and the warnings the finish records.
 */
export async function runLabLanes(setup: CuaRunSetup) {
  const {
    routePlan,
    input,
    config,
    dryRun,
    cwd,
    streams,
    env,
    inProcessRoute,
    fail,
    descriptor,
    externalCommsConfig,
    externalCommsEmail,
    laneSpecs,
    plan,
    knownSecretValues,
    scrubKnownValues,
    subjectEnvNames,
    run,
    runId,
    artifactRoot,
    runPaths,
    deps,
    liveTrace,
    inProgressLaneSubjects,
    inProgressAggregateSubject,
    inProgressProvenance,
    bundleBase,
  } = setup;
  // A live run writes what it is doing AS IT DOES IT, whether or not anyone is currently watching.
  // This used to be gated on `options.onObserverReady` — the interactive Observer callback — so a
  // run launched by an agent (`lab run --json`), detached, or from the terminal surface recorded
  // nothing at all until it completed, and anything asking "what is this participant doing right
  // now" got silence for the whole run. Who reads the evidence is not the run's business; the
  // callback below stays conditional, the writing does not.
  if (!dryRun) {
    const inProgressBundle = buildCuaRunBundle(bundleBase, {
      judgment: judgeComputerUseRun(bundleBase, {
        dryRun: false,
        outcomes: undefined,
        inProgress: true,
      }),
      dryRun: false,
      outcomes: undefined,
      laneSubjects: inProgressLaneSubjects,
      aggregateSubject: inProgressAggregateSubject,
      subjectProvenance: inProgressProvenance,
      inProgress: true,
    });
    await run.writeSnapshot(inProgressBundle);
    const liveObserver = liveObserverResult(cwd, runId, artifactRoot, [
      "Live CUA Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
    ]);
    streams.showIn(liveObserver);
    if (input.onObserverReady) await input.onObserverReady(liveObserver);

    // Incremental live flush (#441): as each lane's loop reports its recorded-so-far items,
    // rewrite the in-progress bundle with per-stream `liveActor` partials so the attached
    // Observer's 5s poll sees the timeline grow. The run refuses any snapshot once the final
    // write began; the route stops the flush timer on every exit below.
    const liveFlush = startLiveTraceFlush({
      bundle: inProgressBundle,
      laneSpecs,
      model: config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL,
      write: (bundle) => run.writeSnapshot(bundle),
    });
    liveTrace.flush = liveFlush.flush;
    liveTrace.stop = liveFlush.stop;
  }

  const receivingWarnings: string[] = [];
  let receiving: CommsReceivingRun | undefined;
  const { comms } = routePlan.residual;
  if (!dryRun && comms?.email?.kind === "real") {
    const { envValues } = routePlan.residual.subject;
    try {
      receiving = await prepareReceivingRun({
        cwd,
        runId,
        config: {
          comms,
          subject: { env: subjectEnvNames, ...(envValues === undefined ? {} : { envValues }) },
        },
        env,
        participants: laneSpecs.map((spec) => spec.planned.id),
        runPaths,
        registerSecrets: (values) => {
          for (const value of values)
            if (value.length >= 4 && !knownSecretValues.includes(value))
              knownSecretValues.push(value);
        },
      });
      if (receiving) deps.receiving = receiving;
    } catch {
      await liveTrace.stop?.();
      // The run exists by now, so the refusal names it rather than "not-created".
      return {
        ok: false as const,
        result: {
          ...fail(
            "HUMANISH_CUA_LAB_SUBJECT_INVALID",
            "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
            descriptor.id,
          ),
          runId,
        },
      };
    }
  }
  // Run lanes (dry-run runs none). In-process is always one lane.
  let outcomes: LaneRunOutcome[] | undefined;
  let failFastReason: string | undefined;
  try {
    if (!dryRun)
      ({ outcomes, failFastReason } = await runAllCuaLanes(laneSpecs, deps, plan, inProcessRoute));
  } finally {
    try {
      await receiving?.finish();
    } catch {
      receivingWarnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
    // Stop the flush timer on every exit, including a throw from the lanes.
    await liveTrace.stop?.();
  }

  const externalCommsWarnings =
    !dryRun && externalCommsConfig && externalCommsEmail && outcomes !== undefined
      ? await drainExternalComms({
          externalCommsConfig,
          externalCommsEmail,
          env,
          runPaths,
          laneSpecs,
          outcomes,
          scrubKnownValues,
        })
      : [];

  return {
    ok: true as const,
    outcomes,
    failFastReason,
    receiving,
    receivingWarnings,
    externalCommsWarnings,
  };
}
