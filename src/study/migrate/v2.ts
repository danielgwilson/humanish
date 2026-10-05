// humanish.lab.v2, read for `humanish migrate`. checkV2 applies the v2 parser's section checks in
// its order and with its messages, and the rules on v2 keys that a humanish.study.v3 file has no
// form for. v2ToV3Raw rewrites the file as a plain v3 record, which parseStudyV3 checks against the
// rules the two formats share. The converter (convert.ts) rewrites the YAML document separately and
// compares what the two rewrites parse to.
//
// The v2 parser itself is gone. The rules here on keys v3 does not have (the actor list and roster,
// `laneFocus`, the `scenario` object, `subject.topology`, `execution.caps`, and the checks on their
// combinations) are kept with that parser's messages, so migrate refuses what it refused.

import { isRecord } from "../../run/type-guards.js";
import {
  ACTOR,
  CAPS,
  EXECUTION,
  findUnknownKey,
  PARTICIPANT_ENTRY,
  SHARED_SECTIONS,
  SUBJECT,
  type KeyShape,
} from "../keys.js";
import {
  parseActorFields,
  parseActorType,
  parseParticipantEntries,
  PARTICIPANT_ID_MAX_CHARS,
  PARTICIPANT_ID_PATTERN,
  type ParticipantPaths,
} from "../parse/actors.js";
import { parseComms } from "../parse/comms.js";
import { parseCaps, parseExecution, parsePolicies, parseReview } from "../parse/execution.js";
import { hasSubjectSource, parseSubject } from "../parse/subject.js";
import { posInt, str } from "../parse/values.js";
import {
  isComputerUseComposition,
  isScriptedBrowserComposition,
  isSharedWorldComposition,
  isTerminalProductComposition,
  routeOf,
  type StudyRoute,
} from "../routing.js";
import {
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  smtpValidationReason,
} from "../validation.js";
import {
  ID_PATTERN,
  STUDY_SCHEMA,
  type StudyActor,
  type StudyCaps,
  type StudyConfig,
  type StudyParticipantEntry,
} from "../types.js";

/** The schema of the study format before humanish.study.v3. */
export const V2_SCHEMA = "humanish.lab.v2";

/** The message for a humanish.lab.v2 document, which the package and the CLI no longer run. */
export const V2_UNSUPPORTED_MESSAGE =
  "This is a humanish.lab.v2 study, which humanish no longer reads. Convert its file with humanish migrate <path>.";

type Raw = Record<string, unknown>;

// The StudyConfig fields of humanish 0.110 and earlier, which a humanish.study.v3 config does not
// have, each with where its value goes now. A library caller may still build a config with them.
const V2_FIELDS: readonly { readonly present: (config: Raw) => boolean; readonly move: string }[] =
  [
    {
      present: (config) => config.actors !== undefined,
      move: "`actors[0]` is `actor`, and its `count`, `lanes`, `roster` and `laneFocus` are `participants` (`surfaces` on the scripted route)",
    },
    {
      present: (config) => isRecord(config.scenario),
      move: "`scenario.ref` is `scenario`, a string, `scenario.mode` is `mode` and `scenario.caps` is `caps`",
    },
    {
      present: (config) => isRecord(config.execution) && config.execution.caps !== undefined,
      move: "`execution.caps` is `caps`",
    },
    {
      present: (config) => isRecord(config.subject) && config.subject.topology !== undefined,
      move: "`subject.topology: shared-world` is `route: shared-world`",
    },
    {
      present: (config) => config.personas !== undefined,
      move: "`personas` has no field now; remove it",
    },
  ];

/** Where each humanish 0.110 StudyConfig field a config still sets went; empty when it sets none. */
export function v2FieldMoves(config: unknown): string[] {
  if (!isRecord(config)) return [];
  return V2_FIELDS.filter((field) => field.present(config)).map((field) => field.move);
}

type Read<T> = { ok: true; value: T } | { ok: false; message: string };

/** `laneFocus`: the steer each of a counted group of participants gets. */
interface V2Focus {
  id?: string;
  label?: string;
  instruction?: string;
}

/** The `scenario` object. */
interface V2Scenario {
  ref?: string;
  mode?: "dry-run" | "live";
  inline?: Raw;
  caps?: StudyCaps;
}

/** A v2 file that checkV2 accepted, as the v2 parser reads it. */
export interface V2Study {
  readonly route: StudyRoute;
  /**
   * The sections that decide the route and that the v2 parser's first cross-section checks read,
   * as a StudyConfig: subject, the actor, execution, policies and comms. Its `route` is the file's
   * route, `shared-world` when `subject.topology` declares one, so routeOf and the composition
   * checks read the declaration as the v2 parser did.
   */
  readonly composition: StudyConfig;
  readonly topology: "per-lane-worlds" | "shared-world" | undefined;
  readonly count: number | undefined;
  /** `actors[0].lanes`, or the participants `actors[0].roster` expands into. */
  readonly entries: readonly StudyParticipantEntry[] | undefined;
  readonly focus: V2Focus | undefined;
  readonly executionCaps: StudyCaps | undefined;
  readonly scenario: V2Scenario | undefined;
  readonly personas: boolean;
  readonly terminalTimeout: boolean;
}

// The keys of a humanish.lab.v2 file, in the order its parser listed them: the v3 sections with
// `subject.topology`, the actor list with its participant keys, `execution.caps`, `personas` and
// the `scenario` object.
const V2_KEYS: KeyShape = {
  schema: true,
  id: true,
  title: true,
  description: true,
  subject: { source: true, topology: true, ...without(SUBJECT, "source") },
  actors: {
    type: true,
    count: true,
    lanes: PARTICIPANT_ENTRY,
    // Roster groups are participants with a count; the parser expanded them into `lanes[]`.
    roster: { ...PARTICIPANT_ENTRY, count: true },
    ...without(ACTOR, "type"),
    laneFocus: { id: true, label: true, instruction: true },
  },
  execution: withAfter(EXECUTION, "egressAllow", { caps: CAPS }),
  // Inline personas were validated by the persona resolver.
  personas: true,
  scenario: { ref: true, mode: true, inline: true, caps: CAPS },
  ...SHARED_SECTIONS,
};

function without(shape: KeyShape, ...keys: string[]): KeyShape {
  return Object.fromEntries(Object.entries(shape).filter(([key]) => !keys.includes(key)));
}

// `shape` with `added` inserted after the key `after`.
function withAfter(shape: KeyShape, after: string, added: KeyShape): KeyShape {
  return Object.fromEntries(
    Object.entries(shape).flatMap((entry) =>
      entry[0] === after ? [entry, ...Object.entries(added)] : [entry],
    ),
  );
}

function refused(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

// The v2 spelling of a participant list and its entries, `actors[0].lanes[3]`.
const ENTRY_PATHS: ParticipantPaths = {
  list: "actors[0].lanes",
  entry: (index) => `actors[0].lanes[${index}]`,
};

/**
 * Check a humanish.lab.v2 file the way the v2 parser does, up to the checks that read more than
 * one section, and then the budget rule those checks apply first. Each refusal is that parser's
 * message.
 */
export function checkV2(raw: Raw): Read<V2Study> {
  const unknownKey = findUnknownKey(raw, V2_KEYS);
  if (unknownKey) return refused(unknownKey);
  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return refused(
      "The study id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).",
    );
  }
  // The v2 parser checked `subject.topology` right after `subject.source`.
  const topology = hasSubjectSource(raw.subject) ? readTopology(raw.subject) : undefined;
  if (topology?.ok === false) return topology;
  const subject = parseSubject(raw.subject);
  if (!subject.ok) return refused(subject.error.message);
  const actor = readActor(raw.actors);
  if (!actor.ok) return actor;
  const execution = readExecution(raw.execution);
  if (!execution.ok) return execution;
  const scenario = readScenario(raw.scenario);
  if (!scenario.ok) return scenario;
  if (
    isRecord(raw.policies) &&
    raw.policies.mediaPermission !== undefined &&
    raw.policies.mediaPermission !== "prompt" &&
    raw.policies.mediaPermission !== "granted"
  ) {
    return refused(
      "`policies.mediaPermission` must be `prompt` (the participant answers the browser's own dialog) or `granted`.",
    );
  }
  const policies = parsePolicies(raw.policies);
  if (!policies.ok) return refused(policies.error.message);
  const review = parseReview(raw.review);
  if (!review.ok) return refused(review.error.message);
  if (isRecord(raw.defaults) && raw.defaults.open !== undefined) {
    if (typeof raw.defaults.open !== "boolean")
      return refused("`defaults.open` must be true or false.");
  }
  const comms = parseComms(raw.comms);
  if (!comms.ok) return refused(comms.error.message);

  const composition: StudyConfig = {
    schema: STUDY_SCHEMA,
    id,
    // A shared world is declared; any other route is derived below.
    route: topology?.value === "shared-world" ? "shared-world" : "computer-use",
    subject: subject.value,
    actor: { type: actor.value.type, ...actor.value.fields },
    ...(execution.value.execution === undefined ? {} : { execution: execution.value.execution }),
    ...(policies.value === undefined ? {} : { policies: policies.value }),
    ...(comms.value === undefined ? {} : { comms: comms.value }),
  };
  const route = v2RouteOf(composition);
  composition.route = route;
  const study: V2Study = {
    route,
    composition,
    topology: topology?.value,
    count: actor.value.count,
    entries: actor.value.entries,
    focus: actor.value.focus,
    executionCaps: execution.value.caps,
    scenario: scenario.value,
    personas: Array.isArray(raw.personas) && raw.personas.some(isRecord),
    terminalTimeout:
      route === "terminal" && isRecord(raw.execution) && raw.execution.timeoutMs !== undefined,
  };
  const budget = scenarioBudgetReason(study);
  if (!budget) return { ok: true, value: study };
  // The checks the v2 parser runs before the budget rule, which are the first it runs across
  // sections, so a file that breaks one of them and the budget rule gets the same refusal.
  return refused(
    smtpValidationReason(composition) ??
      desktopMediaValidationReason(composition) ??
      outputTokenLimitValidationReason(composition) ??
      budget,
  );
}

/**
 * The route a v2 file takes. `subject.topology: shared-world` declares a shared world, as
 * `route: shared-world` does in v3, so a file that declares one its composition does not take gets
 * the shared-world checks' refusal, as it does from the v2 parser.
 */
function v2RouteOf(composition: StudyConfig): StudyRoute {
  return composition.route === "shared-world" ? "shared-world" : routeOf(composition);
}

// parse/subject.ts read `subject.topology` as one of two values.
function readTopology(subject: unknown): Read<V2Study["topology"]> {
  if (!isRecord(subject) || subject.topology === undefined) return { ok: true, value: undefined };
  const topology = str(subject.topology);
  if (topology !== "per-lane-worlds" && topology !== "shared-world") {
    return refused("`subject.topology` must be per-lane-worlds (the default) or shared-world.");
  }
  return { ok: true, value: topology };
}

// parse/execution.ts parseExecution, which read `execution.caps` after `execution.desktop` and
// before `execution.terminal`.
function readExecution(
  raw: unknown,
): Read<{ execution: StudyConfig["execution"]; caps: StudyCaps | undefined }> {
  let caps: StudyCaps | undefined;
  if (isRecord(raw)) {
    const { target, timeoutMs, completionTimeoutMs, concurrency, desktop } = raw;
    const head = parseExecution({ target, timeoutMs, completionTimeoutMs, concurrency, desktop });
    if (!head.ok) return refused(head.error.message);
    const parsed = parseCaps(raw.caps);
    if (!parsed.ok) return refused(parsed.error.message);
    caps = parsed.value;
  }
  // parseExecution reads every key but `caps`.
  const execution = parseExecution(raw);
  if (!execution.ok) return refused(execution.error.message);
  return { ok: true, value: { execution: execution.value, caps } };
}

interface V2Actor {
  type: string;
  fields: Omit<StudyActor, "type">;
  count: number | undefined;
  entries: StudyParticipantEntry[] | undefined;
  focus: V2Focus | undefined;
}

// parse/actors.ts parseActors, for the one actor it accepts.
function readActor(raw: unknown): Read<V2Actor> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return refused("`actors` must be a non-empty array.");
  }
  if (raw.length > 1) {
    return refused(
      "Multiple actors are not supported yet (only the first actor runs); declare a single actor.",
    );
  }
  const entry: unknown = raw[0];
  if (!isRecord(entry)) return refused("actors[0] must be an object.");
  const type = parseActorType(entry, "actors[0]");
  if (!type.ok) return refused(type.error.message);
  const count = posInt(entry.count);
  if (entry.lanes !== undefined && entry.roster !== undefined) {
    return refused(
      "Set either actors[0].lanes or actors[0].roster, not both: list participants one by one in `lanes`, or in groups in `roster`.",
    );
  }
  if (entry.roster !== undefined && count !== undefined) {
    return refused(
      "Set either actors[0].roster or actors[0].count, not both: `roster` declares groups of distinct participants, and `count` declares identical ones.",
    );
  }
  if (entry.roster !== undefined && entry.laneFocus !== undefined) {
    return refused(
      "actors[0].roster and actors[0].laneFocus are mutually exclusive: a roster group's instruction is each participant's steer.",
    );
  }
  let listed: unknown = entry.lanes;
  if (entry.roster !== undefined) {
    const expanded = rosterEntries(entry.roster);
    if (!expanded.ok) return expanded;
    listed = expanded.value;
  }
  const entries = parseParticipantEntries(listed, ENTRY_PATHS);
  if (!entries.ok) return refused(entries.error.message);
  const fields = parseActorFields(entry, "actors[0]");
  if (!fields.ok) return refused(fields.error.message);
  return {
    ok: true,
    value: {
      type: type.value,
      fields: fields.value,
      count,
      entries: entries.value,
      focus: readFocus(entry.laneFocus),
    },
  };
}

const GROUP_KEYS =
  "{ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry?, host?, reasoningEffort?, stopWhen?, dwell? }";

/**
 * `actors[0].roster` groups, each expanded into its participants `<id>-01` to `<id>-NN`, as written:
 * the entries parse after. parse/actors.ts parseRosterGroups.
 */
function rosterEntries(raw: unknown): Read<Raw[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return refused(
      `actors[0].roster must be a non-empty array of group objects (${GROUP_KEYS}) when set.`,
    );
  }
  const expanded: Raw[] = [];
  const seen = new Set<string>();
  for (const [index, group] of raw.entries()) {
    if (!isRecord(group))
      return refused(`actors[0].roster[${index}] must be an object (${GROUP_KEYS}).`);
    const id = str(group.id);
    if (id === undefined) {
      return refused(
        `actors[0].roster[${index}].id is required and must be a public-safe token matching ${PARTICIPANT_ID_PATTERN}.`,
      );
    }
    if (!PARTICIPANT_ID_PATTERN.test(id) || id.length > PARTICIPANT_ID_MAX_CHARS - 3) {
      return refused(
        `actors[0].roster[${index}].id must match ${PARTICIPANT_ID_PATTERN} and be at most ${PARTICIPANT_ID_MAX_CHARS - 3} characters, because each generated participant id adds a suffix like "-01"; "${id}" is not.`,
      );
    }
    if (seen.has(id))
      return refused(`actors[0].roster group ids must be unique (duplicate "${id}").`);
    seen.add(id);
    const count = posInt(group.count);
    if (count === undefined) {
      return refused(
        `actors[0].roster[${index}].count is required and must be a positive integer.`,
      );
    }
    const shared: Raw = { ...group };
    delete shared.id;
    delete shared.count;
    for (let n = 1; n <= count; n += 1)
      expanded.push({ ...shared, id: `${id}-${String(n).padStart(2, "0")}` });
  }
  return { ok: true, value: expanded };
}

// The fields of `laneFocus` that are non-empty strings; undefined when none is. parse/actors.ts
// parseFocus.
function readFocus(raw: unknown): V2Focus | undefined {
  if (!isRecord(raw)) return undefined;
  const focus: V2Focus = {};
  const id = str(raw.id);
  if (id) focus.id = id;
  const label = str(raw.label);
  if (label) focus.label = label;
  const instruction = str(raw.instruction);
  if (instruction) focus.instruction = instruction;
  return Object.keys(focus).length > 0 ? focus : undefined;
}

// parse/execution.ts parseScenario: a `mode` or `ref` it cannot read is read as unset.
function readScenario(raw: unknown): Read<V2Scenario | undefined> {
  if (!isRecord(raw)) return { ok: true, value: undefined };
  const scenario: V2Scenario = {};
  const ref = str(raw.ref);
  if (ref) scenario.ref = ref;
  if (isRecord(raw.inline)) scenario.inline = raw.inline;
  const mode = str(raw.mode);
  if (mode === "dry-run" || mode === "live") scenario.mode = mode;
  const caps = parseCaps(raw.caps);
  if (!caps.ok) return refused(caps.error.message);
  if (caps.value) scenario.caps = caps.value;
  return { ok: true, value: Object.keys(scenario).length > 0 ? scenario : undefined };
}

// validation.ts scenarioCapsValidationReason. The v2 parser applies it after the SMTP, media and
// output-limit checks and before the composition checks, so checkV2 runs it with the first three.
function scenarioBudgetReason(study: V2Study): string | undefined {
  if (!isComputerUseComposition(study.composition)) return undefined;
  for (const key of ["maxUsd", "maxTotalUsd"] as const) {
    const value = study.scenario?.caps?.[key];
    if (value === undefined || value <= 0) continue;
    return `scenario.caps.${key} (${value}) does not cap a computer-use study: this route stops on execution.caps.${key}. Move the value to execution.caps.${key}; scenario.caps applies only to terminal-product studies.`;
  }
  return undefined;
}

/**
 * The refusals the v2 parser gives for shapes a v3 file cannot express, once the checks both
 * formats share have passed on the study without them. A file that also breaks a shared check
 * gets that check's message.
 */
export function v2ShapeReason(study: V2Study): string | undefined {
  const { route, composition, count, entries, focus } = study;
  if (route === "scripted") {
    // composition-rules.ts scriptedBrowserValidationReason, in its order.
    if (composition.subject.source === "clone" && study.topology !== undefined) {
      return "A clone scripted-browser study does not support `subject.topology` yet: it runs one synthetic subject for its scripted actor. Remove `subject.topology`.";
    }
    if ((count ?? 1) > 2) {
      return "A scripted-browser study takes `surfaces` 1 (desktop) or 2 (desktop and mobile). Higher counts are not supported yet.";
    }
    if (composition.subject.source === "clone" && entries !== undefined) {
      return "`participants` is not supported on the scripted-browser route yet. Use `surfaces` to choose the desktop and mobile surfaces.";
    }
  }
  // validation.ts computerUseValidationReason.
  if (isComputerUseComposition(composition) && entries !== undefined) {
    if (count !== undefined) {
      return "Set either `actors[0].count` (identical participants) or `actors[0].lanes` (a roster of distinct participants), not both.";
    }
    if (focus !== undefined) {
      return "actors[0].laneFocus and actors[0].lanes are mutually exclusive: each roster entry's `instruction` is the fan-out steer; laneFocus is the steer for a single participant.";
    }
  }
  // composition-rules.ts terminalValidationReason.
  if (route === "terminal" && (count ?? 1) > 1) {
    return "Terminal fan-out to more than one participant is not supported yet; set participants to 1.";
  }
  // substrates/local/runtime-config.ts localBrowserUnsupportedReason: a local Codex participant
  // takes no dollar cap, and the v2 parser counts one in scenario.caps too.
  const caps = study.scenario?.caps;
  if (
    composition.subject.source === "app-url" &&
    composition.execution?.target === "local" &&
    composition.actor.type === "local-agent" &&
    (caps?.maxUsd !== undefined || caps?.maxTotalUsd !== undefined)
  ) {
    return "Local Codex participants currently use gpt-6-astra at low effort. Account dollar/output-token caps are unavailable; use API participants for those controls.";
  }
  return undefined;
}

// The caps keys each route reads, as parse/front.ts CAPS_KEYS has them.
const CAPS_READ: Readonly<Record<StudyRoute, readonly (keyof StudyCaps)[]>> = {
  preview: [],
  "computer-use": ["maxUsd", "maxTotalUsd"],
  "shared-world": ["maxUsd", "maxTotalUsd"],
  terminal: ["maxUsd", "maxJobs", "maxMinutes"],
  scripted: [],
};

/**
 * A v2 file as a plain humanish.study.v3 record, for parseStudyV3 and parseStudy. It reads each key
 * it moves the way the v2 parser reads it (`count` as a positive integer, `laneFocus` through its
 * string fields, `roster` groups expanded, `scenario.ref` and `scenario.mode` as strings), and
 * leaves out every key no v3 file can hold, so it parses whenever the v2 parser would. A caps
 * block keeps the keys its route reads. A shared world keeps a count or no list, which only
 * parseStudyV3's report mode takes.
 */
export function v2ToV3Raw(raw: Raw, route: StudyRoute): Raw {
  const listed = Array.isArray(raw.actors) && isRecord(raw.actors[0]) ? raw.actors[0] : {};
  const { count: rawCount, lanes, roster, laneFocus, ...actor } = listed;
  const count = posInt(rawCount);
  const expanded = roster === undefined ? undefined : rosterEntries(roster);
  const entries = expanded?.ok ? expanded.value : Array.isArray(lanes) ? lanes : undefined;
  const instruction = readFocus(laneFocus)?.instruction;
  const scenario = isRecord(raw.scenario) ? raw.scenario : {};
  const mode = str(scenario.mode);
  const ref = str(scenario.ref);

  let participants: unknown;
  if (route === "preview") participants = count;
  else if (route === "computer-use" || route === "shared-world") {
    participants =
      entries ??
      (instruction === undefined
        ? count
        : { ...(count === undefined ? {} : { count }), instruction });
  }
  const surfaces =
    route !== "scripted"
      ? undefined
      : count === 2
        ? ["desktop", "mobile"]
        : count === 1
          ? ["desktop"]
          : undefined;

  const block =
    route === "terminal" ? scenario.caps : isRecord(raw.execution) ? raw.execution.caps : undefined;
  const caps = isRecord(block)
    ? Object.fromEntries(
        Object.entries(block).filter(([key]) =>
          (CAPS_READ[route] as readonly string[]).includes(key),
        ),
      )
    : {};
  const execution = isRecord(raw.execution) ? { ...raw.execution } : undefined;
  delete execution?.caps;
  if (route === "terminal") delete execution?.timeoutMs;
  const subject = isRecord(raw.subject) ? { ...raw.subject } : raw.subject;
  if (isRecord(subject)) delete subject.topology;

  const v3: Raw = { schema: STUDY_SCHEMA };
  const fields: [string, unknown][] = [
    ["id", raw.id],
    ["title", raw.title],
    ["description", raw.description],
    ["route", route],
    ["mode", mode === "dry-run" || mode === "live" ? mode : undefined],
    ["subject", subject],
    ["actor", actor],
    ["participants", participants],
    ["surfaces", surfaces],
    ["caps", Object.keys(caps).length > 0 ? caps : undefined],
    ["execution", execution],
    ["scenario", ref],
    ["policies", raw.policies],
    ["review", raw.review],
    ["defaults", raw.defaults],
    ["comms", raw.comms],
  ];
  for (const [key, value] of fields) if (value !== undefined) v3[key] = value;
  return v3;
}

interface Routes {
  cua: boolean;
  terminal: boolean;
  scripted: boolean;
  shared: boolean;
}

function routesOf({ composition }: V2Study): Routes {
  return {
    cua: isComputerUseComposition(composition),
    terminal: isTerminalProductComposition(composition),
    scripted: isScriptedBrowserComposition(composition),
    shared: isSharedWorldComposition(composition),
  };
}

// The keys that have no v3 form on the file's route, which the v2 parser's inert-field table
// (warnings.ts) lists. The computer-use and terminal routes read the `laneFocus` instruction, and
// only the computer-use routes read a list.
const V2_DROP_ROWS: readonly {
  readonly path: string;
  readonly applies: (study: V2Study, routes: Routes) => boolean;
}[] = [
  {
    path: "actors[0].laneFocus.id",
    applies: (study, routes) => (routes.cua || routes.terminal) && study.focus?.id !== undefined,
  },
  {
    path: "actors[0].laneFocus.label",
    applies: (study, routes) => (routes.cua || routes.terminal) && study.focus?.label !== undefined,
  },
  {
    path: "actors[0].laneFocus",
    applies: (study, routes) => !routes.cua && !routes.terminal && study.focus !== undefined,
  },
  {
    path: "actors[0].lanes",
    applies: (study, routes) => !routes.cua && study.entries !== undefined,
  },
  {
    path: "subject.topology",
    applies: (study, routes) => !routes.shared && study.topology !== undefined,
  },
  {
    path: "execution.caps",
    applies: (study, routes) => !routes.cua && study.executionCaps !== undefined,
  },
  {
    path: "scenario.caps",
    applies: (study, routes) => !routes.terminal && study.scenario?.caps !== undefined,
  },
  {
    path: "scenario.caps.maxTotalUsd",
    applies: (study, routes) => routes.terminal && study.scenario?.caps?.maxTotalUsd !== undefined,
  },
  { path: "scenario.inline", applies: (study) => study.scenario?.inline !== undefined },
  { path: "personas", applies: (study) => study.personas },
];

// Every key migrate may drop, in the order the inert-field table lists them, which is the order
// migrate drops and reports them.
const DROP_ORDER = [
  "actors[0].lanes[].entry",
  "actors[0].lanes[].host",
  "actors[0].laneFocus.id",
  "actors[0].laneFocus.label",
  "actors[0].mission",
  "actors[0].laneFocus",
  "actors[0].persona",
  "actors[0].model",
  "actors[0].lanes",
  "subject.clone.depth",
  "subject.serve",
  "subject.env",
  "subject.state",
  "subject.topology",
  "subject.state.checkpoint",
  "subject.publicTarget",
  "subject.exposure",
  "comms.email",
  "comms.email.external",
  "execution.timeoutMs",
  "execution.completionTimeoutMs",
  "execution.concurrency",
  "execution.caps",
  "subject.product",
  "scenario.caps",
  "scenario.caps.maxTotalUsd",
  "execution.terminal",
  "execution.runtimeAuth",
  "execution.runtime",
  "execution.desktop.resolution",
  "execution.desktop.device",
  "execution.desktop.browser",
  "execution.desktop.fidelity",
  "execution.desktop.sandboxTimeoutMs",
  "execution.desktop.template",
  "execution.desktop.codexAppServer",
  "scenario.ref",
  "scenario.inline",
  "review.scoring",
  "review.milestones",
  "review.vocabulary",
  "review.scorer",
  "personas",
];

/**
 * The v2 path of a field parseStudyV3 reports in report mode. Each of these keys exists in both
 * formats: `actor.<key>` is `actors[0].<key>`, a `participants` entry's key is
 * `actors[0].lanes[].<key>` (field-paths.ts finds it under `roster` when the file has one), `mode`
 * is `scenario.mode` and `scenario` is `scenario.ref`. Every other path is the same.
 */
function v2PathOf(path: string): string {
  if (path.startsWith("actor.")) return `actors[0].${path.slice("actor.".length)}`;
  if (path.startsWith("participants[]")) {
    return `actors[0].lanes[]${path.slice("participants[]".length)}`;
  }
  if (path === "mode") return "scenario.mode";
  if (path === "scenario") return "scenario.ref";
  return path;
}

/**
 * The keys migrate drops: the v2-only rows above and `inert`, the fields parseStudyV3 reports the
 * route does not read (v3 paths, mapped back to the file's), then terminal `execution.timeoutMs`,
 * which no terminal code reads. Parents come before their children, so a child under a dropped
 * parent is reported with the parent.
 */
export function droppedPaths(study: V2Study, inert: readonly string[]): string[] {
  const routes = routesOf(study);
  const found = new Set([
    ...inert.map(v2PathOf),
    ...V2_DROP_ROWS.filter((row) => row.applies(study, routes)).map((row) => row.path),
  ]);
  const paths = [
    ...DROP_ORDER.filter((path) => found.has(path)),
    ...[...found].filter((path) => !DROP_ORDER.includes(path)),
  ];
  if (study.terminalTimeout) paths.push("execution.timeoutMs");
  const depth = (path: string) => path.split(".").length;
  return [...new Set(paths)].sort((left, right) => depth(left) - depth(right));
}
