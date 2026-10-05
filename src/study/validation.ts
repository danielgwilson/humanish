import { isMaxOutputTokens } from "../actors/output-token-limit.js";
import {
  PARTICIPANT_ID_MAX_CHARS,
  PARTICIPANT_ID_PATTERN,
  focusOf,
  rosterOf,
} from "./parse/actors.js";
import { isHttpUrl, isLoopbackUrl } from "./parse/subject.js";
import { urlCredentialReason } from "./parse/url-credentials.js";
import { declaredTargets } from "./plan-participants.js";
import {
  actorResolvesToComputerUse,
  computerUseParticipantCount,
  MAX_COMPUTER_USE_PARTICIPANTS,
  registeredComputerUseActors,
  resolveEntryUrl,
  isComputerUseComposition,
  isScriptedBrowserComposition,
  isSharedWorldComposition,
  isTerminalProductComposition,
} from "./routing.js";
import type { StudyConfig } from "./types.js";

/**
 * Cross-validate the computer-use fan-out declaration (`per-lane-worlds`). Returns the failure
 * message, or null when valid. The parser enforces it, and runStudyWith checks it again for a config
 * that skipped the parser. It runs rosterStructuralValidationReason (id and device
 * validity, unique ids) first, then the route-scoped XOR, cap and policy checks.
 */
export function computerUseValidationReason(config: StudyConfig): string | null {
  const actor = config.actors[0];
  const roster = rosterOf(actor);
  const structuralReason = rosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  // clone.fanout is a declared behavior change: rejected on the computer-use route (was
  // inert-warned). Fan-out is declared via `actors[0].count` or `actors[0].lanes`;
  // subject.clone.fanout never applied here.
  if (config.subject.clone?.fanout !== undefined) {
    return "`subject.clone.fanout` is not used on the computer-use route: declare fan-out with actors[0].count (homogeneous) or actors[0].lanes (a roster of participants). (No current route reads clone.fanout.)";
  }
  if (roster !== undefined) {
    if (actor?.count !== undefined) {
      return "Set either `actors[0].count` (identical participants) or `actors[0].lanes` (a roster of distinct participants), not both.";
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
        return "`actors[0].lanes[].target` works only on app-url computer-use studies. Clone, shared-world and local-app studies set each participant's entry URL themselves; remove `target`.";
      }
      if (roster.some((entry) => entry.entry !== undefined)) {
        return "actors[0].lanes[].target and actors[0].lanes[].entry are mutually exclusive: target is an app-url fan-out browser URL; entry is a shared-world same-origin participant path.";
      }
      if (targeted.length !== roster.length) {
        return "When any actors[0].lanes[].target is declared, every participant in the roster must declare target; this keeps the setup-produced target contract explicit and prevents accidental mixed worlds.";
      }
    }
  }
  const participantCount = computerUseParticipantCount(config);
  if (participantCount > MAX_COMPUTER_USE_PARTICIPANTS) {
    return `A computer-use study runs at most ${MAX_COMPUTER_USE_PARTICIPANTS} participants, and this one declares ${participantCount}. Each participant is a paid desktop and they all run at once, so no setting raises the cap; split the roster across studies.`;
  }
  // Public targets fan out into N independent worlds driving the same public app, which is an
  // ambiguous shared-world-ish shape, not a per-participant target swarm. Permit N>1 public runs only
  // when every roster entry declares its own target, making the adapter-owned topology explicit. But when
  // `subject.topology: shared-world` is also declared, N participants against one public target is the
  // external-public shared-world topology, so route it there (a real public deployment
  // as the shared plane) instead of refusing; externalPublicSharedWorldValidationReason then applies.
  if (
    participantCount > 1 &&
    config.policies?.allowPublicTargets === true &&
    declaredTargets(config).length === 0 &&
    config.subject.topology !== "shared-world"
  ) {
    return "`policies.allowPublicTargets` with more than one participant sends them all to one public app, which is a shared world. Set `subject.topology: shared-world` to run them together there, give each `actors[0].lanes[]` entry its own `target`, or run one participant.";
  }
  return null;
}

/**
 * Engine-level path-token validation for configs supplied directly through the
 * public TypeScript/JavaScript API instead of parseStudy.
 */
function rosterStructuralValidationReason(config: StudyConfig): string | null {
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
 * Cross-validate a `topology: shared-world` declaration. Returns the failure message, or
 * null when the one shared-world route can run it: the external-public checks for an app-url
 * subject, the provisioned checks otherwise. Enforced at parse and again by the route, since
 * runStudyWith takes a config that skipped the parser.
 */
export function sharedWorldValidationReason(config: StudyConfig): string | null {
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
function provisionedSharedWorldStructureReason(config: StudyConfig): string | null {
  const structuralReason = rosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "clone" && config.subject.source !== "local-tree") {
    return "`subject.topology: shared-world` needs `subject.source: clone` or `local-tree`, which humanish serves as one seeded app every participant uses, or `app-url` for a public deployment you own.";
  }
  if (config.execution?.target !== "e2b-desktop") {
    return "`subject.topology: shared-world` requires `execution.target: e2b-desktop`: the role participants drive hosted desktop browsers against one in-sandbox app.";
  }
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
    return `\`subject.topology: shared-world\` requires a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}); each role participant runs a computer-use session.`;
  }
  const serve = config.subject.serve;
  if (!serve) {
    return "`subject.topology: shared-world` needs `subject.serve` (start and url): humanish starts one copy of the app in the sandbox, and every participant uses it.";
  }
  const roster = rosterOf(config.actors[0]);
  if (!roster || roster.length < 2) {
    return "`subject.topology: shared-world` needs an `actors[0].lanes` roster of at least 2 participants: with one participant there is nobody to interact with.";
  }
  if (!config.subject.state?.checkpoint || config.subject.state.checkpoint.length === 0) {
    return "`subject.topology: shared-world` needs at least one read-only `subject.state.checkpoint` probe: the checkpoints are how the run shows that participants changed the shared app.";
  }
  for (const entry of roster) {
    if (entry.entry !== undefined && resolveEntryUrl(serve.url, entry.entry) === null) {
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
  config: StudyConfig,
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
export function receivingEmailValidationReason(config: StudyConfig): string | undefined {
  if (config.comms?.email?.kind !== "real") return undefined;
  if (
    !isComputerUseComposition(config) ||
    !["app-url", "clone", "local-tree"].includes(config.subject.source)
  ) {
    return "Real email receiving requires a hosted computer-use browser study with an app-url, clone, or local-tree subject. Scripted, terminal, desktop-cli and local-app routes are unsupported.";
  }
  if (config.actors.some((actor) => actor.type === "local-agent")) {
    return "Real email receiving is unavailable for local-agent: its host process does not isolate the inbox management credential. Use a hosted first-party computer-use actor.";
  }
  return undefined;
}

/** Refuse task declarations that the selected execution path would discard.
 * Direct runners pass their actual support rather than trusting the config's dispatch shape. */
export function taskProtocolValidationReason(
  config: StudyConfig,
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
 * serves the repo inside a hosted desktop sandbox, and routeOf sends every clone study to
 * one, so any other target, or none, would still run on an E2B desktop. Requiring it explicitly
 * also means the parser's clone checks, which run only on e2b-desktop, cannot be skipped. Enforced
 * at parse and again on the computer-use and scripted-browser routes for library callers.
 */
export function cloneTargetValidationReason(config: StudyConfig): string | null {
  const target = config.execution?.target;
  if (config.subject.source !== "clone" || target === "e2b-desktop") return null;
  const got = target === undefined ? "it is absent" : `got "${target}"`;
  return `clone subjects require \`execution.target: e2b-desktop\` (${got}): humanish clones and serves the repo inside a hosted desktop sandbox. \`execution.target: local\` applies to app-url and local-app subjects.`;
}

/**
 * Refuse a positive `scenario.caps.maxUsd` or `maxTotalUsd` on a computer-use study.
 * `scenario.caps` belongs to the terminal route; the computer-use route stops on `execution.caps`,
 * so a dollar figure here would read as a cap while the study ran uncapped. Zero spends nothing
 * either way and stays a warning. Enforced at parse and again on the computer-use routes for
 * library callers.
 */
export function scenarioCapsValidationReason(config: StudyConfig): string | null {
  if (!isComputerUseComposition(config)) return null;
  for (const key of ["maxUsd", "maxTotalUsd"] as const) {
    const value = config.scenario?.caps?.[key];
    if (value === undefined || value <= 0) continue;
    return `scenario.caps.${key} (${value}) does not cap a computer-use study: this route stops on execution.caps.${key}. Move the value to execution.caps.${key}; scenario.caps applies only to terminal-product studies.`;
  }
  return null;
}

/** Refuse a claimed output bound when the route cannot pass it to the first-party provider. */
export function outputTokenLimitValidationReason(config: StudyConfig): string | null {
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
 * two-participant roster floor, so a one-participant roster gets the roster refusal, never this
 * one.
 */
function sharedWorldConcurrencyReason(config: StudyConfig): string | null {
  // Direct library callers skip the parser, so an omitted value defaults here exactly as the
  // route does: to the participant count. A missing roster reads as 0 and is refused.
  const participants = rosterOf(config.actors[0])?.length ?? 0;
  const concurrency = config.execution?.concurrency ?? participants;
  if (concurrency >= 2) return null;
  return `shared-world studies need \`execution.concurrency\` of at least 2 (got ${concurrency}). Sequential shared-world turns (concurrency 1) were removed in 0.106.0: omit execution.concurrency to run every participant at once, or set it to 2 or more. A provisioned subject also needs \`subject.exposure: synthetic\` and a \`serve.start\` that binds 0.0.0.0.`;
}

/**
 * Cross-validate a concurrent shared-world declaration. Returns the failure message,
 * or null when valid. Includes the base shared-world checks plus the concurrent extras: a synthetic
 * subject attestation, a 0.0.0.0 serve bind (getHost only routes to a port bound on
 * all interfaces), and no `subject.clone.keep`/`subject.localTree.keep` (either would
 * orphan actor sandboxes). Enforced at parse and re-enforced in the engine (runStudyWith
 * takes a config that skipped the parser).
 */
export function concurrentSharedWorldValidationReason(config: StudyConfig): string | null {
  const base = provisionedSharedWorldStructureReason(config);
  if (base) {
    return base;
  }
  const sharedWorldConcurrency = sharedWorldConcurrencyReason(config);
  if (sharedWorldConcurrency) return sharedWorldConcurrency;
  if (config.subject.exposure !== "synthetic") {
    return "A shared-world study needs `subject.exposure: synthetic`. The subject is reachable from the internet at a public sandbox URL during the run, so the study must declare that its data is synthetic and seeded.";
  }
  const serve = config.subject.serve;
  if (!serve || !serve.start.includes("0.0.0.0")) {
    return "A shared-world study needs `subject.serve.start` to listen on all interfaces (for example `-H 0.0.0.0`, `--host 0.0.0.0` or `HOST=0.0.0.0`): the public sandbox URL reaches only a port bound to 0.0.0.0, and a loopback-only server answers 502. The readiness probe still uses loopback.";
  }
  if (config.subject.clone?.keep === true || config.subject.localTree?.keep === true) {
    const keepField =
      config.subject.clone?.keep === true ? "subject.clone.keep" : "subject.localTree.keep";
    return `\`${keepField}\` is not supported on the concurrent shared-world route - it would orphan the N actor sandboxes (reclaimed only by server-timeout, not by id). All N+1 sandboxes are torn down by id.`;
  }
  return null;
}

/**
 * Cross-validate the external-public shared-world declaration: a real public
 * deployment used directly as the shared plane (no getHost, no clone, no subject sandbox, no seed).
 * The counterpart of concurrentSharedWorldValidationReason for a plane the harness does not own:
 * it rejects every provisioned-subject field (serve/state.seed/state.checkpoint/exposure/clone/repos
 * are inert with no sandbox, so they fail closed), and requires a
 * non-loopback appUrl + allowPublicTargets + the operator-ownership attestation subject.publicTarget +
 * concurrency >= 2 + an actors[0].lanes roster of ≥2 with exactly one host participant. The getHost synthetic
 * gate is deliberately unreachable here (there is no internet-reachable harness-owned URL to attest).
 * Enforced at parse and re-enforced in the engine (runStudyWith takes a config that skipped the parser).
 */
export function externalPublicSharedWorldValidationReason(config: StudyConfig): string | null {
  const structuralReason = rosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "app-url") {
    return "An external-public shared-world study needs `subject.source: app-url`: the participants share a public deployment you already run, so there is nothing to clone or serve.";
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
    return "An external-public shared-world study needs `policies.allowPublicTargets: true`, because the participants drive a public deployment.";
  }
  const appUrl = config.subject.appUrl ?? "";
  if (!isHttpUrl(appUrl) || isLoopbackUrl(appUrl)) {
    return "An external-public shared-world study needs a public http(s) `subject.appUrl`, not a loopback URL. For an app you run locally, use a clone or local-tree subject, which humanish serves itself.";
  }
  const credential = urlCredentialReason("subject.appUrl", appUrl);
  if (credential) return credential;
  // The operator-ownership attestation (the counterpart of exposure: synthetic; you cannot claim
  // synthetic on a real site, but you must attest you own/operate it). Author-trust; unverifiable.
  if (config.subject.publicTarget?.authorized !== true) {
    return "An external-public shared-world study needs `subject.publicTarget: { owner, authorized: true }` to declare that you own or operate the public deployment. humanish cannot check ownership, so the study states it.";
  }
  // No provisioned-subject field is allowed: with no sandbox they cannot act, so they are rejected
  // with a precise reason, never silently ignored. exposure: synthetic in particular
  // would be a false claim on a real site (the harness neither provisioned nor exposed it).
  if (config.subject.exposure !== undefined) {
    return "`subject.exposure: synthetic` does not apply to an external-public shared-world study: a real public deployment is not seeded synthetic data. Declare ownership with `subject.publicTarget` instead.";
  }
  if (config.subject.serve !== undefined) {
    return "`subject.serve` does not apply to an external-public shared-world study: the app is already deployed, so humanish serves nothing. Remove `subject.serve`.";
  }
  if (
    config.subject.state?.seed !== undefined ||
    config.subject.state?.checkpoint !== undefined ||
    config.subject.state !== undefined
  ) {
    return "`subject.state` (seed, checkpoint or external) does not apply to an external-public shared-world study: humanish cannot seed or read a deployment it does not run. Remove `subject.state`.";
  }
  if (config.subject.clone !== undefined || config.subject.repos !== undefined) {
    return "`subject.clone` and `subject.repos` do not apply to an external-public shared-world study: the participants use the public deployment, so nothing is cloned. Remove them.";
  }
  if (roster.some((entry) => entry.entry !== undefined)) {
    return "`actors[0].lanes[].entry` (the loopback same-origin participant path) is forbidden on the external-public shared-world route: there is no harness-served serve.url to resolve it against; participants open the public appUrl and reach the shared session through the real UI.";
  }
  const hostEntries = roster.filter((entry) => entry.host === true);
  if (hostEntries.length !== 1) {
    return `An external-public shared-world study needs exactly one \`host: true\` participant, the one who creates the shared session, and this study has ${hostEntries.length}. Every other participant joins that session.`;
  }
  return null;
}

/** Analysis requires a live recording producer, including supported dry-run previews. */
export function automaticAnalysisRouteReason(config: StudyConfig): string | undefined {
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
  return "review.analysis requires a computer-use, scripted-browser, terminal-product or shared-world study; this study's route does not produce an eligible live recording.";
}
