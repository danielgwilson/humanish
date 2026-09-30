// Every mapping key parseLabConfig reads, by path. A key that is not listed fails the lab as
// unknown, so a typo stops the run instead of being dropped. `true` marks a leaf: its parser
// checks the value (scalars, lists, and mappings that check their own keys). Each level satisfies
// the parsed type's keys, so a field added to a Lab* interface must be added here too.

import type { DwellWindow, StopWhen, StopWhenRule } from "../stop-conditions.js";
import type { LabTask } from "../tasks.js";
import type {
  LabActor,
  LabActorLane,
  LabActorRosterGroup,
  LabConfig,
  LabSubject,
} from "./config.js";

type KeyShape = { readonly [key: string]: true | KeyShape };
// Exactly the keys of T: a missing or extra key is a compile error, so this table cannot drift
// from the parsed types.
type Keys<T> = { readonly [K in keyof Required<T>]: true | KeyShape };
type Field<T, K extends keyof T> = NonNullable<T[K]>;

type Execution = Field<LabConfig, "execution">;
type Desktop = Field<Execution, "desktop">;
type Email = Field<Field<LabConfig, "comms">, "email">;
type State = Field<LabSubject, "state">;

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
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the documented dwell field of humanish.lab.v2
  then: true,
  when: STOP_WHEN,
} satisfies Keys<DwellWindow>;

const CAPS = {
  maxUsd: true,
  maxTotalUsd: true,
  maxJobs: true,
  maxMinutes: true,
} satisfies Keys<Field<Execution, "caps">>;

const LANE = {
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
} satisfies Keys<LabActorLane>;

const SUBJECT = {
  source: true,
  topology: true,
  exposure: true,
  appUrl: true,
  repos: true,
  env: true,
  envValues: true,
  clone: { depth: true, fanout: true, keep: true } satisfies Keys<Field<LabSubject, "clone">>,
  localTree: {
    exclude: true,
    keep: true,
    maxArchiveBytes: true,
  } satisfies Keys<Field<LabSubject, "localTree">>,
  product: {
    name: true,
    install: true,
    workdir: true,
    upload: true,
    publicSurfaces: true,
  } satisfies Keys<Field<LabSubject, "product">>,
  publicTarget: { owner: true, authorized: true } satisfies Keys<Field<LabSubject, "publicTarget">>,
  serve: {
    install: true,
    installTimeoutMs: true,
    build: true,
    buildTimeoutMs: true,
    start: true,
    url: true,
    readyTimeoutMs: true,
  } satisfies Keys<Field<LabSubject, "serve">>,
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
} satisfies Keys<LabSubject>;

const ACTOR = {
  type: true,
  count: true,
  lanes: LANE,
  // Roster groups are lanes with a count; the parser expands them into lanes.
  roster: { ...LANE, count: true } satisfies Keys<LabActorRosterGroup>,
  persona: true,
  mission: true,
  model: true,
  maxOutputTokens: true,
  localAgent: true,
  reasoningEffort: true,
  stopWhen: STOP_WHEN,
  dwell: DWELL,
  tasks: { id: true, goal: true, success: STOP_WHEN } satisfies Keys<LabTask>,
  laneFocus: {
    id: true,
    label: true,
    instruction: true,
  } satisfies Keys<Field<LabActor, "laneFocus">>,
} satisfies Keys<LabActor & { roster: unknown }>;

const EXECUTION = {
  target: true,
  runtime: { version: true } satisfies Keys<Field<Execution, "runtime">>,
  runtimeAuth: true,
  concurrency: true,
  timeoutMs: true,
  completionTimeoutMs: true,
  egressAllow: true,
  caps: CAPS,
  terminal: { stdin: true, transport: true } satisfies Keys<Field<Execution, "terminal">>,
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

const LAB_KEYS = {
  schema: true,
  id: true,
  title: true,
  description: true,
  subject: SUBJECT,
  actors: ACTOR,
  execution: EXECUTION,
  // Inline personas are validated by the persona resolver.
  personas: true,
  scenario: {
    ref: true,
    mode: true,
    inline: true,
    caps: CAPS,
  } satisfies Keys<Field<LabConfig, "scenario">>,
  policies: {
    redactRepos: true,
    redactScreenshots: true,
    allowPublicTargets: true,
    mediaPermission: true,
    allowPrivateRepoAccess: true,
    allowProviderCredentials: true,
    allowPaymentCredentials: true,
    allowGitHubMutation: true,
  } satisfies Keys<Field<LabConfig, "policies">>,
  review: {
    scoring: true,
    milestones: true,
    vocabulary: true,
    scorer: { ref: true } satisfies Keys<Field<Field<LabConfig, "review">, "scorer">>,
    // resolveAutomaticAnalysis checks its own keys.
    analysis: true,
  } satisfies Keys<Field<LabConfig, "review">>,
  defaults: { open: true } satisfies Keys<Field<LabConfig, "defaults">>,
  comms: { email: EMAIL } satisfies Keys<Field<LabConfig, "comms">>,
} satisfies Keys<LabConfig>;

/** The first key in `raw` that LAB_KEYS does not list, as an error message; undefined if none. */
export function findUnknownLabKey(raw: unknown): string | undefined {
  return walk(raw, LAB_KEYS, "");
}

function walk(value: unknown, shape: KeyShape, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = walk(item, shape, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const known = Object.keys(shape);
  // Object.hasOwn: a key like `constructor` must not match Object.prototype.
  const unknown = Object.keys(record).filter((key) => !Object.hasOwn(shape, key));
  if (unknown.length > 0) return unknownKeysMessage(path, unknown, known);
  for (const [key, child] of Object.entries(record)) {
    const expected = shape[key];
    if (expected !== true && expected !== undefined) {
      const found = walk(child, expected, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return undefined;
}

function unknownKeysMessage(path: string, unknown: string[], known: string[]): string {
  const named = unknown.map((key) => {
    const suggestion = closest(key, known);
    return suggestion ? `${key} (did you mean \`${suggestion}\`?)` : key;
  });
  return `Unknown lab field(s)${path ? ` in \`${path}\`` : ""}: ${named.join(", ")}. Known fields: ${known.join(", ")}.`;
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
