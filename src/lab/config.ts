// humanish.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
//
// HONEST SCOPE (read before trusting field names): the engine routes by
// subject.source × execution.target (disambiguated by the actor lane where both axes
// collide) and consumes a deliberately small set of fields:
//   subject.source/repos/appUrl/serve/env/state/clone.{depth,fanout,keep}, actors[0].count,
//   execution.target + execution.desktop.codexAppServer, scenario.mode,
//   policies.redactRepos, defaults.open.
// On the computer-use routes (app-url × e2b-desktop, and clone × e2b-desktop with a
// computer-use actor), `actors[0].type` IS load-bearing: it must resolve to a registered
// computer-use actor, and that descriptor runs the session. Those routes also consume
// actors[0].{mission,persona,laneFocus.instruction,model,reasoningEffort}, execution.timeoutMs,
// execution.desktop.{browser,resolution,sandboxTimeoutMs}, and (clone)
// subject.{serve,env,state,clone.depth}.
// On the scripted-browser route (app-url × local-or-absent, or clone × e2b-desktop, with a
// registered scripted-browser actor), `actors[0].type` is equally load-bearing, and the route
// consumes scenario.ref (REQUIRED there — the committed scenario's browser steps ARE what the
// actor executes), actors[0].{persona,count}, and execution.timeoutMs. On the provisioned
// clone slice it also consumes subject.{repos,serve,env,state,exposure,clone.depth} and
// execution.desktop.template. actors[0].{mission,laneFocus,model} are inert on that route
// because no model runs, and most execution.desktop.* fields remain forward-declared (device
// presets belong to the cua route — scripted surfaces are the driver's own desktop/mobile
// viewports where isMobile/DSF genuinely RENDER via playwright emulation).
// On the other routes those fields remain FORWARD-DECLARED and NOT yet consumed —
// parseLabConfig emits a warning listing any such field that is set, so `lab inspect` shows
// the truth.
//
// NOTE on actors[0].count: it now carries ROUTE-SPECIFIC meanings — synthetic route: simCount;
// scripted-browser route: surface roster {1 = desktop, 2 = desktop + mobile}, default 1 (the
// defaults-table single-lane row governs; count: 2 is the declared override); computer-use
// E2B route: the HOMOGENEOUS fan-out lane count (N identical lanes, each its own E2B desktop),
// capped at 16; the in-process/local-app cua route stays single lane (no E2B to fan out).
//
// NOTE on actors[0].lanes / actors[0].roster (computer-use E2B route, this slice): a
// DIFFERENTIATED fan-out roster — each `{ id?, persona?, device?, instruction?, target? }` becomes one
// independent E2B desktop (per-lane worlds, the default topology). `roster[]` is parser sugar for
// repeated groups and is normalized into `lanes[]` before the engine sees it. `lanes|roster` XOR
// `count` (declare a differentiated roster OR a homogeneous count, never both); `lanes|roster`
// XOR `actors[0].laneFocus` (per-lane `instruction` is the roster's steer); `lanes[].device` XOR
// raw `execution.desktop.resolution`. `execution.concurrency` bounds in-flight lanes (default
// min(laneCount, 3); env HUMANISH_CUA_MAX_CONCURRENCY may only LOWER it — invariant 3). On every
// non-cua route normalized `lanes` are inert (warned). subject.clone.fanout is REJECTED on the cua
// route. `lanes[].target` is app-url × computer-use ONLY: an absolute browser URL this lane opens
// instead of `subject.appUrl`; it is the generic setup-produced-target handoff, not a service
// topology primitive.
//
// There is deliberately NO v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

import {
  isLocalBrowserLab,
  localBrowserDefaults,
  localBrowserUnsupportedReason,
} from "../substrates/local/runtime-config.js";
import { findUnknownLabKey } from "./keys.js";
import { parseActors } from "./parse-actors.js";
import { parseComms } from "./parse-comms.js";
import {
  parseDefaults,
  parseExecution,
  parsePersonas,
  parsePolicies,
  parseReview,
  parseScenario,
} from "./parse-execution.js";
import { isLoopbackUrl, parseSubject } from "./parse-subject.js";
import { invalid, isRecord, optionalStr, REPO_SLUG_PATTERN, str } from "./parse-values.js";
import {
  actorResolvesToComputerUse,
  actorResolvesToScriptedBrowser,
  actorResolvesToTerminal,
  cuaLaneCount,
  declaredLaneTargets,
  effectiveComputerUseLaneIds,
  registeredComputerUseActors,
  registeredScriptedBrowserActors,
  registeredTerminalActors,
  routesToComputerUse,
} from "./routing.js";
import {
  ID_PATTERN,
  LAB_CONFIG_SCHEMA,
  type LabConfig,
  type LabConfigParseResult,
} from "./types.js";
import {
  automaticAnalysisRouteReason,
  concurrentSharedWorldValidationReason,
  cuaLaneValidationReason,
  desktopMediaValidationReason,
  externalPublicSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  taskProtocolValidationReason,
} from "./validation.js";
import { forwardDeclaredWarnings } from "./warnings.js";

/**
 * Validate a parsed YAML object into a LabConfig. Pure: the caller owns file IO. Structural
 * validation only. Fields the engine does not yet consume are accepted but reported in
 * `warnings` so `lab inspect` never silently swallows a setting that does nothing.
 */
export function parseLabConfig(raw: unknown): LabConfigParseResult {
  if (!isRecord(raw)) {
    return invalid("Lab manifest must be a YAML object.");
  }
  if (raw.schema !== LAB_CONFIG_SCHEMA) {
    return invalid(`Lab schema must be ${LAB_CONFIG_SCHEMA}.`);
  }
  const unknownKey = findUnknownLabKey(raw);
  if (unknownKey) return invalid(unknownKey);

  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return invalid(
      "Lab id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).",
    );
  }

  const subjectResult = parseSubject(raw.subject);
  if (!subjectResult.ok) {
    return subjectResult;
  }

  const actorsResult = parseActors(raw.actors);
  if (!actorsResult.ok) {
    return actorsResult;
  }

  const executionResult = parseExecution(raw.execution);
  if (!executionResult.ok) {
    return executionResult;
  }

  const config: LabConfig = {
    schema: LAB_CONFIG_SCHEMA,
    id,
    ...optionalStr("title", raw.title),
    ...optionalStr("description", raw.description),
    subject: subjectResult.value,
    actors: actorsResult.value,
    ...(executionResult.value ? { execution: executionResult.value } : {}),
  };

  const personas = parsePersonas(raw.personas);
  if (personas) config.personas = personas;
  const scenarioResult = parseScenario(raw.scenario);
  if (!scenarioResult.ok) {
    return scenarioResult;
  }
  if (scenarioResult.value) config.scenario = scenarioResult.value;
  if (
    isRecord(raw.policies) &&
    raw.policies.mediaPermission !== undefined &&
    raw.policies.mediaPermission !== "prompt" &&
    raw.policies.mediaPermission !== "granted"
  ) {
    return invalid(
      "`policies.mediaPermission` must be `prompt` (the participant answers the browser's own dialog) or `granted`.",
    );
  }
  const policiesResult = parsePolicies(raw.policies);
  if (!policiesResult.ok) return policiesResult;
  if (policiesResult.value) config.policies = policiesResult.value;
  const reviewResult = parseReview(raw.review);
  if (!reviewResult.ok) return reviewResult;
  if (reviewResult.value) config.review = reviewResult.value;
  if (raw.defaults !== undefined && isRecord(raw.defaults) && raw.defaults.open !== undefined) {
    if (typeof raw.defaults.open !== "boolean")
      return invalid("`defaults.open` must be true or false.");
  }
  const defaults = parseDefaults(raw.defaults);
  if (defaults) config.defaults = defaults;
  const commsResult = parseComms(raw.comms);
  if (!commsResult.ok) return commsResult;
  if (commsResult.value) config.comms = commsResult.value;
  if (config.comms?.email?.smtp && config.subject.topology === "shared-world") {
    return invalid(
      "SMTP capture is not yet wired for shared-world studies. Use per-lane worlds for SMTP, or configure supported HTTP email capture for concurrent shared-world studies.",
    );
  }

  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return invalid(mediaReason);

  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason) return invalid(outputLimitReason);

  // All-parallel default (#350): a multi-seat computer-use lab that does not declare
  // execution.concurrency runs EVERY seat at once — the declared field is a cap the author chose,
  // never a mode. A throttle default silently turned "N actors live" into waves of 3 in the field;
  // total sessions and spend are identical either way, only simultaneity differs, so the default
  // follows the author's roster. Resolved here at parse time so routing, validation, warnings,
  // and both engines all see one explicit number.
  {
    const seats = config.actors[0]?.lanes?.length ?? config.actors[0]?.count ?? 1;
    if (seats > 1 && config.execution?.concurrency === undefined && routesToComputerUse(config)) {
      config.execution = { ...config.execution, concurrency: seats };
    }
  }

  // Email that just works (#351): the funnel's ONLY handoff to an actor is the per-lane inbox
  // instruction, gated on recipients[]. Guessed lane names broke a field run — recipients copied
  // from a single-lane example matched nothing, so every actor was left inbox-blind with zero
  // signal. Omitted recipients are therefore FILLED (one deterministic address per lane); a
  // recipient naming an unknown lane is a hard error listing the real lane ids; declared
  // recipients covering zero lanes are a hard error (a guaranteed-dead funnel).
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason) return invalid(receivingReason);
  if (config.comms?.email?.kind === "fake" && routesToComputerUse(config)) {
    const laneIds = effectiveComputerUseLaneIds(config);
    const email = config.comms.email;
    if (email.recipients === undefined) {
      email.recipients = laneIds.map((lane) => ({
        lane,
        address: `${lane.toLowerCase()}@example.test`,
      }));
    } else {
      const unknown = email.recipients.filter((recipient) => !laneIds.includes(recipient.lane));
      if (unknown.length > 0) {
        return invalid(
          `comms.email.recipients name lane(s) that do not exist: ${unknown.map((r) => `"${r.lane}"`).join(", ")}. This lab's lane ids are: ${laneIds.join(", ")}. A recipient's lane must match one of them exactly — the inbox instruction is injected per lane, and a mismatch disables the email funnel for that seat.`,
        );
      }
      if (!email.recipients.some((recipient) => recipient.address !== undefined)) {
        return invalid(
          "comms.email.recipients cover no lane with an address — no actor would be told an inbox exists and no captured mail could match. Give at least one recipient an address, or omit `recipients` entirely (every lane then gets a deterministic address automatically).",
        );
      }
    }
  }

  // this-repo subjects run locally and dry-run only — there is no live execution target for the
  // host repo (clone/app-url provide that). Reject the mis-configs rather than silently mishandle.
  if (config.subject.source === "this-repo") {
    if (config.execution?.target) {
      return invalid(
        "`execution.target` applies only to clone/app-url/local-app subjects; this-repo labs run locally.",
      );
    }
    if (config.scenario?.mode === "live") {
      return invalid(
        "this-repo labs are dry-run only; use a clone or app-url subject for a live run.",
      );
    }
  }

  // local-app route: an already-running LOCAL dev server driven IN-PROCESS via a custom
  // CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed: a computer-use actor
  // only, execution.target local or absent (NEVER e2b-desktop — the whole point is to skip the
  // desktop), and no public-target policy (it is always loopback; the loopback shape was already
  // enforced in parseSubject). The actual "no buildExecutor hook supplied" case is inherently an
  // engine-time decision (the parser cannot know whether a library caller will pass hooks), so
  // it fails closed in runCuaActorLab with HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR.
  if (config.subject.source === "local-app") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "local") {
      return invalid(
        "local-app subjects drive an in-process LOCAL dev server with NO E2B desktop — set `execution.target: local` or omit it (absent means local); `e2b-desktop` is rejected (use an app-url subject for the hosted-desktop route).",
      );
    }
    if (!actorResolvesToComputerUse(type)) {
      return invalid(
        `actors[0].type must be a registered computer-use actor for local-app subjects (one of: ${registeredComputerUseActors().join(", ")}); the caller's custom executor runs the computer-use loop. Got "${type}".`,
      );
    }
    if (cuaLaneCount(config) > 1) {
      return invalid(
        "Multi-lane fan-out is not supported on the in-process/local-app route — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips; set actors[0].count to 1 and drop actors[0].lanes (use an app-url or clone subject on execution.target: e2b-desktop for fan-out).",
      );
    }
    if (config.actors[0]?.lanes !== undefined) {
      return invalid(
        "`actors[0].lanes` (fan-out roster) is not supported on the in-process/local-app route — it provisions one E2B desktop per lane, which this route skips. Use an app-url or clone subject with execution.target: e2b-desktop.",
      );
    }
    if (config.policies?.allowPublicTargets === true) {
      return invalid(
        "`policies.allowPublicTargets` is not supported on the local-app route — a local-app subject is always a loopback dev server; there is no public target to allow.",
      );
    }
  }

  // app-url routes: the actor type is a REAL dispatch key (registry-resolved). The actor LANE
  // picks the substrate: a scripted-browser actor runs locally against the declared loopback
  // app; a computer-use actor drives a hosted desktop browser. Fail closed on mis-configs.
  if (config.subject.source === "app-url") {
    const type = config.actors[0]?.type ?? "";
    if (actorResolvesToScriptedBrowser(type)) {
      // Scripted-browser route (all fail-closed: invariant 6 — a field that cannot act on
      // this route is rejected, never silently ignored).
      if (config.execution?.target !== undefined && config.execution.target !== "local") {
        return invalid(
          "scripted-browser actors run on the operator's machine — set `execution.target: local` or omit it (absent means local); in-sandbox scripted execution is a later slice.",
        );
      }
      if (!config.scenario?.ref) {
        return invalid(
          "scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes; there is no built-in fallback on the lab route.",
        );
      }
      if ((config.actors[0]?.count ?? 1) > 2) {
        return invalid(
          "scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.",
        );
      }
      if (config.policies?.redactScreenshots === true) {
        return invalid(
          "`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.",
        );
      }
      if (config.policies?.allowPublicTargets === true) {
        return invalid(
          "`policies.allowPublicTargets` is not supported on the scripted-browser route — the scripted step driver enforces loopback at every navigation; public targets on this route are a later slice.",
        );
      }
      if (!isLoopbackUrl(config.subject.appUrl ?? "")) {
        return invalid(
          "`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on the scripted-browser route.",
        );
      }
    } else {
      if (config.execution?.target !== "e2b-desktop" && config.execution?.target !== "local") {
        return invalid(
          "app-url computer-use subjects require `execution.target: local` or `e2b-desktop`.",
        );
      }
      if (!actorResolvesToComputerUse(type)) {
        return invalid(
          `actors[0].type must be a registered computer-use actor for app-url × e2b-desktop labs (one of: ${registeredComputerUseActors().join(", ")}); for local scripted execution use a registered scripted-browser actor (${registeredScriptedBrowserActors().join(", ")}). Got "${type}".`,
        );
      }
      // Multi-lane fan-out is CONSUMED on this route (per-lane worlds; the shared cua-lane
      // cross-validation below enforces lanes/count XOR rules, the 16 cap, and the
      // lane-level target gates, and the allowPublicTargets+N>1 rejection for ambiguous one-target
      // fan-out).
      // Loopback by default; an owner may declare a public/preview target via policies.
      const laneTargets = declaredLaneTargets(config);
      const declaredTargets = [config.subject.appUrl ?? "", ...laneTargets];
      const unsafeTarget = declaredTargets.find(
        (target) => !config.policies?.allowPublicTargets && !isLoopbackUrl(target),
      );
      if (unsafeTarget !== undefined) {
        return invalid(
          "`subject.appUrl` and `actors[0].lanes[].target` must be loopback URLs (127.0.0.1/localhost) unless `policies.allowPublicTargets: true` is set — set it to drive deployed/preview URLs you own.",
        );
      }
    }
  } else if (actorResolvesToScriptedBrowser(config.actors[0]?.type)) {
    if (config.subject.source !== "clone") {
      return invalid(
        "scripted-browser actors require `subject.source: app-url` (a running app at a loopback URL) or `subject.source: clone` with `execution.target: e2b-desktop` (a provisioned synthetic subject).",
      );
    }
    if (config.execution?.target !== "e2b-desktop") {
      return invalid(
        "clone subjects with scripted-browser actors require `execution.target: e2b-desktop` — the lab provisions the clone in E2B, exposes it with getHost, then drives deterministic browser steps.",
      );
    }
    if (!config.subject.serve) {
      return invalid(
        "clone subjects with scripted-browser actors require `subject.serve` (start + url) — the lab serves the app in-sandbox before the scripted browser drives it.",
      );
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return invalid("clone scripted-browser labs require exactly one repo in subject.repos.");
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return invalid(`subject.repos[0] must be an owner/repo slug (got "${repo}").`);
    }
    if (config.subject.topology !== undefined) {
      return invalid(
        "clone scripted-browser labs do not support `subject.topology` yet — this slice provisions one synthetic subject and one deterministic scripted actor roster, not a shared-world run.",
      );
    }
    if (config.subject.clone?.fanout !== undefined || config.subject.clone?.keep === true) {
      return invalid(
        "clone scripted-browser labs do not support `subject.clone.fanout` or `subject.clone.keep` yet — the provisioned subject is always a single disposable E2B sandbox.",
      );
    }
    if (!config.scenario?.ref) {
      return invalid(
        "scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes; there is no built-in fallback on the lab route.",
      );
    }
    if ((config.actors[0]?.count ?? 1) > 2) {
      return invalid(
        "scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.",
      );
    }
    if (config.actors[0]?.lanes !== undefined) {
      return invalid(
        "`actors[0].lanes` is not supported on the scripted-browser route yet — use actors[0].count for the deterministic surface roster.",
      );
    }
    if (config.policies?.redactScreenshots === true) {
      return invalid(
        "`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.",
      );
    }
    if (config.policies?.allowPublicTargets === true) {
      return invalid(
        "`policies.allowPublicTargets` is not supported on the clone scripted-browser route — the only external host is the harness-minted getHost URL for a provisioned synthetic subject.",
      );
    }
    if (config.subject.exposure !== "synthetic") {
      return invalid(
        "clone scripted-browser labs require `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data.",
      );
    }
    if (
      !config.subject.state?.seed ||
      config.subject.state.seed.length === 0 ||
      (config.subject.state.external?.length ?? 0) > 0
    ) {
      return invalid(
        "clone scripted-browser labs require `subject.state.seed` and do not allow `subject.state.external` — getHost-exposed subjects must be synthetic seeded data, not external/unpinned state.",
      );
    }
    if (!config.subject.serve.start.includes("0.0.0.0")) {
      return invalid(
        "clone scripted-browser labs require `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; the readiness probe stays loopback.",
      );
    }
  }

  // clone × e2b-desktop disambiguates on the actor lane: a computer-use actor means the lab
  // clones AND serves the subject in-sandbox, then drives it (the meta route otherwise).
  if (
    config.subject.source === "clone" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(config.actors[0]?.type)
  ) {
    if (!config.subject.serve) {
      return invalid(
        "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox before the actor drives it.",
      );
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return invalid(
        "computer-use clone labs run a single lane; declare exactly one repo in subject.repos.",
      );
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return invalid(`subject.repos[0] must be an owner/repo slug (got "${repo}").`);
    }
    // Fan-out is CONSUMED here: N lanes each clone the SAME single repo into their own E2B
    // desktop (per-lane worlds). The shared cua-lane cross-validation below enforces the
    // lanes/count rules and the 16 cap; the single-repo rule above is unchanged.
  }

  // local-tree route: packs and uploads the operator's own working tree, then serves it exactly
  // like a computer-use clone subject. There is no smoke/meta/scripted equivalent for a packed
  // working tree in this slice, so e2b-desktop + a computer-use actor are the ONLY combination
  // this source supports. `subject.serve` is already required at parse time (parseSubject); the
  // repos/clone rejection also already happened there (local-tree never carries git slugs).
  if (config.subject.source === "local-tree") {
    if (config.execution?.target !== "e2b-desktop") {
      return invalid(
        "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox; there is no local/smoke route for a local-tree subject.",
      );
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
      return invalid(
        `actors[0].type must be a registered computer-use actor for local-tree subjects (one of: ${registeredComputerUseActors().join(", ")}); the actor drives the hosted desktop that serves the packed working tree. Got "${config.actors[0]?.type ?? ""}".`,
      );
    }
  }

  // Shared computer-use fan-out cross-validation (per-lane worlds, the only topology this
  // slice). Runs for every route that resolves to the cua backend (app-url, clone, local-app).
  // The in-process/local-app route already forced a single lane above, so this is a no-op there
  // beyond rejecting the same fields; on the E2B routes it enforces the roster contract.
  if (routesToComputerUse(config)) {
    const reason = cuaLaneValidationReason(config);
    if (reason) {
      return invalid(reason);
    }
  }

  // Shared-world topology cross-validation (#164). Runs whenever shared-world is DECLARED (not just
  // when it routes), so a half-declared shared-world fails closed with a precise reason rather than
  // silently downgrading to a per-lane-worlds cua run.
  if (config.subject.topology === "shared-world") {
    const reason =
      config.subject.source === "app-url"
        ? // The external-public plane (a real public deployment as the shared plane): NEVER the getHost
          // synthetic gate — that gate exists because getHost is internet-reachable AND harness-owned; a
          // public site the harness neither provisioned nor exposed has neither property.
          externalPublicSharedWorldValidationReason(config)
        : concurrentSharedWorldValidationReason(config);
    if (reason) {
      return invalid(reason);
    }
  }

  // desktop-cli route: a computer-use participant studies a CLI/TUI the way a person does — at a
  // desktop, in a terminal window, by looking at it. The sibling of terminal-product, and the
  // distinction is the POPULATION, not the product: terminal-product sends an autonomous agent
  // through a pipe with stdin disabled, which is the honest way to study what an agent meets and
  // structurally cannot study an interactive surface. This route sends someone who can see it.
  //
  // Fail-closed on the pairing (invariant 6): a hosted desktop and a computer-use actor, because
  // "watch a person use a terminal" is not something the other substrates can do.
  if (config.subject.source === "desktop-cli") {
    if (config.subject.product?.name === undefined) {
      return invalid(
        "desktop-cli subjects need `subject.product.name` — the CLI the participant is being asked to use.",
      );
    }
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-desktop") {
      return invalid(
        "desktop-cli subjects are studied at a hosted desktop — set `execution.target: e2b-desktop` or omit it.",
      );
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type ?? "")) {
      return invalid(
        "desktop-cli subjects need a registered computer-use actor: the participant reads the screen and types, which is what makes an interactive surface studiable at all.",
      );
    }
    const install = config.subject.product.install;
    if (install !== undefined && install.trim().length === 0) {
      return invalid(
        "`subject.product.install` must be a non-empty command when set (omit it to study the install itself).",
      );
    }
  }

  // terminal-product route: a real autonomous agent studies a CLI/product from PUBLIC surfaces
  // inside an E2B shell. Fail-closed (invariant 6 — a field that cannot act on this route is an
  // honest parse error): a registered terminal actor only, execution.target e2b-terminal or absent
  // (absent defaults to e2b-terminal — the only honest target for an in-sandbox agent), single
  // lane until fan-out lands.
  if (config.subject.source === "terminal-product") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-terminal") {
      return invalid(
        "terminal-product subjects run the agent inside an E2B shell — set `execution.target: e2b-terminal` or omit it (absent means e2b-terminal); `local`/`e2b-desktop` are rejected.",
      );
    }
    if (!actorResolvesToTerminal(type)) {
      return invalid(
        `actors[0].type must be a registered terminal actor for terminal-product subjects (one of: ${registeredTerminalActors().join(", ")}). Got "${type}".`,
      );
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return invalid("Multi-lane terminal fan-out is not supported yet; set actors[0].count to 1.");
    }
  } else if (config.execution?.target === "e2b-terminal") {
    // e2b-terminal is the terminal-product substrate ONLY. Any other source declaring it is a
    // mis-config — reject, never silently mishandle (mirrors app-url's e2b-desktop pairing rule).
    return invalid(
      "`execution.target: e2b-terminal` requires `subject.source: terminal-product` with a registered terminal actor.",
    );
  } else if (actorResolvesToTerminal(config.actors[0]?.type)) {
    // A registered terminal actor on a non-terminal-product subject: rejected, never ignored (the
    // terminal agent only studies a declared terminal-product from public surfaces).
    return invalid(
      "terminal actors require `subject.source: terminal-product` (a CLI/product the agent studies from public surfaces); other subjects are not supported on this route.",
    );
  }

  const tasksReason = taskProtocolValidationReason(config);
  if (tasksReason) return invalid(tasksReason);

  const analysisReason = automaticAnalysisRouteReason(config);
  if (analysisReason) return invalid(analysisReason);
  const normalized = localBrowserDefaults(config);
  if (isLocalBrowserLab(normalized)) {
    const reason = localBrowserUnsupportedReason(normalized);
    if (reason) return invalid(reason);
  }
  return { ok: true, config: normalized, warnings: forwardDeclaredWarnings(normalized) };
}
