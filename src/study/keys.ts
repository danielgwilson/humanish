// Every mapping key parseStudy reads, by path. A key that is not listed fails the study as
// unknown, so a typo stops the run instead of being dropped. `true` marks a leaf: its parser
// checks the value (scalars, lists, and mappings that check their own keys). Each level satisfies
// the parsed type's keys, so a field added to a Study* interface must be added here too.
// migrate/v2.ts builds the humanish.lab.v2 table from the exported sections.

import type { DwellWindow, StopWhen, StopWhenRule } from "../actors/stop-conditions.js";
import type { StudyTask } from "./tasks.js";
import type {
  StudyCaps,
  StudyConfig,
  StudyParticipantEntry,
  StudyParticipantGroup,
  StudySubject,
} from "./types.js";

export type KeyShape = { readonly [key: string]: true | KeyShape };
// Exactly the keys of T: a missing or extra key is a compile error, so this table cannot drift
// from the parsed types.
type Keys<T> = { readonly [K in keyof Required<T>]: true | KeyShape };
type Field<T, K extends keyof T> = NonNullable<T[K]>;

type Execution = Field<StudyConfig, "execution">;
type Desktop = Field<Execution, "desktop">;
type Email = Field<Field<StudyConfig, "comms">, "email">;
type State = Field<StudySubject, "state">;

const STOP_WHEN = {
  any: {
    id: true,
    urlIncludes: true,
    urlPathEquals: true,
    textIncludes: true,
    appStatePathEquals: {
      path: true,
      equals: true,
    } satisfies Keys<Field<StopWhenRule, "appStatePathEquals">>,
  } satisfies Keys<StopWhenRule>,
} satisfies Keys<StopWhen>;

const DWELL = {
  ms: true,
  everyMs: true,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the documented dwell field of a study
  then: true,
  when: STOP_WHEN,
} satisfies Keys<DwellWindow>;

export const CAPS = {
  maxUsd: true,
  maxTotalUsd: true,
  maxJobs: true,
  maxMinutes: true,
} satisfies Keys<StudyCaps>;

export const PARTICIPANT_ENTRY = {
  id: true,
  actorType: true,
  surface: true,
  caseGroup: true,
  persona: true,
  device: true,
  instruction: true,
  target: true,
  entry: true,
  host: true,
  reasoningEffort: true,
  stopWhen: STOP_WHEN,
  dwell: DWELL,
} satisfies Keys<StudyParticipantEntry>;

export const SUBJECT = {
  source: true,
  exposure: true,
  appUrl: true,
  repos: true,
  env: true,
  envValues: true,
  clone: { depth: true, fanout: true, keep: true } satisfies Keys<Field<StudySubject, "clone">>,
  localTree: {
    exclude: true,
    keep: true,
    maxArchiveBytes: true,
  } satisfies Keys<Field<StudySubject, "localTree">>,
  product: {
    name: true,
    install: true,
    workdir: true,
    upload: true,
    publicSurfaces: true,
  } satisfies Keys<Field<StudySubject, "product">>,
  publicTarget: { owner: true, authorized: true } satisfies Keys<
    Field<StudySubject, "publicTarget">
  >,
  serve: {
    install: true,
    installTimeoutMs: true,
    build: true,
    buildTimeoutMs: true,
    start: true,
    url: true,
    readyTimeoutMs: true,
  } satisfies Keys<Field<StudySubject, "serve">>,
  state: {
    seed: {
      name: true,
      command: true,
      when: true,
      timeoutMs: true,
    } satisfies Keys<Field<State, "seed">[number]>,
    external: true,
    checkpoint: {
      name: true,
      command: true,
      redact: true,
    } satisfies Keys<Field<State, "checkpoint">[number]>,
  } satisfies Keys<State>,
} satisfies Keys<StudySubject>;

export const ACTOR = {
  type: true,
  persona: true,
  mission: true,
  model: true,
  maxOutputTokens: true,
  localAgent: true,
  reasoningEffort: true,
  stopWhen: STOP_WHEN,
  dwell: DWELL,
  tasks: { id: true, goal: true, success: STOP_WHEN } satisfies Keys<StudyTask>,
} satisfies Keys<StudyConfig["actor"]>;

export const EXECUTION = {
  target: true,
  runtime: { version: true } satisfies Keys<Field<Execution, "runtime">>,
  runtimeAuth: true,
  concurrency: true,
  timeoutMs: true,
  completionTimeoutMs: true,
  egressAllow: true,
  terminal: { stdin: true, transport: true, doNotTrack: true } satisfies Keys<
    Field<Execution, "terminal">
  >,
  desktop: {
    template: true,
    browser: true,
    device: true,
    resolution: true,
    sandboxTimeoutMs: true,
    codexAppServer: true,
    // Checks its own keys.
    recording: true,
    fidelity: {
      mobileEmulation: true,
      deviceScaleFactor: true,
      touch: true,
      userAgent: true,
    } satisfies Keys<Field<Desktop, "fidelity">>,
    media: {
      camera: { source: true },
      microphone: { source: true },
    } satisfies Keys<Field<Desktop, "media">>,
  } satisfies Keys<Desktop>,
} satisfies Keys<Execution>;

const EMAIL = {
  kind: true,
  connection: true,
  port: true,
  smtp: {
    hostEnv: true,
    portEnv: true,
    port: true,
    userEnv: true,
    user: true,
    passwordEnv: true,
    password: true,
  } satisfies Keys<Field<Email, "smtp">>,
  external: {
    catchBaseUrl: true,
    inboxBaseUrl: true,
    authTokenEnv: true,
  } satisfies Keys<Field<Email, "external">>,
  injectEnv: true,
  linkOrigin: true,
  allowedOrigins: true,
  recipients: { lane: true, address: true } satisfies Keys<Field<Email, "recipients">[number]>,
} satisfies Keys<Email>;

// humanish.study.v3. A list entry with a `count` is a group, so `participants` keys an entry's keys
// and a group's together: parseStudy checks which form the route takes.
const STUDY_KEYS = {
  schema: true,
  id: true,
  title: true,
  description: true,
  route: true,
  mode: true,
  subject: SUBJECT,
  actor: ACTOR,
  participants: {
    ...PARTICIPANT_ENTRY,
    count: true,
  } satisfies Keys<StudyParticipantEntry & StudyParticipantGroup>,
  surfaces: true,
  caps: CAPS,
  execution: EXECUTION,
  scenario: true,
  policies: {
    redactRepos: true,
    redactScreenshots: true,
    allowPublicTargets: true,
    mediaPermission: true,
    allowPrivateRepoAccess: true,
    allowProviderCredentials: true,
    allowPaymentCredentials: true,
    allowGitHubMutation: true,
  } satisfies Keys<Field<StudyConfig, "policies">>,
  review: {
    scoring: true,
    milestones: true,
    vocabulary: true,
    scorer: { ref: true } satisfies Keys<Field<Field<StudyConfig, "review">, "scorer">>,
    // resolveAutomaticAnalysis checks its own keys.
    analysis: true,
  } satisfies Keys<Field<StudyConfig, "review">>,
  defaults: { open: true } satisfies Keys<Field<StudyConfig, "defaults">>,
  comms: { email: EMAIL } satisfies Keys<Field<StudyConfig, "comms">>,
} satisfies Keys<StudyConfig>;

/** The sections a humanish.lab.v2 file shares with a v3 one. */
export const SHARED_SECTIONS = {
  policies: STUDY_KEYS.policies,
  review: STUDY_KEYS.review,
  defaults: STUDY_KEYS.defaults,
  comms: STUDY_KEYS.comms,
};

/**
 * Whether a dotted key path, such as `caps.maxUsd` or `participants[0].persona`, names a key a
 * humanish.study.v3 file can set. A path below a leaf is not one: `scenario.ref`, where `scenario`
 * is a string, and `review.analysis.question`, whose keys resolveAutomaticAnalysis checks.
 */
export function isStudyKeyPath(path: string): boolean {
  let shape: KeyShape | true = STUDY_KEYS;
  for (const segment of path.replaceAll(/\[\d*\]/g, "").split(".")) {
    if (shape === true || !Object.hasOwn(shape, segment)) return false;
    shape = shape[segment]!;
  }
  return true;
}

/**
 * The dotted path of every key a humanish.study.v3 file can set, down to `depth` levels:
 * `route`, `caps.maxUsd`, `participants.persona`. scripts/check-doc-study-fields.ts holds the
 * study file reference to these paths.
 */
export function studyKeyPaths(depth: number): string[] {
  const paths: string[] = [];
  const visit = (shape: KeyShape, prefix: string, level: number): void => {
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      if (child !== true && level < depth) visit(child, path, level + 1);
    }
  };
  visit(STUDY_KEYS, "", 1);
  return paths;
}

/** The first key in a humanish.study.v3 document that the format does not have; undefined if none. */
export function findUnknownStudyKey(raw: unknown): string | undefined {
  return findUnknownKey(raw, STUDY_KEYS);
}

/** The first key in `raw` that `shape` does not list, as an error message; undefined if none. */
export function findUnknownKey(raw: unknown, shape: KeyShape): string | undefined {
  return walk(raw, shape, "", "study");
}

function walk(value: unknown, shape: KeyShape, path: string, noun: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = walk(item, shape, `${path}[${index}]`, noun);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const known = Object.keys(shape);
  // Object.hasOwn: a key like `constructor` must not match Object.prototype.
  const unknown = Object.keys(record).filter((key) => !Object.hasOwn(shape, key));
  if (unknown.length > 0) return unknownKeysMessage(path, unknown, known, noun);
  for (const [key, child] of Object.entries(record)) {
    const expected = shape[key];
    if (expected !== true && expected !== undefined) {
      const found = walk(child, expected, path ? `${path}.${key}` : key, noun);
      if (found) return found;
    }
  }
  return undefined;
}

function unknownKeysMessage(
  path: string,
  unknown: string[],
  known: string[],
  noun: string,
): string {
  const named = unknown.map((key) => {
    const suggestion = closest(key, known);
    return suggestion ? `${key} (did you mean \`${suggestion}\`?)` : key;
  });
  return `Unknown ${noun} ${unknown.length === 1 ? "field" : "fields"}${path ? ` in \`${path}\`` : ""}: ${named.join(", ")}. Known fields: ${known.join(", ")}.`;
}

// The known key within edit distance 2, or one that differs only in case.
function closest(key: string, known: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of known) {
    const distance =
      name.toLowerCase() === key.toLowerCase()
        ? 0
        : editDistance(key.toLowerCase(), name.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}
