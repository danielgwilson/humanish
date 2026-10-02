// The computer-use run's live phase: the in-progress bundle and its live-trace flush, email
// receiving, the participants themselves, and the drain of an operator-hosted inbox.

import { prepareReceivingRun } from "../../comms/receiving-runtime.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { liveObserverResult } from "../../observer/live.js";
import { pricedModel } from "../../lab/plan-base.js";
import { runAllCuaParticipants } from "./participant-execution.js";
import { startLiveTraceFlush } from "./live-flush.js";
import { drainExternalComms } from "./external-comms.js";
import { buildCuaRunBundle, judgeComputerUseRun } from "./bundle.js";
import { participantSubjectEnv, type ParticipantRunOutcome } from "./types.js";
import type { CuaParticipantsSetup, CuaRunSetup } from "./setup.js";

/**
 * Runs the participants (a dry run runs none). Returns the refusal when real email setup fails, or
 * the participant outcomes and the warnings the finish records.
 */
export async function runLabParticipants(setup: CuaRunSetup, participants: CuaParticipantsSetup) {
  const { plan, input, cwd, streams, descriptor, run } = setup;
  const { participantRuns, participantPlan, bundleBase } = setup;
  const { env, knownSecretValues, deps, liveTrace, externalComms, inProgress, fail } = participants;
  const { dryRun } = plan;
  const inProcess = plan.runner.desktop === "in-process";
  const subjectEnvNames = [...participantSubjectEnv(plan.runner.subject)];
  const { runId, paths: runPaths } = run;
  // A live run writes what it is doing as it does it, whether or not anyone is currently watching.
  // This used to be gated on `options.onObserverReady` (the interactive Observer callback), so a
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
      subjects: inProgress.subjects,
      aggregateSubject: inProgress.aggregateSubject,
      subjectProvenance: inProgress.provenance,
      inProgress: true,
    });
    await run.writeSnapshot(inProgressBundle);
    const liveObserver = liveObserverResult(cwd, runId, runPaths.absoluteRunRoot, [
      "Live CUA Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
    ]);
    streams.showIn(liveObserver);
    if (input.onObserverReady) await input.onObserverReady(liveObserver);

    // Incremental live flush: as each participant's loop reports its recorded-so-far items,
    // rewrite the in-progress bundle with per-stream `liveActor` partials so the attached
    // Observer's 5s poll sees the timeline grow. The run refuses any snapshot once the final
    // write began; the route stops the flush timer on every exit below.
    const liveFlush = startLiveTraceFlush({
      bundle: inProgressBundle,
      participantRuns: participantRuns,
      model: pricedModel(plan.runner.brain),
      write: (bundle) => run.writeSnapshot(bundle),
    });
    liveTrace.flush = liveFlush.flush;
    liveTrace.stop = liveFlush.stop;
  }

  const receivingWarnings: string[] = [];
  let receiving: CommsReceivingRun | undefined;
  const { comms } = plan.residual;
  if (!dryRun && comms?.email?.kind === "real") {
    const { envValues } = plan.residual.subject;
    try {
      receiving = await prepareReceivingRun({
        cwd,
        runId,
        config: {
          comms,
          subject: { env: subjectEnvNames, ...(envValues === undefined ? {} : { envValues }) },
        },
        env,
        participants: participantRuns.map((spec) => spec.planned.id),
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
            "HUMANISH_COMPUTER_USE_SUBJECT_INVALID",
            "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
            descriptor.id,
          ),
          runId,
        },
      };
    }
  }
  // Run the participants (dry-run runs none). In-process is always one.
  let outcomes: ParticipantRunOutcome[] | undefined;
  let failFastReason: string | undefined;
  try {
    if (!dryRun)
      ({ outcomes, failFastReason } = await runAllCuaParticipants(
        participantRuns,
        deps,
        participantPlan,
        inProcess,
      ));
  } finally {
    try {
      await receiving?.finish();
    } catch {
      receivingWarnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
    // Stop the flush timer on every exit, including a throw from the participants.
    await liveTrace.stop?.();
  }

  const externalCommsWarnings =
    !dryRun && externalComms && outcomes !== undefined
      ? await drainExternalComms({
          externalCommsConfig: externalComms.config,
          externalCommsEmail: externalComms.email,
          env,
          runPaths,
          participantRuns: participantRuns,
          outcomes,
          knownSecretValues,
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
