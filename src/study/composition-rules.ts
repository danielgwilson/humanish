// Which subject, target and actor compositions a study may declare. Each rule returns the refusal
// message for the first thing its composition gets wrong, or null. compositionReason runs them in
// the parser's order, and only parseStudy calls it. planStudy does not: each route planner checks
// a library caller's config itself, under its route's error codes. The planners call the shared
// checks in study/validation.ts and desktopCliProductReason below. The other subject rules here have
// planner counterparts whose conditions and wording differ (clone serve and repo, local-tree
// target, in-process fan-out, loopback targets, scripted scenario.ref).

import { isLoopbackUrl } from "./parse/subject.js";
import { REPO_SLUG_PATTERN } from "./parse/values.js";
import { declaredTargets } from "./plan-participants.js";
import {
  actorResolvesToComputerUse,
  actorResolvesToScriptedBrowser,
  actorResolvesToTerminal,
  computerUseParticipantCount,
  registeredComputerUseActors,
  registeredScriptedBrowserActors,
  registeredTerminalActors,
  isComputerUseComposition,
} from "./routing.js";
import type { StudyConfig } from "./types.js";
import {
  cloneTargetValidationReason,
  computerUseValidationReason,
  sharedWorldValidationReason,
} from "./validation.js";
import { rosterOf } from "./parse/actors.js";

/** The first composition rule a config breaks, in the parser's order, or null. */
export function compositionReason(config: StudyConfig): string | null {
  return (
    thisRepoValidationReason(config) ??
    localAppValidationReason(config) ??
    appUrlValidationReason(config) ??
    scriptedBrowserValidationReason(config) ??
    // Before the clone checks below, which apply only on e2b-desktop and must not be bypassed.
    cloneTargetValidationReason(config) ??
    cloneComputerUseValidationReason(config) ??
    localTreeValidationReason(config) ??
    // Independent computer-use participants: the roster contract on every route that resolves to cua.
    (isComputerUseComposition(config) ? computerUseValidationReason(config) : null) ??
    // Whenever shared world is declared, not only when it routes, so a half-declared shared world
    // fails with a precise reason instead of running as independent participants.
    (config.subject.topology === "shared-world" ? sharedWorldValidationReason(config) : null) ??
    desktopCliValidationReason(config) ??
    terminalValidationReason(config) ??
    cloneActorValidationReason(config)
  );
}

/** Why a this-repo study cannot run live. The parser and the preview planner both refuse with it. */
export const THIS_REPO_DRY_RUN_ONLY =
  "this-repo studies are dry-run only; use a clone or app-url subject for a live run.";

// this-repo subjects run locally and dry-run only: there is no live execution target for the
// host repo (clone/app-url provide that). Reject the mis-configs rather than silently mishandle.
function thisRepoValidationReason(config: StudyConfig): string | null {
  if (config.subject.source === "this-repo") {
    if (config.execution?.target) {
      return "`execution.target` applies only to clone/app-url/local-app subjects; this-repo studies run locally.";
    }
    if (config.scenario?.mode === "live") {
      return THIS_REPO_DRY_RUN_ONLY;
    }
  }
  return null;
}

// local-app route: an already-running local dev server driven in-process via a custom
// CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed: a computer-use actor
// only, execution.target local or absent (never e2b-desktop, because the route exists to skip the
// desktop), and no public-target policy (it is always loopback; the loopback shape was already
// enforced in parseSubject). The actual "no inProcess executor supplied" case is inherently an
// engine-time decision (the parser cannot know whether a library caller will pass one), so
// planComputerUseStudy refuses it with HUMANISH_COMPUTER_USE_LOCAL_APP_NO_EXECUTOR.
function localAppValidationReason(config: StudyConfig): string | null {
  if (config.subject.source === "local-app") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "local") {
      return "A local-app subject drives a local dev server in this process, with no E2B desktop. Set `execution.target: local` or omit it. To run on a hosted desktop, use an app-url subject with `execution.target: e2b-desktop`.";
    }
    if (!actorResolvesToComputerUse(type)) {
      return `actors[0].type must be a registered computer-use actor for local-app subjects (one of: ${registeredComputerUseActors().join(", ")}); the caller's custom executor runs the computer-use loop. Got "${type}".`;
    }
    if (computerUseParticipantCount(config) > 1) {
      return "Fan-out to more than one participant is not supported on the in-process/local-app route: fan-out provisions one independent E2B desktop per participant, which the in-process route deliberately skips. Set actors[0].count to 1 and drop actors[0].lanes (use an app-url or clone subject on execution.target: e2b-desktop for fan-out).";
    }
    if (rosterOf(config.actors[0]) !== undefined) {
      return "`actors[0].lanes` (fan-out roster) is not supported on the in-process/local-app route: it provisions one E2B desktop per participant, which this route skips. Use an app-url or clone subject with execution.target: e2b-desktop.";
    }
    if (config.policies?.allowPublicTargets === true) {
      return "`policies.allowPublicTargets` does not apply to a local-app subject: it is always a loopback dev server, so there is no public target to allow. Remove the setting.";
    }
  }
  return null;
}

// app-url routes: the actor type is a real dispatch key (registry-resolved). The actor's run kind
// picks the substrate: a scripted-browser actor runs locally against the declared loopback
// app; a computer-use actor drives a hosted desktop browser. Fail closed on mis-configs.
function appUrlValidationReason(config: StudyConfig): string | null {
  if (config.subject.source === "app-url") {
    const type = config.actors[0]?.type ?? "";
    if (actorResolvesToScriptedBrowser(type)) {
      // Scripted-browser route (all fail-closed, so claims match mechanism: a field that cannot act on
      // this route is rejected, never silently ignored).
      if (config.execution?.target !== undefined && config.execution.target !== "local") {
        return "A scripted-browser actor on an app-url subject runs on this machine. Set `execution.target: local` or omit it. To run scripted steps on a hosted desktop, use a clone subject.";
      }
      if (!config.scenario?.ref) {
        return "A scripted-browser study needs `scenario.ref`: the actor runs the browser steps in that scenario file.";
      }
      if ((config.actors[0]?.count ?? 1) > 2) {
        return "A scripted-browser study takes `actors[0].count` 1 (desktop) or 2 (desktop and mobile). Higher counts are not supported yet.";
      }
      if (config.policies?.redactScreenshots === true) {
        return "`policies.redactScreenshots: true` is not supported on the scripted-browser route yet, so its screenshots would be stored unredacted in .humanish/. Remove the setting, or use a computer-use actor, which blurs screenshots as it takes them.";
      }
      if (config.policies?.allowPublicTargets === true) {
        return "`policies.allowPublicTargets` is not supported on the scripted-browser route: the step driver allows only loopback URLs at every navigation. Remove the setting, or drive the public URL with a computer-use actor.";
      }
      if (!isLoopbackUrl(config.subject.appUrl ?? "")) {
        return "`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on the scripted-browser route.";
      }
    } else {
      if (config.execution?.target !== "e2b-desktop" && config.execution?.target !== "local") {
        return "app-url computer-use subjects require `execution.target: local` or `e2b-desktop`.";
      }
      if (!actorResolvesToComputerUse(type)) {
        return `actors[0].type must be a registered computer-use actor for app-url × e2b-desktop studies (one of: ${registeredComputerUseActors().join(", ")}); for local scripted execution use a registered scripted-browser actor (${registeredScriptedBrowserActors().join(", ")}). Got "${type}".`;
      }
      // Multi-participant fan-out is consumed on this route (`per-lane-worlds`; the shared cua
      // cross-validation below enforces `lanes`/`count` XOR rules, the 16 cap, and the
      // per-participant target gates, and the allowPublicTargets+N>1 rejection for ambiguous one-target
      // fan-out).
      // Loopback by default; an owner may declare a public/preview target via policies.
      const targets = [config.subject.appUrl ?? "", ...declaredTargets(config)];
      const unsafeTarget = targets.find(
        (target) => !config.policies?.allowPublicTargets && !isLoopbackUrl(target),
      );
      if (unsafeTarget !== undefined) {
        return "`subject.appUrl` and `actors[0].lanes[].target` must be loopback URLs (127.0.0.1 or localhost). To drive a deployed or preview URL you own, set `policies.allowPublicTargets: true`.";
      }
    }
  }
  return null;
}

// Scripted-browser actors on any other subject: only a provisioned clone on e2b-desktop.
function scriptedBrowserValidationReason(config: StudyConfig): string | null {
  if (
    config.subject.source !== "app-url" &&
    actorResolvesToScriptedBrowser(config.actors[0]?.type)
  ) {
    if (config.subject.source !== "clone") {
      return "scripted-browser actors require `subject.source: app-url` (a running app at a loopback URL) or `subject.source: clone` with `execution.target: e2b-desktop` (a provisioned synthetic subject).";
    }
    if (config.execution?.target !== "e2b-desktop") {
      return "A clone subject with a scripted-browser actor needs `execution.target: e2b-desktop`: humanish builds the clone in an E2B sandbox, opens it at a public sandbox URL and runs the scenario's browser steps against it.";
    }
    if (!config.subject.serve) {
      return "A clone subject with a scripted-browser actor needs `subject.serve` (start and url): humanish starts the app in the sandbox before the browser steps run.";
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return "clone scripted-browser studies require exactly one repo in subject.repos.";
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return `subject.repos[0] must be an owner/repo slug (got "${repo}").`;
    }
    if (config.subject.topology !== undefined) {
      return "A clone scripted-browser study does not support `subject.topology` yet: it runs one synthetic subject for its scripted actor. Remove `subject.topology`.";
    }
    if (config.subject.clone?.fanout !== undefined || config.subject.clone?.keep === true) {
      return "A clone scripted-browser study does not support `subject.clone.fanout` or `subject.clone.keep` yet: its subject is always one sandbox, removed after the run.";
    }
    if (!config.scenario?.ref) {
      return "A scripted-browser study needs `scenario.ref`: the actor runs the browser steps in that scenario file.";
    }
    if ((config.actors[0]?.count ?? 1) > 2) {
      return "A scripted-browser study takes `actors[0].count` 1 (desktop) or 2 (desktop and mobile). Higher counts are not supported yet.";
    }
    if (rosterOf(config.actors[0]) !== undefined) {
      return "`actors[0].lanes` is not supported on the scripted-browser route yet. Use `actors[0].count` to choose the desktop and mobile surfaces.";
    }
    if (config.policies?.redactScreenshots === true) {
      return "`policies.redactScreenshots: true` is not supported on the scripted-browser route yet, so its screenshots would be stored unredacted in .humanish/. Remove the setting, or use a computer-use actor, which blurs screenshots as it takes them.";
    }
    if (config.policies?.allowPublicTargets === true) {
      return "`policies.allowPublicTargets` does not apply to a clone scripted-browser study: its only public URL is the sandbox URL humanish opens for its synthetic subject. Remove the setting.";
    }
    if (config.subject.exposure !== "synthetic") {
      return "A clone scripted-browser study needs `subject.exposure: synthetic`. The subject is reachable from the internet at a public sandbox URL during the run, so the study must declare that its data is synthetic.";
    }
    if (
      !config.subject.state?.seed ||
      config.subject.state.seed.length === 0 ||
      (config.subject.state.external?.length ?? 0) > 0
    ) {
      return "A clone scripted-browser study needs `subject.state.seed` and cannot use `subject.state.external`: a subject at a public sandbox URL may hold only seeded synthetic data.";
    }
    if (!config.subject.serve.start.includes("0.0.0.0")) {
      return "A clone scripted-browser study needs `subject.serve.start` to listen on all interfaces (for example `-H 0.0.0.0`, `--host 0.0.0.0` or `HOST=0.0.0.0`): the public sandbox URL reaches only a port bound to 0.0.0.0. The readiness probe still uses loopback.";
    }
  }
  return null;
}

// clone × e2b-desktop disambiguates on the actor's run kind: a computer-use actor means the study
// clones and serves the subject in-sandbox, then drives it. Scripted-browser actors were checked
// above.
function cloneComputerUseValidationReason(config: StudyConfig): string | null {
  if (
    config.subject.source === "clone" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(config.actors[0]?.type)
  ) {
    if (!config.subject.serve) {
      return "A clone subject on the computer-use route needs `subject.serve` (start and url): humanish starts the app in the sandbox before the participant opens it.";
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return "computer-use clone studies serve one repo; declare exactly one repo in subject.repos.";
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return `subject.repos[0] must be an owner/repo slug (got "${repo}").`;
    }
    // Fan-out is consumed here: N participants each clone the same single repo into their own
    // E2B desktop (`per-lane-worlds`). The shared cua cross-validation below enforces the
    // `lanes`/`count` rules and the 16 cap; the single-repo rule above is unchanged.
  }
  return null;
}

// local-tree route: packs and uploads the operator's own working tree, then serves it exactly
// like a computer-use clone subject. The scripted-browser route has no packed-working-tree
// mode, so e2b-desktop + a computer-use actor are the only combination this source supports.
// `subject.serve` is already required at parse time (parseSubject); the repos/clone rejection
// also already happened there (local-tree never carries git slugs).
function localTreeValidationReason(config: StudyConfig): string | null {
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

// desktop-cli route: a computer-use participant studies a CLI/TUI the way a person does: at a
// desktop, in a terminal window, by looking at it. The sibling of terminal-product, and the
// distinction is the population: terminal-product sends an autonomous agent
// through a pipe with stdin disabled, which matches what an agent meets and
// structurally cannot study an interactive surface. This route sends someone who can see it.
//
// Fail-closed on the pairing: a hosted desktop and a computer-use actor, because
// "watch a person use a terminal" is not something the other substrates can do.
/** A desktop-cli subject with no product to study. The computer-use planner checks this too. */
export function desktopCliProductReason(config: StudyConfig): string | null {
  return config.subject.source === "desktop-cli" && config.subject.product?.name === undefined
    ? "A desktop-cli subject needs `subject.product.name`: the CLI the participant is asked to use."
    : null;
}

function desktopCliValidationReason(config: StudyConfig): string | null {
  const productReason = desktopCliProductReason(config);
  if (productReason) return productReason;
  if (config.subject.source === "desktop-cli" && config.subject.product !== undefined) {
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-desktop") {
      return "A desktop-cli subject runs on a hosted desktop. Set `execution.target: e2b-desktop` or omit it.";
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

// terminal-product route: a real autonomous agent studies a CLI/product from public surfaces inside
// an E2B shell. Fail-closed (claims match mechanism: a field that cannot act on this route is a
// parse error): a registered terminal actor only, execution.target e2b-terminal or absent (absent
// defaults to e2b-terminal, the only target where an in-sandbox agent runs), one participant until
// fan-out lands.
function terminalValidationReason(config: StudyConfig): string | null {
  if (config.subject.source === "terminal-product") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-terminal") {
      return "A terminal-product subject runs its agent in an E2B shell. Set `execution.target: e2b-terminal` or omit it; `local` and `e2b-desktop` are not supported.";
    }
    if (!actorResolvesToTerminal(type)) {
      return `actors[0].type must be a registered terminal actor for terminal-product subjects (one of: ${registeredTerminalActors().join(", ")}). Got "${type}".`;
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return "Terminal fan-out to more than one participant is not supported yet; set actors[0].count to 1.";
    }
  } else if (config.execution?.target === "e2b-terminal") {
    // e2b-terminal is the terminal-product substrate only. Any other source declaring it is a
    // mis-config: reject, never silently mishandle (mirrors app-url's e2b-desktop pairing rule).
    return "`execution.target: e2b-terminal` requires `subject.source: terminal-product` with a registered terminal actor.";
  } else if (actorResolvesToTerminal(config.actors[0]?.type)) {
    // A registered terminal actor on a non-terminal-product subject: rejected, never ignored (the
    // terminal agent only studies a declared terminal-product from public surfaces).
    return "terminal actors require `subject.source: terminal-product` (a CLI/product the agent studies from public surfaces); other subjects are not supported on this route.";
  }
  return null;
}

// A clone study is served in-sandbox for a participant to drive, so only a computer-use or a
// scripted-browser actor can run it. Any other actor would parse and then fail at run start.
// Terminal actors were already refused above with their own message.
function cloneActorValidationReason(config: StudyConfig): string | null {
  if (config.subject.source === "clone") {
    const type = config.actors[0]?.type ?? "";
    if (!actorResolvesToComputerUse(type) && !actorResolvesToScriptedBrowser(type)) {
      return `clone subjects need a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}) or scripted-browser actor (one of: ${registeredScriptedBrowserActors().join(", ")}); humanish clones and serves the app for that participant to drive. Got "${type}".`;
    }
  }
  return null;
}
