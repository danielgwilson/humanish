import { isMaxOutputTokens } from "../actors/output-token-limit.js";
import {
  PARTICIPANT_ID_MAX_CHARS,
  PARTICIPANT_ID_PATTERN,
  focusOf,
  rosterOf,
} from "./parse/actors.js";
import { isHttpUrl, isLoopbackUrl } from "./parse/subject.js";
import { declaredTargets } from "./plan-participants.js";
import {
  actorResolvesToComputerUse,
  cuaLaneCount,
  MAX_CUA_LANES,
  registeredComputerUseActors,
  resolveSeatUrl,
  isComputerUseComposition,
  isScriptedBrowserComposition,
  isSharedWorldComposition,
  isTerminalProductComposition,
} from "./routing.js";
import type { LabConfig } from "./types.js";

/**
 * Cross-validate the computer-use fan-out declaration (`per-lane-worlds`). Returns the failure
 * message, or null when valid. Enforced at parse and re-enforced in the engine (runCuaActorLab
 * is itself exported npm surface). Structural roster shape (id/device validity, id uniqueness) is
 * already checked in parseLanes; this is the route-scoped XOR/cap/policy layer.
 */
export function cuaLaneValidationReason(config: LabConfig): string | null {
  const actor = config.actors[0];
  const roster = rosterOf(actor);
  const structuralReason = rosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  // clone.fanout is a declared behavior change: rejected on the cua route (was inert-warned).
  // Fan-out is declared via `actors[0].count` or `actors[0].lanes`; subject.clone.fanout never applied here.
  if (config.subject.clone?.fanout !== undefined) {
    return "`subject.clone.fanout` is not used on the computer-use route: declare fan-out with actors[0].count (homogeneous) or actors[0].lanes (a roster of participants). (No current route reads clone.fanout.)";
  }
  if (roster !== undefined) {
    if (actor?.count !== undefined) {
      return "Declare EITHER actors[0].count (a homogeneous participant count) OR actors[0].lanes (a differentiated roster), not both.";
    }
    if (focusOf(actor) !== undefined) {
      return "actors[0].laneFocus and actors[0].lanes are mutually exclusive: each roster entry's `instruction` is the fan-out steer; laneFocus is the steer for a single participant.";
    }
    if (
      config.execution?.desktop?.resolution !== undefined &&
      roster.some((entry) => entry.device !== undefined)
    ) {
      return "actors[0].lanes[].device and a raw execution.desktop.resolution are mutually exclusive: a per-participant device preset and a single hand-set resolution cannot both govern participant geometry.";
    }
    const targeted = roster.filter((entry) => entry.target !== undefined);
    if (targeted.length > 0) {
      if (config.subject.source !== "app-url") {
        return "actors[0].lanes[].target is supported only on app-url computer-use labs — clone/shared-world/local-app routes provision or own their entry URL by mechanism.";
      }
      if (roster.some((entry) => entry.entry !== undefined)) {
        return "actors[0].lanes[].target and actors[0].lanes[].entry are mutually exclusive: target is an app-url fan-out browser URL; entry is a shared-world same-origin participant path.";
      }
      if (targeted.length !== roster.length) {
        return "When any actors[0].lanes[].target is declared, every participant in the roster must declare target; this keeps the setup-produced target contract explicit and prevents accidental mixed worlds.";
      }
    }
  }
  const participantCount = cuaLaneCount(config);
  if (participantCount > MAX_CUA_LANES) {
    return `Computer-use fan-out is capped at ${MAX_CUA_LANES} participants (declared ${participantCount}); N concurrent paid desktops is real spend, and there is no override above the cap this slice.`;
  }
  // Public targets fan out into N independent worlds driving the same public app, which is an
  // ambiguous shared-world-ish shape, not a per-participant target swarm. Permit N>1 public runs only
  // when every roster entry declares its own target, making the adapter-owned topology explicit. But when
  // `subject.topology: shared-world` is also declared, N participants against one public target is the
  // external-public shared-world topology (#164 phase 2), so route it there (a real public deployment
  // as the shared plane) instead of refusing; externalPublicSharedWorldValidationReason then applies.
  if (
    participantCount > 1 &&
    config.policies?.allowPublicTargets === true &&
    declaredTargets(config).length === 0 &&
    config.subject.topology !== "shared-world"
  ) {
    return "policies.allowPublicTargets cannot be combined with fan-out to more than one participant (N>1): N participants against one declared public target is the SHARED-WORLD topology (layer 7, #164), not `per-lane-worlds`. Declare `subject.topology: shared-world` to run the external-public shared-world route, fan out against a loopback/provisioned subject, or run a single public-target participant.";
  }
  return null;
}

/**
 * Engine-level path-token validation for configs supplied directly through the
 * public TypeScript/JavaScript API instead of parseLabConfig.
 */
function rosterStructuralValidationReason(config: LabConfig): string | null {
  const roster = rosterOf(config.actors[0]);
  const seenIds = new Set<string>();
  if (roster !== undefined) {
    if (!Array.isArray(roster) || roster.length === 0) {
      return "actors[0].lanes must be a non-empty array when set.";
    }
    for (const [index, entry] of roster.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return `actors[0].lanes[${index}] must be an object.`;
      }
      const id = entry.id;
      if (id === undefined) {
        continue;
      }
      if (
        typeof id !== "string" ||
        !PARTICIPANT_ID_PATTERN.test(id) ||
        id.length > PARTICIPANT_ID_MAX_CHARS
      ) {
        return `actors[0].lanes[${index}].id must be a public-safe path token matching ${PARTICIPANT_ID_PATTERN} and at most ${PARTICIPANT_ID_MAX_CHARS} chars.`;
      }
      if (seenIds.has(id)) {
        return `actors[0].lanes ids must be unique (duplicate "${id}").`;
      }
      seenIds.add(id);
    }
  }
  return null;
}

/**
 * Cross-validate a `topology: shared-world` declaration (#164). Returns the failure message, or
 * null when the one shared-world route can run it: the external-public checks for an app-url
 * subject, the provisioned checks otherwise. Enforced at parse and again by the route, since
 * runConcurrentSharedWorld is exported.
 */
export function sharedWorldValidationReason(config: LabConfig): string | null {
  return config.subject.source === "app-url"
    ? externalPublicSharedWorldValidationReason(config)
    : concurrentSharedWorldValidationReason(config);
}

/**
 * The structural checks every provisioned shared world shares. It requires: a clone or local-tree source + e2b-desktop
 * target + a computer-use actor + a `subject.serve` block + an `actors[0].lanes` roster of ≥2 roles (the
 * roster is the role roster; there is no separate roles[] field), and every role `entry` must resolve
 * same-origin (loopback) with serve.url. Fail-closed: a half-declared shared-world is rejected,
 * never silently downgraded.
 */
function provisionedSharedWorldStructureReason(config: LabConfig): string | null {
  const structuralReason = rosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "clone" && config.subject.source !== "local-tree") {
    return "`subject.topology: shared-world` requires `subject.source: clone` or `subject.source: local-tree` - the shared world is ONE provisioned, served, seeded plane (#164).";
  }
  if (config.execution?.target !== "e2b-desktop") {
    return "`subject.topology: shared-world` requires `execution.target: e2b-desktop`: the role participants drive hosted desktop browsers against one in-sandbox app.";
  }
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
    return `\`subject.topology: shared-world\` requires a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}); each role participant runs a computer-use session.`;
  }
  const serve = config.subject.serve;
  if (!serve) {
    return "`subject.topology: shared-world` requires `subject.serve` (start + url) — the lab serves ONE shared app in-sandbox that every role drives.";
  }
  const roster = rosterOf(config.actors[0]);
  if (!roster || roster.length < 2) {
    return "`subject.topology: shared-world` requires an `actors[0].lanes` roster of at least 2 roles (the roster IS the role roster: declare ≥2 participants; a single-role shared world proves no interaction).";
  }
  if (!config.subject.state?.checkpoint || config.subject.state.checkpoint.length === 0) {
    return "`subject.topology: shared-world` requires `subject.state.checkpoint` (≥1 read-only digest probe) — the checkpoint series is how the run shows the shared state changing; without it the run cannot show that participants changed the shared app.";
  }
  for (const entry of roster) {
    if (entry.entry !== undefined && resolveSeatUrl(serve.url, entry.entry) === null) {
      return `actors[0].lanes role "${entry.id ?? "(unnamed)"}".entry must resolve same-origin (loopback) with subject.serve.url (${serve.url}); got "${entry.entry}".`;
    }
  }
  return null;
}

/**
 * Declared capture devices must be implemented by the selected execution route.
 * Unsupported backends pass false when called directly, where the declared
 * topology may not identify the backend that is actually executing.
 */
export function desktopMediaValidationReason(
  config: LabConfig,
  supportsMedia = isComputerUseComposition(config),
): string | undefined {
  if (
    config.execution?.desktop?.recording !== undefined &&
    (!supportsMedia ||
      config.subject.topology === "shared-world" ||
      config.subject.source === "local-app")
  ) {
    return "execution.desktop.recording is supported only for computer-use participants on independent desktops. Remove the declaration or select a supported route.";
  }
  const media = config.execution?.desktop?.media;
  if (media === undefined) return undefined;
  if (media.microphone !== undefined && media.microphone.source !== "speech") {
    return "execution.desktop.media.microphone.source must be speech. Microphone source-file injection is unsupported.";
  }
  if (config.subject.topology === "shared-world") {
    return "execution.desktop.media is unsupported on shared-world routes; declared capture devices would not be provisioned. Use independent computer-use browser participants or remove the declaration.";
  }
  if (
    !supportsMedia ||
    config.subject.source === "desktop-cli" ||
    config.subject.source === "local-app"
  ) {
    return "execution.desktop.media is supported only for computer-use browser participants (app-url, clone or local-tree), not this execution route. Remove the declaration or use a supported route.";
  }
  if (config.execution?.desktop?.browser === "firefox") {
    return "execution.desktop.media requires Chrome or Chromium; Firefox cannot receive the declared synthetic capture device. Set execution.desktop.browser: chrome or chromium.";
  }
  if (media.microphone !== undefined) {
    if (
      config.actors.some(
        (actor) =>
          actor.type !== "local-agent" ||
          (actor.localAgent !== undefined && actor.localAgent !== "codex"),
      )
    ) {
      return "Participant speech currently requires local-agent with Codex, on a local or hosted desktop.";
    }
    if (config.execution?.target !== "local" && media.camera !== undefined) {
      return "Hosted synthetic cameras replace Chromium's microphone and cannot be combined with speech. Use a local media desktop for camera and speech together, or omit the hosted camera.";
    }
  }
  return undefined;
}

/** Reused by direct library runners so unsupported receiving never becomes inert configuration. */
export function receivingEmailValidationReason(config: LabConfig): string | undefined {
  if (config.comms?.email?.kind !== "real") return undefined;
  if (
    !isComputerUseComposition(config) ||
    !["app-url", "clone", "local-tree"].includes(config.subject.source)
  ) {
    return "Real email receiving requires a hosted computer-use browser lab with an app-url, clone, or local-tree subject. Scripted, terminal, desktop-cli and local-app routes are unsupported.";
  }
  if (config.actors.some((actor) => actor.type === "local-agent")) {
    return "Real email receiving is unavailable for local-agent: its host process does not isolate the inbox management credential. Use a hosted first-party computer-use actor.";
  }
  return undefined;
}

/** Refuse task declarations that the selected execution path would discard (#737).
 * Direct runners pass their actual support rather than trusting the config's dispatch shape. */
export function taskProtocolValidationReason(
  config: LabConfig,
  supportsTasks = isComputerUseComposition(config) && !isSharedWorldComposition(config),
): string | null {
  for (const [index, actor] of config.actors.entries()) {
    if (actor.tasks === undefined) continue;
    if (index > 0) {
      return `actors[${index}].tasks is unsupported: current runners consume only actors[0]. Use the first actor's computer-use participants for a task protocol.`;
    }
    if (!supportsTasks) {
      return "actors[0].tasks is unsupported on this execution path. Task protocols require the computer-use route, with one world per participant; shared-world, terminal-product, scripted-browser and synthetic routes do not consume them. Remove tasks only if a mission-only study is intended.";
    }
  }
  return null;
}

/**
 * Refuse a clone subject whose target is not an explicit e2b-desktop. Every clone route clones and
 * serves the repo inside a hosted desktop sandbox, and routeOf sends every clone lab to
 * one, so any other target, or none, would still run on an E2B desktop. Requiring it explicitly
 * also means the parser's clone checks, which run only on e2b-desktop, cannot be skipped. Enforced
 * at parse and again on the computer-use and scripted-browser routes for library callers.
 */
export function cloneTargetValidationReason(config: LabConfig): string | null {
  const target = config.execution?.target;
  if (config.subject.source !== "clone" || target === "e2b-desktop") return null;
  const got = target === undefined ? "it is absent" : `got "${target}"`;
  return `clone subjects require \`execution.target: e2b-desktop\` (${got}): the lab clones and serves the repo inside a hosted desktop sandbox. \`execution.target: local\` applies to app-url and local-app subjects.`;
}

/**
 * Refuse a positive `scenario.caps.maxUsd` or `maxTotalUsd` on a computer-use lab.
 * `scenario.caps` belongs to the terminal route; the computer-use route stops on `execution.caps`,
 * so a dollar figure here would read as a cap while the lab ran uncapped. Zero spends nothing
 * either way and stays a warning. Enforced at parse and again on the computer-use routes for
 * library callers.
 */
export function scenarioCapsValidationReason(config: LabConfig): string | null {
  if (!isComputerUseComposition(config)) return null;
  for (const key of ["maxUsd", "maxTotalUsd"] as const) {
    const value = config.scenario?.caps?.[key];
    if (value === undefined || value <= 0) continue;
    return `scenario.caps.${key} (${value}) does not cap a computer-use lab: this route stops on execution.caps.${key}. Move the value to execution.caps.${key}; scenario.caps applies only to terminal-product labs.`;
  }
  return null;
}

/** Refuse a claimed output bound when the route cannot pass it to the first-party provider. */
export function outputTokenLimitValidationReason(config: LabConfig): string | null {
  const actor = config.actors[0];
  if (actor?.maxOutputTokens === undefined) return null;
  if (!isMaxOutputTokens(actor.maxOutputTokens))
    return "actors[0].maxOutputTokens must be a positive safe integer.";
  if (
    actor.type !== "openai-computer-use" ||
    !isComputerUseComposition(config) ||
    config.subject.source === "local-app"
  ) {
    return "actors[0].maxOutputTokens is supported only by first-party OpenAI computer-use routes; terminal, local-agent, scripted and custom in-process routes cannot enforce it.";
  }
  return null;
}

/**
 * Shared-world participants share one live app, so at least two must be live at once. The
 * sequential shared-world route (`execution.concurrency: 1`) was removed in 0.106.0; the parser
 * fills an omitted concurrency with the participant count. Both callers check it after their
 * two-participant roster floor, so a one-seat roster gets the roster refusal, never this one.
 */
function sharedWorldConcurrencyReason(config: LabConfig): string | null {
  // Direct library callers skip the parser, so an omitted value defaults here exactly as the
  // route does: to the participant count. A missing roster reads as 0 and is refused.
  const participants = rosterOf(config.actors[0])?.length ?? 0;
  const concurrency = config.execution?.concurrency ?? participants;
  if (concurrency >= 2) return null;
  return `shared-world labs need \`execution.concurrency\` of at least 2 (got ${concurrency}). Sequential shared-world turns (concurrency 1) were removed in 0.106.0: omit execution.concurrency to run every participant at once, or set it to 2 or more. A provisioned subject also needs \`subject.exposure: synthetic\` and a \`serve.start\` that binds 0.0.0.0.`;
}

/**
 * Cross-validate a concurrent shared-world declaration (#164 phase 2). Returns the failure message,
 * or null when valid. Includes the base shared-world checks plus the concurrent extras: a synthetic
 * subject attestation, a 0.0.0.0 serve bind (getHost only routes to a port bound on
 * all interfaces), and no `subject.clone.keep`/`subject.localTree.keep` (either would
 * orphan actor sandboxes). Enforced at parse and re-enforced in the engine (runConcurrentSharedWorld
 * is exported npm surface).
 */
export function concurrentSharedWorldValidationReason(config: LabConfig): string | null {
  const base = provisionedSharedWorldStructureReason(config);
  if (base) {
    return base;
  }
  const sharedWorldConcurrency = sharedWorldConcurrencyReason(config);
  if (sharedWorldConcurrency) return sharedWorldConcurrency;
  if (config.subject.exposure !== "synthetic") {
    return "the concurrent shared-world route requires `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data (no real/external data behind a getHost URL).";
  }
  const serve = config.subject.serve;
  if (!serve || !serve.start.includes("0.0.0.0")) {
    return "the concurrent shared-world route requires `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; a loopback-only bind 502s. (The readiness probe stays loopback.)";
  }
  if (config.subject.clone?.keep === true || config.subject.localTree?.keep === true) {
    const keepField =
      config.subject.clone?.keep === true ? "subject.clone.keep" : "subject.localTree.keep";
    return `\`${keepField}\` is not supported on the concurrent shared-world route - it would orphan the N actor sandboxes (reclaimed only by server-timeout, not by id). All N+1 sandboxes are torn down by id.`;
  }
  return null;
}

/**
 * Cross-validate the external-public shared-world declaration (#164 phase 2): a real public
 * deployment used directly as the shared plane (no getHost, no clone, no subject sandbox, no seed).
 * The counterpart of concurrentSharedWorldValidationReason for a plane the harness does not own:
 * it rejects every provisioned-subject field (serve/state.seed/state.checkpoint/exposure/clone/repos
 * are inert with no sandbox, so they fail closed per invariant 6), and requires a
 * non-loopback appUrl + allowPublicTargets + the operator-ownership attestation subject.publicTarget +
 * concurrency >= 2 + an actors[0].lanes roster of ≥2 with exactly one host participant. The getHost synthetic
 * gate is deliberately unreachable here (there is no internet-reachable harness-owned URL to attest).
 * Enforced at parse and re-enforced in the engine (runConcurrentSharedWorld is exported npm surface).
 */
export function externalPublicSharedWorldValidationReason(config: LabConfig): string | null {
  const structuralReason = rosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "app-url") {
    return "the external-public shared-world route requires `subject.source: app-url` — a real public deployment is used directly as the shared plane (no clone, no provisioned subject).";
  }
  if (config.execution?.target !== "e2b-desktop") {
    return "the external-public shared-world route requires `execution.target: e2b-desktop`: the role participants drive hosted desktop browsers against the one public deployment.";
  }
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
    return `the external-public shared-world route requires a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}); each role participant runs a computer-use session.`;
  }
  const roster = rosterOf(config.actors[0]);
  if (!roster || roster.length < 2) {
    return "the external-public shared-world route requires an `actors[0].lanes` roster of at least 2 roles (a single-participant shared world proves no shared session).";
  }
  const sharedWorldConcurrency = sharedWorldConcurrencyReason(config);
  if (sharedWorldConcurrency) return sharedWorldConcurrency;
  if (config.policies?.allowPublicTargets !== true) {
    return "the external-public shared-world route requires `policies.allowPublicTargets: true` — the shared plane is a real non-loopback public deployment.";
  }
  const appUrl = config.subject.appUrl ?? "";
  if (!isHttpUrl(appUrl) || isLoopbackUrl(appUrl)) {
    return "the external-public shared-world route requires a non-loopback http(s) `subject.appUrl` — a loopback URL is not a shared public plane (use the getHost provisioned route for a local subject).";
  }
  // The operator-ownership attestation (the honest analog of exposure: synthetic — you cannot claim
  // synthetic on a real site, but you must attest you own/operate it). Author-trust; unverifiable.
  if (config.subject.publicTarget?.authorized !== true) {
    return "the external-public shared-world route requires `subject.publicTarget: { owner, authorized: true }` — you must attest you own/operate the public deployment used as the shared plane (author-trust; the harness cannot verify ownership).";
  }
  // No provisioned-subject field is allowed: with no sandbox they cannot act, so they are rejected
  // with a precise reason, never silently ignored (invariant 6). exposure: synthetic in particular
  // would be a false claim on a real site (the harness neither provisioned nor exposed it).
  if (config.subject.exposure !== undefined) {
    return "`subject.exposure: synthetic` is forbidden on the external-public shared-world route — you cannot attest a real public deployment is synthetic seeded data; use `subject.publicTarget` to attest ownership instead.";
  }
  if (config.subject.serve !== undefined) {
    return "`subject.serve` is forbidden on the external-public shared-world route — the harness does not serve the plane (it is an already-deployed public app); there is no in-sandbox serve to run.";
  }
  if (
    config.subject.state?.seed !== undefined ||
    config.subject.state?.checkpoint !== undefined ||
    config.subject.state !== undefined
  ) {
    return "`subject.state` (seed/checkpoint/external) is forbidden on the external-public shared-world route — the harness neither seeds nor snapshots the plane (no in-sandbox filesystem to digest); no authoritative shared-state proof is possible on this class.";
  }
  if (config.subject.clone !== undefined || config.subject.repos !== undefined) {
    return "`subject.clone`/`subject.repos` are forbidden on the external-public shared-world route — nothing is cloned; the public deployment IS the plane.";
  }
  if (roster.some((entry) => entry.entry !== undefined)) {
    return "`actors[0].lanes[].entry` (the loopback same-origin participant path) is forbidden on the external-public shared-world route: there is no harness-served serve.url to resolve it against; participants open the public appUrl and reach the shared session through the real UI.";
  }
  const hostEntries = roster.filter((entry) => entry.host === true);
  if (hostEntries.length !== 1) {
    return `the external-public shared-world route requires EXACTLY ONE \`host: true\` participant (the designated host that creates the shared session; got ${hostEntries.length}). The other ≥1 participants are followers that join it.`;
  }
  return null;
}

/** Analysis requires a live recording producer, including supported dry-run previews. */
export function automaticAnalysisRouteReason(config: LabConfig): string | undefined {
  if (config.review?.analysis === undefined || config.review.analysis === false) return undefined;
  if (
    isComputerUseComposition(config) ||
    isScriptedBrowserComposition(config) ||
    isTerminalProductComposition(config) ||
    isSharedWorldComposition(config) ||
    ["app-url", "local-app", "local-tree", "desktop-cli", "terminal-product"].includes(
      config.subject.source,
    )
  )
    return undefined;
  return "review.analysis requires a computer-use, scripted-browser, terminal-product or shared-world lab; this lab's route does not produce an eligible live recording.";
}
