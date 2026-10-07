import {
  isComputerUseComposition,
  isScriptedBrowserComposition,
  isSharedWorldComposition,
  isTerminalProductComposition,
} from "./routing.js";
import type { StudyConfig } from "./types.js";
import { declaredParticipantIds } from "./plan-participants.js";
import { addressedRecipients } from "./parse/comms.js";
import { participantList, declaredParticipantCount } from "./study-fields.js";

/** Which routes a config takes, computed once for every row below. */
interface Routes {
  cua: boolean;
  scripted: boolean;
  terminal: boolean;
  shared: boolean;
  /** The external-public plane: a real public deployment as the shared plane (app-url shared world). */
  externalPublic: boolean;
  hostedCuaBrowser: boolean;
  /** A route that creates an E2B desktop through Sandbox.create. */
  createsE2BDesktop: boolean;
}

/**
 * One field that is set but not consumed on the config's route. It is reported as `field`, or as
 * `field (reason)` when the reason says where the field does act.
 */
interface InertRow {
  field: string;
  reason?: string;
  applies: (config: StudyConfig, routes: Routes) => boolean;
}

// The computer-use and terminal routes consume mission/persona/model (they compose the agent prompt
// and bundle provenance).
const promptRoute = (routes: Routes): boolean => routes.cua || routes.terminal;
// The scripted-browser route consumes persona and surfaces (trace/bundle provenance). The prompt
// fields can never act there: the scripted actor runs no model.
const scriptedRoute = (routes: Routes): boolean => !promptRoute(routes) && routes.scripted;
const otherRoute = (routes: Routes): boolean => !promptRoute(routes) && !routes.scripted;

/** Rows for the actor and its participants, reported first, in this order. */
const ACTOR_ROWS: readonly InertRow[] = [
  // Shared-world-only fields on the roster: a participant's `entry` is inert anywhere else
  // (claims match mechanism).
  {
    field: "participants[].entry",
    reason:
      "the per-participant loopback entry is a shared-world capability; needs route: shared-world",
    applies: (config, routes) =>
      Boolean(participantList(config)?.some((entry) => entry.entry !== undefined)) &&
      !routes.shared,
  },
  // The host marker acts only on the external-public shared-world route; inert elsewhere.
  {
    field: "participants[].host",
    reason:
      "the designated host-participant marker; needs the external-public shared-world route: app-url × topology shared-world × allowPublicTargets",
    applies: (config, routes) =>
      Boolean(participantList(config)?.some((entry) => entry.host === true)) &&
      !routes.externalPublic,
  },
  {
    field: "actor.mission",
    reason: "the scripted-browser actor runs no model",
    applies: (config, routes) => scriptedRoute(routes) && Boolean(config.actor?.mission),
  },
  {
    field: "actor.model",
    reason: "the scripted-browser actor runs no model",
    applies: (config, routes) => scriptedRoute(routes) && Boolean(config.actor?.model),
  },
  // On every other route the prompt fields and persona are inert.
  {
    field: "actor.mission",
    applies: (config, routes) => otherRoute(routes) && Boolean(config.actor?.mission),
  },
  {
    field: "actor.persona",
    applies: (config, routes) => otherRoute(routes) && Boolean(config.actor?.persona),
  },
  {
    field: "actor.model",
    applies: (config, routes) => otherRoute(routes) && Boolean(config.actor?.model),
  },
];

const TERMINAL_ONLY = "needs subject.source: terminal-product + a registered terminal actor";
const RESERVED = "reserved; no route reads it yet";

/** Rows for the rest of the config, reported after the actor rows, in this order. */
const CONFIG_ROWS: readonly InertRow[] = [
  // The computer-use routes consume (clone) subject.{serve,env,state,clone.depth}, and so does the
  // scripted-browser route; on every other route they are inert.
  {
    field: "subject.clone.depth",
    applies: (config, routes) =>
      config.subject.clone?.depth !== undefined && !routes.cua && !routes.scripted,
  },
  {
    field: "subject.serve",
    applies: (config, routes) => Boolean(config.subject.serve) && !routes.cua && !routes.scripted,
  },
  {
    field: "subject.env",
    applies: (config, routes) => Boolean(config.subject.env) && !routes.cua && !routes.scripted,
  },
  {
    field: "subject.state",
    applies: (config, routes) => Boolean(config.subject.state) && !routes.cua && !routes.scripted,
  },
  // The checkpoint acts only on the shared-world route.
  {
    field: "subject.state.checkpoint",
    reason: "the shared-world state-checkpoint probe; needs route: shared-world",
    applies: (config, routes) => config.subject.state?.checkpoint !== undefined && !routes.shared,
  },
  // publicTarget (the external-public ownership attestation) acts only on the external-public
  // shared-world route; inert elsewhere. (It is already parse-rejected on non-app-url sources.)
  {
    field: "subject.publicTarget",
    reason:
      "the external-public ownership attestation; needs the external-public shared-world route: app-url × topology shared-world × allowPublicTargets",
    applies: (config, routes) =>
      config.subject.publicTarget !== undefined && !routes.externalPublic,
  },
  // exposure (the synthetic-subject attestation) acts only on the shared-world route (the
  // getHost-exposed plane) and on scripted clones; inert elsewhere.
  {
    field: "subject.exposure",
    reason:
      "the statement that a subject served on a public sandbox URL holds only synthetic data; needs shared-world or clone × e2b-desktop × scripted-browser",
    applies: (config, routes) =>
      config.subject.exposure !== undefined &&
      !routes.shared &&
      !(routes.scripted && config.subject.source === "clone"),
  },
  // comms.email drives the in-sandbox email/SMS catch, which needs a subject sandbox that humanish
  // provisions (clone or local-tree) so it holds a handle to host the catch. On an app-url /
  // operator-provided subject there is no such handle, so a declared comms block would silently
  // collect nothing, a false green. Warn at parse time (fires on inspect + dry-run too).
  {
    field: "comms.email",
    reason:
      "the email catch runs in a sandbox humanish provisions, which needs `subject.source: clone` or `local-tree`, and an app-url subject has none. To use email here, run the catch yourself with `humanish comms catch` and declare `comms.email.external`: humanish then points each persona at your inbox, reads your catch and records the same evidence",
    applies: (config) =>
      config.comms?.email?.kind === "fake" &&
      config.comms.email.external === undefined &&
      config.subject.source !== "clone" &&
      config.subject.source !== "local-tree",
  },
  // The reverse mis-config: declaring an adopter-hosted catch on a route where humanish provisions
  // the subject itself. Two catches would exist and the app would point at humanish's, so the
  // declared external one would silently collect nothing.
  {
    field: "comms.email.external",
    reason:
      "this subject is harness-provisioned, so humanish hosts the catch itself and injects its URL; an adopter-hosted catch would receive nothing. Drop `external` here, or move the study to an app-url or operator-provisioned subject",
    applies: (config) =>
      Boolean(config.comms?.email?.external) &&
      (config.subject.source === "clone" || config.subject.source === "local-tree"),
  },
  // clone.keep is consumed on the computer-use route (honored on failure: the sandbox is left up to
  // debug a failed install/boot; otherwise always killed). clone.fanout is rejected on the
  // computer-use route (a hard parse error above), so it can never reach this warning list there.
  {
    field: "execution.timeoutMs",
    applies: (config, routes) =>
      !routes.cua &&
      !routes.scripted &&
      !routes.terminal &&
      config.execution?.timeoutMs !== undefined,
  },
  {
    field: "execution.completionTimeoutMs",
    applies: (config) => config.execution?.completionTimeoutMs !== undefined,
  },
  // execution.concurrency is consumed on the computer-use route (it bounds in-flight fan-out
  // participants); inert (warned) everywhere else.
  {
    field: "execution.concurrency",
    applies: (config, routes) => config.execution?.concurrency !== undefined && !routes.cua,
  },
  // parse/front.ts refuses a `caps` key the declared route does not read, so no row lists `caps`.
  // terminal-product consumes subject.product and execution.{terminal,runtimeAuth}: dry-run records
  // the contract; live execution enforces command-scoped auth. On every other route they are inert
  // and must warn so a misplaced safety field is never trusted to do something it cannot.
  {
    field: "subject.product",
    reason: "needs subject.source: terminal-product or desktop-cli with the matching actor",
    applies: (config, routes) =>
      Boolean(config.subject.product) &&
      !routes.terminal &&
      config.subject.source !== "desktop-cli",
  },
  {
    field: "execution.terminal",
    reason: TERMINAL_ONLY,
    applies: (config, routes) => Boolean(config.execution?.terminal) && !routes.terminal,
  },
  {
    field: "execution.runtimeAuth",
    reason: TERMINAL_ONLY,
    applies: (config, routes) => config.execution?.runtimeAuth !== undefined && !routes.terminal,
  },
  {
    field: "execution.runtime",
    reason: TERMINAL_ONLY,
    applies: (config, routes) => config.execution?.runtime !== undefined && !routes.terminal,
  },
  // execution.desktop.* stays inert on the scripted route by design: device presets belong to
  // the cua desktop; scripted surfaces are the driver's fixed desktop/mobile viewports, where
  // isMobile/DSF genuinely render via playwright emulation.
  {
    field: "execution.desktop.resolution",
    applies: (config, routes) => !routes.cua && Boolean(config.execution?.desktop?.resolution),
  },
  {
    field: "execution.desktop.device",
    applies: (config, routes) => !routes.cua && config.execution?.desktop?.device !== undefined,
  },
  {
    field: "execution.desktop.browser",
    applies: (config, routes) =>
      !routes.hostedCuaBrowser && config.execution?.desktop?.browser !== undefined,
  },
  {
    field: "execution.desktop.fidelity",
    reason:
      "mobile emulation is applied only to computer-use participants in hosted Chromium on execution.target: e2b-desktop",
    applies: (config, routes) =>
      !routes.hostedCuaBrowser && config.execution?.desktop?.fidelity !== undefined,
  },
  {
    field: "execution.desktop.sandboxTimeoutMs",
    applies: (config, routes) =>
      !routes.cua && config.execution?.desktop?.sandboxTimeoutMs !== undefined,
  },
  // execution.desktop.template (the custom E2B desktop image) is consumed only where a desktop is
  // actually created via Sandbox.create: the e2b-desktop computer-use routes (cua/shared-world/
  // concurrent). It is inert on every other route (incl. the in-process local-app computer-use
  // route, which creates no desktop): warn so an unconsumed template is never silently ignored.
  {
    field: "execution.desktop.template",
    reason:
      "the custom E2B desktop image is consumed only on execution.target: e2b-desktop computer-use routes that create a desktop; needs a computer-use actor on e2b-desktop",
    applies: (config, routes) =>
      config.execution?.desktop?.template !== undefined && !routes.createsE2BDesktop,
  },
  // No route reads codexAppServer since the route that consumed it was removed. The key still
  // parses so older manifests load, so flag it wherever it is set.
  {
    field: "execution.desktop.codexAppServer",
    reason: "no current route reads it",
    applies: (config) => config.execution?.desktop?.codexAppServer !== undefined,
  },
  // `scenario` is consumed on the scripted-browser route (required there); forward-declared
  // everywhere else.
  {
    field: "scenario",
    applies: (config, routes) => Boolean(config.scenario) && !routes.scripted,
  },
  // review.{scoring,milestones,vocabulary} stay forward-declared on every route.
  // review.scorer is consumed (loaded + wired, or fail-closed at load) on every scorer-capable
  // route, so it does not warn there; on the scripted-browser route the actor carries no scorer seam,
  // so a declared scorer is flagged inert (the run also fails closed at load).
  {
    field: "review.scoring",
    reason: RESERVED,
    applies: (config) => Boolean(config.review?.scoring),
  },
  {
    field: "review.milestones",
    reason: RESERVED,
    applies: (config) => Boolean(config.review?.milestones),
  },
  {
    field: "review.vocabulary",
    reason: RESERVED,
    applies: (config) => Boolean(config.review?.vocabulary),
  },
  {
    field: "review.scorer",
    reason:
      "the scripted-browser actor has no adopter-scorer seam; declare it on a terminal / computer-use / shared-world route",
    applies: (config, routes) => Boolean(config.review?.scorer) && routes.scripted,
  },
];

function routesOf(config: StudyConfig): Routes {
  const cua = isComputerUseComposition(config);
  const scripted = isScriptedBrowserComposition(config);
  const shared = isSharedWorldComposition(config);
  return {
    cua,
    scripted,
    terminal: isTerminalProductComposition(config),
    shared,
    externalPublic: shared && config.subject.source === "app-url",
    hostedCuaBrowser: config.execution?.target === "e2b-desktop" && cua,
    createsE2BDesktop:
      (cua || (scripted && config.subject.source === "clone")) &&
      config.execution?.target === "e2b-desktop",
  };
}

function inertRows(config: StudyConfig): InertRow[] {
  const routes = routesOf(config);
  return [...ACTOR_ROWS, ...CONFIG_ROWS].filter((row) => row.applies(config, routes));
}

/**
 * The fields a config sets that its route does not read, each as `field` or `field (reason)`.
 * parseStudy refuses a study for any of them.
 */
export function inertFieldLabels(config: StudyConfig): string[] {
  return inertRows(config).map((row) =>
    row.reason === undefined ? row.field : `${row.field} (${row.reason})`,
  );
}

/**
 * The same fields as `inertFieldLabels`, as paths without their reasons, such as
 * `participants[].entry` or `execution.timeoutMs`. `humanish migrate` drops each one.
 */
export function inertFieldPaths(config: StudyConfig): string[] {
  return inertRows(config).map((row) => row.field);
}

/**
 * The warning for `execution.egressAllow` on a route that ignores it, or undefined. Only the
 * terminal route creates its sandbox with the list as an outbound allowlist; on any other route the
 * study author would trust a list that blocks nothing. `humanish study check` and every run print
 * it, and the run records it in its bundle.
 * Removed in the first minor release on or after 2026-11-04: deprecated on 2026-10-05. That release refuses the field off the terminal
 * route.
 */
export function egressAllowIgnoredWarning(config: StudyConfig): string | undefined {
  if (config.execution?.egressAllow === undefined || config.route === "terminal") return undefined;
  return `\`execution.egressAllow\` is ignored on route: ${config.route}. Only route: terminal creates its sandbox with that outbound allowlist, and this route's browser desktops can reach any site. Remove the field: the first minor release on or after 2026-11-04 refuses it on every route except terminal.`;
}

// Report fields that are present but not yet consumed by the engine, so a user never trusts a
// setting that silently does nothing.
export function forwardDeclaredWarnings(config: StudyConfig): string[] {
  const routes = routesOf(config);
  const inert = inertFieldLabels(config);
  const warnings =
    inert.length === 0
      ? []
      : [
          `These fields are set, but no route reads them yet, so they have no effect: ${inert.join(", ")}.`,
        ];
  const egressIgnored = egressAllowIgnoredWarning(config);
  if (egressIgnored !== undefined) warnings.push(egressIgnored);
  // A declared cap below the participant count is legal but loud: the roster promises N live actors
  // and the cap delivers waves of M. Say so up front (inspect + dry-run + run): a green run in
  // waves is otherwise indistinguishable from the all-live run the author meant.
  {
    const participantCount =
      participantList(config)?.length ?? declaredParticipantCount(config) ?? 1;
    const cap = config.execution?.concurrency;
    if (routes.cua && cap !== undefined && participantCount > 1 && cap < participantCount) {
      warnings.push(
        `execution.concurrency ${cap} caps a ${participantCount}-participant roster: participants run in waves of ${cap}, never all live at once. Remove execution.concurrency (the default runs all ${participantCount} participants simultaneously) or set it to ${participantCount}; declare a lower cap only to bound simultaneous paid desktops.`,
      );
    }
  }
  // Partial email coverage is legal but loud: a participant without an addressed recipient never
  // hears an inbox exists, so an email-gated flow on that participant dead-ends by construction.
  if (routes.cua && config.comms?.email?.recipients) {
    const participantIds = declaredParticipantIds(config);
    const covered = new Set(
      addressedRecipients(config.comms.email).map((recipient) => recipient.participantId),
    );
    const uncovered = participantIds.filter((id) => !covered.has(id));
    if (covered.size > 0 && uncovered.length > 0 && participantIds.length > 1) {
      warnings.push(
        `comms.email covers ${covered.size} of ${participantIds.length} participants. These get no inbox and are never told one exists: ${uncovered.join(", ")}. Add a recipient with an address for each one whose flow needs email.`,
      );
    }
  }
  return warnings;
}
