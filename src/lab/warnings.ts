import {
  effectiveComputerUseLaneIds,
  routesToComputerUse,
  routesToConcurrentSharedWorld,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "./routing.js";
import type { LabConfig } from "./types.js";

// Report fields that are present but not yet consumed by the engine, so a user never trusts a
// setting that silently does nothing. Keeps the schema forward-correct AND honest.
export function forwardDeclaredWarnings(config: LabConfig): string[] {
  const inert: string[] = [];
  // The computer-use routes consume the actor prompt fields, execution.timeoutMs,
  // execution.desktop.{resolution,sandboxTimeoutMs}, and (clone) subject.{serve,env,state,
  // clone.depth}; the scripted-browser route consumes scenario.ref, actors[0].{persona,count},
  // and execution.timeoutMs (mission/laneFocus/model are inert there: this actor runs no
  // model); on every other route those fields are inert.
  const routesToCua = routesToComputerUse(config);
  const routesToScripted = routesToScriptedBrowser(config);
  const routesToTerminal = routesToTerminalProduct(config);
  const routesToShared = routesToSharedWorld(config);
  const routesToConcurrent = routesToConcurrentSharedWorld(config);
  // The external-public plane (a real public deployment as the shared plane) consumes host lanes +
  // subject.publicTarget; it is only ever the concurrent app-url shape.
  const routesToExternalPublic = routesToConcurrent && config.subject.source === "app-url";
  const routesToHostedCuaBrowser = config.execution?.target === "e2b-desktop" && routesToCua;
  for (const [index, actor] of config.actors.entries()) {
    // Shared-world ONLY fields on the roster: per-role `entry` is inert anywhere else (invariant 6).
    if (actor.lanes?.some((lane) => lane.entry !== undefined) && !routesToShared) {
      inert.push(
        `actors[${index}].lanes[].entry (the per-role loopback entry is a shared-world capability; needs subject.topology: shared-world)`,
      );
    }
    // The host-seat marker acts ONLY on the external-public shared-world route; inert elsewhere.
    if (actor.lanes?.some((lane) => lane.host === true) && !routesToExternalPublic) {
      inert.push(
        `actors[${index}].lanes[].host (the designated host-seat marker; needs the external-public shared-world route: app-url × topology shared-world × allowPublicTargets × concurrency > 1)`,
      );
    }
    if (routesToCua || routesToTerminal) {
      // The cua + terminal routes consume mission/persona/model + laneFocus.instruction (they
      // compose the agent prompt + bundle provenance); laneFocus.id/label remain inert. On the
      // cua E2B route actors[0].lanes is CONSUMED (the fan-out roster).
      if (actor.laneFocus?.id) inert.push(`actors[${index}].laneFocus.id`);
      if (actor.laneFocus?.label) inert.push(`actors[${index}].laneFocus.label`);
      if (routesToTerminal && actor.lanes)
        inert.push(
          `actors[${index}].lanes (fan-out is a computer-use route capability; terminal fan-out is a later slice)`,
        );
    } else if (routesToScripted) {
      // persona and count are consumed (trace/bundle provenance; surface roster). The prompt
      // fields can never act here — the scripted actor runs no model.
      if (actor.mission)
        inert.push(`actors[${index}].mission (the scripted-browser actor runs no model)`);
      if (actor.laneFocus)
        inert.push(`actors[${index}].laneFocus (the scripted-browser actor runs no model)`);
      if (actor.model)
        inert.push(`actors[${index}].model (the scripted-browser actor runs no model)`);
      if (actor.lanes)
        inert.push(
          `actors[${index}].lanes (the scripted-browser route fans out via actors[0].count, not a lane roster)`,
        );
    } else {
      if (actor.mission) inert.push(`actors[${index}].mission`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus`);
      if (actor.persona) inert.push(`actors[${index}].persona`);
      if (actor.model) inert.push(`actors[${index}].model`);
      if (actor.lanes) inert.push(`actors[${index}].lanes`);
    }
  }
  if (config.subject.clone?.depth !== undefined && !routesToCua && !routesToScripted)
    inert.push("subject.clone.depth");
  if (config.subject.serve && !routesToCua && !routesToScripted) inert.push("subject.serve");
  if (config.subject.env && !routesToCua && !routesToScripted) inert.push("subject.env");
  if (config.subject.state && !routesToCua && !routesToScripted) inert.push("subject.state");
  // topology + checkpoint act ONLY on the shared-world route (#164); a set-but-unconsumed value
  // (incl. an explicit per-lane-worlds, which the cua route already is by mechanism) warns inert.
  if (config.subject.topology !== undefined && !routesToShared) {
    inert.push(
      "subject.topology (drives behavior only on the shared-world route; needs subject.topology: shared-world + clone × e2b-desktop × a computer-use actor + a ≥2 lane roster)",
    );
  }
  if (config.subject.state?.checkpoint !== undefined && !routesToShared) {
    inert.push(
      "subject.state.checkpoint (the shared-world state-checkpoint probe; needs subject.topology: shared-world)",
    );
  }
  // publicTarget (the external-public ownership attestation) acts ONLY on the external-public
  // shared-world route; inert elsewhere. (It is already parse-rejected on non-app-url sources.)
  if (config.subject.publicTarget !== undefined && !routesToExternalPublic) {
    inert.push(
      "subject.publicTarget (the external-public ownership attestation; needs the external-public shared-world route: app-url × topology shared-world × allowPublicTargets × concurrency > 1)",
    );
  }
  // exposure (the synthetic-subject attestation) acts ONLY on the CONCURRENT shared-world route
  // (the getHost-exposed plane); inert on the sequential shared-world route (loopback) and elsewhere.
  if (
    config.subject.exposure !== undefined &&
    !routesToConcurrent &&
    !(routesToScripted && config.subject.source === "clone")
  ) {
    inert.push(
      "subject.exposure (the synthetic-subject attestation for a getHost-exposed plane; needs concurrent shared-world or clone × e2b-desktop × scripted-browser)",
    );
  }
  // comms.email drives the in-sandbox email/SMS catch, which needs a subject sandbox HUMANISH
  // provisions (clone or local-tree) so it holds a handle to host the catch. On an app-url /
  // operator-provided subject there is no such handle, so a declared comms block would silently
  // collect nothing — a false green. Warn at parse time (fires on inspect + dry-run too).
  if (
    config.comms?.email?.kind === "fake" &&
    config.comms.email.external === undefined &&
    config.subject.source !== "clone" &&
    config.subject.source !== "local-tree"
  ) {
    inert.push(
      "comms.email (the in-sandbox email/SMS catch needs a harness-provisioned subject to host it — subject.source: clone or local-tree; on an app-url or operator-provided subject humanish holds no sandbox handle. Declare `comms.email.external` to run the catch yourself: humanish then points the persona at your inbox, drains your catch, and writes the same evidence — see #328)",
    );
  }
  // The reverse mis-config: declaring an adopter-hosted catch on a route where humanish provisions
  // the subject itself. Two catches would exist and the app would point at humanish's, so the
  // declared external one would silently collect nothing.
  if (
    config.comms?.email?.external &&
    (config.subject.source === "clone" || config.subject.source === "local-tree")
  ) {
    inert.push(
      "comms.email.external (this subject is harness-provisioned, so humanish hosts the catch itself and injects its URL; an adopter-hosted catch would receive nothing. Drop `external` here, or move the study to an app-url/operator-provisioned subject)",
    );
  }
  // The SEQUENTIAL shared-world route has no comms wiring at all (no catch deploy, no inbox
  // instruction) — a comms block there does nothing, and the actors are never told an inbox
  // exists. Say so at parse time; the concurrent route (the default since #350: all seats live)
  // is the one that hosts the email funnel (#351).
  if (
    config.comms?.email &&
    config.subject.topology === "shared-world" &&
    (config.execution?.concurrency ?? 1) <= 1
  ) {
    inert.push(
      "comms.email (the sequential turn-taking shared-world route has no comms wiring — no catch is deployed and no actor is told an inbox exists; remove `execution.concurrency: 1` so all seats run concurrently, which is the route that hosts the email funnel)",
    );
  }
  // clone.keep IS consumed on the cua route (honored on FAILURE: the sandbox is left up to debug
  // a failed install/boot; otherwise always killed). clone.fanout is REJECTED on the cua route
  // (a hard parse error above), so it can never reach this warning list there.
  if (
    !routesToCua &&
    !routesToScripted &&
    !routesToTerminal &&
    config.execution?.timeoutMs !== undefined
  )
    inert.push("execution.timeoutMs");
  if (config.execution?.completionTimeoutMs !== undefined)
    inert.push("execution.completionTimeoutMs");
  // execution.concurrency is CONSUMED on the cua route (it bounds in-flight fan-out lanes);
  // inert (warned) everywhere else.
  if (config.execution?.concurrency !== undefined && !routesToCua)
    inert.push("execution.concurrency");
  // execution.caps is CONSUMED on the cua route (maxUsd is the fail-closed spend abort); inert
  // (warned) everywhere else so a misplaced budget field is never trusted to cap a route it cannot.
  if (config.execution?.caps && !routesToCua)
    inert.push(
      "execution.caps (the fail-closed spend abort is a computer-use route capability; needs a computer-use actor on e2b-desktop)",
    );
  // terminal-product consumes subject.product, scenario.caps, execution.{terminal,runtimeAuth}:
  // dry-run records the contract; live execution enforces caps and command-scoped auth. On every
  // OTHER route they are inert and must warn so a
  // misplaced safety/budget field is never trusted to do something it cannot (invariant 6).
  if (config.subject.product && !routesToTerminal && config.subject.source !== "desktop-cli")
    inert.push(
      "subject.product (needs subject.source: terminal-product or desktop-cli with the matching actor)",
    );
  if (config.scenario?.caps && !routesToTerminal)
    inert.push(
      "scenario.caps (needs subject.source: terminal-product + a registered terminal actor)",
    );
  // The study-level budget is a CUA-route capability; the terminal route is a single agent whose
  // maxUsd already caps the whole run, so a maxTotalUsd there would be trusted and unenforced.
  if (config.scenario?.caps?.maxTotalUsd !== undefined && routesToTerminal)
    inert.push(
      "scenario.caps.maxTotalUsd (the study-level budget is a computer-use route capability; the terminal route's maxUsd already caps the whole run)",
    );
  if (config.execution?.terminal && !routesToTerminal)
    inert.push(
      "execution.terminal (needs subject.source: terminal-product + a registered terminal actor)",
    );
  if (config.execution?.runtimeAuth !== undefined && !routesToTerminal)
    inert.push(
      "execution.runtimeAuth (needs subject.source: terminal-product + a registered terminal actor)",
    );
  if (config.execution?.runtime !== undefined && !routesToTerminal)
    inert.push(
      "execution.runtime (needs subject.source: terminal-product + a registered terminal actor)",
    );
  // execution.desktop.* stays inert on the scripted route by design: device presets belong to
  // the cua desktop; scripted surfaces are the driver's fixed desktop/mobile viewports, where
  // isMobile/DSF genuinely render via playwright emulation.
  if (!routesToCua && config.execution?.desktop?.resolution)
    inert.push("execution.desktop.resolution");
  if (!routesToCua && config.execution?.desktop?.device !== undefined)
    inert.push("execution.desktop.device");
  if (!routesToHostedCuaBrowser && config.execution?.desktop?.browser !== undefined)
    inert.push("execution.desktop.browser");
  if (!routesToHostedCuaBrowser && config.execution?.desktop?.fidelity !== undefined) {
    inert.push(
      "execution.desktop.fidelity (mobile emulation is applied only to hosted Chromium computer-use lanes on execution.target: e2b-desktop)",
    );
  }
  if (!routesToCua && config.execution?.desktop?.sandboxTimeoutMs !== undefined)
    inert.push("execution.desktop.sandboxTimeoutMs");
  // execution.desktop.template (the custom E2B desktop image) is consumed ONLY where a desktop is
  // actually created via Sandbox.create — the e2b-desktop computer-use routes (cua/shared-world/
  // concurrent). It is INERT on every other route (incl. the in-process local-app cua route, which
  // creates no desktop, and the meta route): warn so an unconsumed template is never silently
  // ignored (invariant 6).
  const createsE2BDesktop =
    (routesToCua || (routesToScripted && config.subject.source === "clone")) &&
    config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.template !== undefined && !createsE2BDesktop) {
    inert.push(
      "execution.desktop.template (the custom E2B desktop image is consumed only on execution.target: e2b-desktop computer-use routes that create a desktop; needs a computer-use actor on e2b-desktop)",
    );
  }
  // codexAppServer is consumed only on the e2b-desktop (meta) route; flag it when it cannot reach there.
  const routesToDesktop =
    config.subject.source === "clone" && config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.codexAppServer !== undefined && !routesToDesktop) {
    inert.push(
      "execution.desktop.codexAppServer (needs subject.source: clone + execution.target: e2b-desktop)",
    );
  }
  // scenario.ref is CONSUMED on the scripted-browser route (required there); forward-declared
  // everywhere else.
  if (config.scenario?.ref && !routesToScripted) inert.push("scenario.ref");
  if (config.scenario?.inline) inert.push("scenario.inline");
  // review.{scoring,milestones,vocabulary} stay forward-declared (reserved for #319) on every route.
  // review.scorer (#316) IS consumed (loaded + wired, or fail-closed at load) on every scorer-capable
  // route, so it does not warn there; on the scripted-browser route the actor carries no scorer seam,
  // so a declared scorer is flagged inert (the run also fails closed at load).
  if (config.review?.scoring)
    inert.push("review.scoring (reserved for a later slice; not yet consumed)");
  if (config.review?.milestones)
    inert.push("review.milestones (reserved for a later slice; not yet consumed)");
  if (config.review?.vocabulary)
    inert.push("review.vocabulary (reserved for a later slice; not yet consumed)");
  if (config.review?.scorer && routesToScripted) {
    inert.push(
      "review.scorer (the scripted-browser actor has no adopter-scorer seam; declare it on a terminal / computer-use / shared-world route)",
    );
  }
  if (config.personas) inert.push("personas");
  const warnings =
    inert.length === 0
      ? []
      : [
          `Forward-declared fields are set but not yet consumed by the engine (planned for a later slice): ${inert.join(", ")}.`,
        ];
  // A declared cap below the seat count is legal but loud: the roster promises N live actors and
  // the cap delivers waves of M. Say so up front (inspect + dry-run + run) — a green run in waves
  // is otherwise indistinguishable from the all-live run the author meant (#350).
  {
    const seats = config.actors[0]?.lanes?.length ?? config.actors[0]?.count ?? 1;
    const cap = config.execution?.concurrency;
    // concurrency: 1 on a shared-world lab is the SEQUENTIAL selector (turn-taking is that
    // route's whole design), not a mistaken throttle — no warning there.
    const sequentialSelector = config.subject.topology === "shared-world" && cap === 1;
    if (routesToCua && cap !== undefined && seats > 1 && cap < seats && !sequentialSelector) {
      warnings.push(
        `execution.concurrency ${cap} caps a ${seats}-seat roster: seats run in waves of ${cap}, never all live at once. Remove execution.concurrency (the default runs all ${seats} seats simultaneously) or set it to ${seats}; declare a lower cap only to bound simultaneous paid desktops.`,
      );
    }
  }
  // Partial email coverage is legal but loud (#351): a lane without an addressed recipient never
  // hears an inbox exists, so an email-gated flow on that seat dead-ends by construction.
  if (routesToCua && config.comms?.email?.recipients) {
    const laneIds = effectiveComputerUseLaneIds(config);
    const covered = new Set(
      config.comms.email.recipients.filter((r) => r.address !== undefined).map((r) => r.lane),
    );
    const uncovered = laneIds.filter((id) => !covered.has(id));
    if (covered.size > 0 && uncovered.length > 0 && laneIds.length > 1) {
      warnings.push(
        `comms.email covers ${covered.size} of ${laneIds.length} lanes; the uncovered lane(s) get no inbox and are never told one exists: ${uncovered.join(", ")}. Add addressed recipients for them if their flows need email.`,
      );
    }
  }
  return warnings;
}
