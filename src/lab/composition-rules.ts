// Which subject, target and actor compositions a lab may declare. Each rule returns the refusal
// message for the first thing its composition gets wrong, or null. compositionReason runs them in
// the parser's order; parseLabConfig calls it after the structural parse, and the planLab design
// has library callers go through the same function.

import { isLoopbackUrl } from "./parse/subject.js";
import { REPO_SLUG_PATTERN } from "./parse/values.js";
import { declaredTargets } from "./plan-participants.js";
import {
  actorResolvesToComputerUse,
  actorResolvesToScriptedBrowser,
  actorResolvesToTerminal,
  cuaLaneCount,
  registeredComputerUseActors,
  registeredScriptedBrowserActors,
  registeredTerminalActors,
  isComputerUseComposition,
} from "./routing.js";
import type { LabConfig } from "./types.js";
import {
  cloneTargetValidationReason,
  cuaLaneValidationReason,
  sharedWorldValidationReason,
} from "./validation.js";
import { rosterOf } from "./parse/actors.js";

/** The first composition rule a config breaks, in the parser's order, or null. */
export function compositionReason(config: LabConfig): string | null {
  return (
    thisRepoValidationReason(config) ??
    localAppValidationReason(config) ??
    appUrlValidationReason(config) ??
    scriptedBrowserValidationReason(config) ??
    // Before the clone checks below, which apply only on e2b-desktop and must not be bypassed.
    cloneTargetValidationReason(config) ??
    cloneComputerUseValidationReason(config) ??
    localTreeValidationReason(config) ??
    // Independent computer-use lanes: the roster contract on every route that resolves to cua.
    (isComputerUseComposition(config) ? cuaLaneValidationReason(config) : null) ??
    // Whenever shared world is declared, not only when it routes, so a half-declared shared world
    // fails with a precise reason instead of running as independent lanes.
    (config.subject.topology === "shared-world" ? sharedWorldValidationReason(config) : null) ??
    desktopCliValidationReason(config) ??
    terminalValidationReason(config) ??
    cloneActorValidationReason(config)
  );
}

// this-repo subjects run locally and dry-run only — there is no live execution target for the
// host repo (clone/app-url provide that). Reject the mis-configs rather than silently mishandle.
function thisRepoValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "this-repo") {
    if (config.execution?.target) {
      return "`execution.target` applies only to clone/app-url/local-app subjects; this-repo labs run locally.";
    }
    if (config.scenario?.mode === "live") {
      return "this-repo labs are dry-run only; use a clone or app-url subject for a live run.";
    }
  }
  return null;
}

// local-app route: an already-running LOCAL dev server driven IN-PROCESS via a custom
// CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed: a computer-use actor
// only, execution.target local or absent (NEVER e2b-desktop — the whole point is to skip the
// desktop), and no public-target policy (it is always loopback; the loopback shape was already
// enforced in parseSubject). The actual "no buildExecutor hook supplied" case is inherently an
// engine-time decision (the parser cannot know whether a library caller will pass hooks), so
// it fails closed in runCuaActorLab with HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR.
function localAppValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "local-app") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "local") {
      return "local-app subjects drive an in-process LOCAL dev server with NO E2B desktop — set `execution.target: local` or omit it (absent means local); `e2b-desktop` is rejected (use an app-url subject for the hosted-desktop route).";
    }
    if (!actorResolvesToComputerUse(type)) {
      return `actors[0].type must be a registered computer-use actor for local-app subjects (one of: ${registeredComputerUseActors().join(", ")}); the caller's custom executor runs the computer-use loop. Got "${type}".`;
    }
    if (cuaLaneCount(config) > 1) {
      return "Fan-out to more than one participant is not supported on the in-process/local-app route: fan-out provisions one independent E2B desktop per participant, which the in-process route deliberately skips. Set actors[0].count to 1 and drop actors[0].lanes (use an app-url or clone subject on execution.target: e2b-desktop for fan-out).";
    }
    if (rosterOf(config.actors[0]) !== undefined) {
      return "`actors[0].lanes` (fan-out roster) is not supported on the in-process/local-app route: it provisions one E2B desktop per participant, which this route skips. Use an app-url or clone subject with execution.target: e2b-desktop.";
    }
    if (config.policies?.allowPublicTargets === true) {
      return "`policies.allowPublicTargets` is not supported on the local-app route — a local-app subject is always a loopback dev server; there is no public target to allow.";
    }
  }
  return null;
}

// app-url routes: the actor type is a REAL dispatch key (registry-resolved). The actor LANE
// picks the substrate: a scripted-browser actor runs locally against the declared loopback
// app; a computer-use actor drives a hosted desktop browser. Fail closed on mis-configs.
function appUrlValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "app-url") {
    const type = config.actors[0]?.type ?? "";
    if (actorResolvesToScriptedBrowser(type)) {
      // Scripted-browser route (all fail-closed: invariant 6 — a field that cannot act on
      // this route is rejected, never silently ignored).
      if (config.execution?.target !== undefined && config.execution.target !== "local") {
        return "scripted-browser actors run on the operator's machine — set `execution.target: local` or omit it (absent means local); in-sandbox scripted execution is a later slice.";
      }
      if (!config.scenario?.ref) {
        return "scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes.";
      }
      if ((config.actors[0]?.count ?? 1) > 2) {
        return "scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.";
      }
      if (config.policies?.redactScreenshots === true) {
        return "`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.";
      }
      if (config.policies?.allowPublicTargets === true) {
        return "`policies.allowPublicTargets` is not supported on the scripted-browser route — the scripted step driver enforces loopback at every navigation; public targets on this route are a later slice.";
      }
      if (!isLoopbackUrl(config.subject.appUrl ?? "")) {
        return "`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on the scripted-browser route.";
      }
    } else {
      if (config.execution?.target !== "e2b-desktop" && config.execution?.target !== "local") {
        return "app-url computer-use subjects require `execution.target: local` or `e2b-desktop`.";
      }
      if (!actorResolvesToComputerUse(type)) {
        return `actors[0].type must be a registered computer-use actor for app-url × e2b-desktop labs (one of: ${registeredComputerUseActors().join(", ")}); for local scripted execution use a registered scripted-browser actor (${registeredScriptedBrowserActors().join(", ")}). Got "${type}".`;
      }
      // Multi-lane fan-out is CONSUMED on this route (per-lane worlds; the shared cua-lane
      // cross-validation below enforces lanes/count XOR rules, the 16 cap, and the
      // lane-level target gates, and the allowPublicTargets+N>1 rejection for ambiguous one-target
      // fan-out).
      // Loopback by default; an owner may declare a public/preview target via policies.
      const targets = [config.subject.appUrl ?? "", ...declaredTargets(config)];
      const unsafeTarget = targets.find(
        (target) => !config.policies?.allowPublicTargets && !isLoopbackUrl(target),
      );
      if (unsafeTarget !== undefined) {
        return "`subject.appUrl` and `actors[0].lanes[].target` must be loopback URLs (127.0.0.1/localhost) unless `policies.allowPublicTargets: true` is set — set it to drive deployed/preview URLs you own.";
      }
    }
  }
  return null;
}

// Scripted-browser actors on any other subject: only a provisioned clone on e2b-desktop.
function scriptedBrowserValidationReason(config: LabConfig): string | null {
  if (
    config.subject.source !== "app-url" &&
    actorResolvesToScriptedBrowser(config.actors[0]?.type)
  ) {
    if (config.subject.source !== "clone") {
      return "scripted-browser actors require `subject.source: app-url` (a running app at a loopback URL) or `subject.source: clone` with `execution.target: e2b-desktop` (a provisioned synthetic subject).";
    }
    if (config.execution?.target !== "e2b-desktop") {
      return "clone subjects with scripted-browser actors require `execution.target: e2b-desktop` — the lab provisions the clone in E2B, exposes it with getHost, then drives deterministic browser steps.";
    }
    if (!config.subject.serve) {
      return "clone subjects with scripted-browser actors require `subject.serve` (start + url) — the lab serves the app in-sandbox before the scripted browser drives it.";
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return "clone scripted-browser labs require exactly one repo in subject.repos.";
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return `subject.repos[0] must be an owner/repo slug (got "${repo}").`;
    }
    if (config.subject.topology !== undefined) {
      return "clone scripted-browser labs do not support `subject.topology` yet — this slice provisions one synthetic subject and one deterministic scripted actor roster, not a shared-world run.";
    }
    if (config.subject.clone?.fanout !== undefined || config.subject.clone?.keep === true) {
      return "clone scripted-browser labs do not support `subject.clone.fanout` or `subject.clone.keep` yet — the provisioned subject is always a single disposable E2B sandbox.";
    }
    if (!config.scenario?.ref) {
      return "scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes.";
    }
    if ((config.actors[0]?.count ?? 1) > 2) {
      return "scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.";
    }
    if (rosterOf(config.actors[0]) !== undefined) {
      return "`actors[0].lanes` is not supported on the scripted-browser route yet — use actors[0].count for the deterministic surface roster.";
    }
    if (config.policies?.redactScreenshots === true) {
      return "`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.";
    }
    if (config.policies?.allowPublicTargets === true) {
      return "`policies.allowPublicTargets` is not supported on the clone scripted-browser route — the only external host is the harness-minted getHost URL for a provisioned synthetic subject.";
    }
    if (config.subject.exposure !== "synthetic") {
      return "clone scripted-browser labs require `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data.";
    }
    if (
      !config.subject.state?.seed ||
      config.subject.state.seed.length === 0 ||
      (config.subject.state.external?.length ?? 0) > 0
    ) {
      return "clone scripted-browser labs require `subject.state.seed` and do not allow `subject.state.external` — getHost-exposed subjects must be synthetic seeded data, not external/unpinned state.";
    }
    if (!config.subject.serve.start.includes("0.0.0.0")) {
      return "clone scripted-browser labs require `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; the readiness probe stays loopback.";
    }
  }
  return null;
}

// clone × e2b-desktop disambiguates on the actor lane: a computer-use actor means the lab
// clones AND serves the subject in-sandbox, then drives it. Scripted-browser actors were checked
// above.
function cloneComputerUseValidationReason(config: LabConfig): string | null {
  if (
    config.subject.source === "clone" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(config.actors[0]?.type)
  ) {
    if (!config.subject.serve) {
      return "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox before the actor drives it.";
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return "computer-use clone labs serve one repo; declare exactly one repo in subject.repos.";
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return `subject.repos[0] must be an owner/repo slug (got "${repo}").`;
    }
    // Fan-out is CONSUMED here: N lanes each clone the SAME single repo into their own E2B
    // desktop (per-lane worlds). The shared cua-lane cross-validation below enforces the
    // lanes/count rules and the 16 cap; the single-repo rule above is unchanged.
  }
  return null;
}

// local-tree route: packs and uploads the operator's own working tree, then serves it exactly
// like a computer-use clone subject. The scripted-browser route has no packed-working-tree
// mode, so e2b-desktop + a computer-use actor are the ONLY combination this source supports.
// `subject.serve` is already required at parse time (parseSubject); the repos/clone rejection
// also already happened there (local-tree never carries git slugs).
function localTreeValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "local-tree") {
    if (config.execution?.target !== "e2b-desktop") {
      return "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox; there is no local route for a local-tree subject.";
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
      return `actors[0].type must be a registered computer-use actor for local-tree subjects (one of: ${registeredComputerUseActors().join(", ")}); the actor drives the hosted desktop that serves the packed working tree. Got "${config.actors[0]?.type ?? ""}".`;
    }
  }
  return null;
}

// desktop-cli route: a computer-use participant studies a CLI/TUI the way a person does — at a
// desktop, in a terminal window, by looking at it. The sibling of terminal-product, and the
// distinction is the POPULATION, not the product: terminal-product sends an autonomous agent
// through a pipe with stdin disabled, which is the honest way to study what an agent meets and
// structurally cannot study an interactive surface. This route sends someone who can see it.
//
// Fail-closed on the pairing (invariant 6): a hosted desktop and a computer-use actor, because
// "watch a person use a terminal" is not something the other substrates can do.
function desktopCliValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "desktop-cli") {
    if (config.subject.product?.name === undefined) {
      return "desktop-cli subjects need `subject.product.name` — the CLI the participant is being asked to use.";
    }
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-desktop") {
      return "desktop-cli subjects are studied at a hosted desktop — set `execution.target: e2b-desktop` or omit it.";
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type ?? "")) {
      return "desktop-cli subjects need a registered computer-use actor: the participant reads the screen and types, which is what makes an interactive surface studiable at all.";
    }
    const install = config.subject.product.install;
    if (install !== undefined && install.trim().length === 0) {
      return "`subject.product.install` must be a non-empty command when set (omit it to study the install itself).";
    }
  }
  return null;
}

// terminal-product route: a real autonomous agent studies a CLI/product from PUBLIC surfaces
// inside an E2B shell. Fail-closed (invariant 6 — a field that cannot act on this route is an
// honest parse error): a registered terminal actor only, execution.target e2b-terminal or absent
// (absent defaults to e2b-terminal — the only honest target for an in-sandbox agent), single
// lane until fan-out lands.
function terminalValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "terminal-product") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-terminal") {
      return "terminal-product subjects run the agent inside an E2B shell — set `execution.target: e2b-terminal` or omit it (absent means e2b-terminal); `local`/`e2b-desktop` are rejected.";
    }
    if (!actorResolvesToTerminal(type)) {
      return `actors[0].type must be a registered terminal actor for terminal-product subjects (one of: ${registeredTerminalActors().join(", ")}). Got "${type}".`;
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return "Multi-lane terminal fan-out is not supported yet; set actors[0].count to 1.";
    }
  } else if (config.execution?.target === "e2b-terminal") {
    // e2b-terminal is the terminal-product substrate ONLY. Any other source declaring it is a
    // mis-config — reject, never silently mishandle (mirrors app-url's e2b-desktop pairing rule).
    return "`execution.target: e2b-terminal` requires `subject.source: terminal-product` with a registered terminal actor.";
  } else if (actorResolvesToTerminal(config.actors[0]?.type)) {
    // A registered terminal actor on a non-terminal-product subject: rejected, never ignored (the
    // terminal agent only studies a declared terminal-product from public surfaces).
    return "terminal actors require `subject.source: terminal-product` (a CLI/product the agent studies from public surfaces); other subjects are not supported on this route.";
  }
  return null;
}

// A clone lab is served in-sandbox for a participant to drive, so only a computer-use or a
// scripted-browser actor can run it. Any other actor would parse and then fail at run start.
// Terminal actors were already refused above with their own message.
function cloneActorValidationReason(config: LabConfig): string | null {
  if (config.subject.source === "clone") {
    const type = config.actors[0]?.type ?? "";
    if (!actorResolvesToComputerUse(type) && !actorResolvesToScriptedBrowser(type)) {
      return `clone subjects need a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}) or scripted-browser actor (one of: ${registeredScriptedBrowserActors().join(", ")}); the lab clones and serves the app for that participant to drive. Got "${type}".`;
    }
  }
  return null;
}
