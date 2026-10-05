// Valid humanish.study.v3 manifests, one per route shape. Admission cases mutate a deep copy of one
// of these, so every case differs from a runnable study by the one rule it exercises.

import { STUDY_SCHEMA } from "../../src/study/types.js";
import { libraryConfig } from "../helpers/library-config.js";

export type RawLab = Record<string, unknown>;

const serve = { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" };
const cuActor = { type: "openai-computer-use", persona: "first-time-visitor", mission: "Try it." };

const bases = {
  preview: {
    route: "preview",
    subject: { source: "this-repo" },
    actor: { type: "synthetic-persona" },
  },
  cuAppUrl: {
    route: "computer-use",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: cuActor,
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuClone: {
    route: "computer-use",
    subject: { source: "clone", repos: ["example-org/example-app"], serve },
    actor: cuActor,
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuLocalTree: {
    route: "computer-use",
    subject: { source: "local-tree", serve },
    actor: cuActor,
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuDesktopCli: {
    route: "computer-use",
    subject: {
      source: "desktop-cli",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actor: cuActor,
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  cuLocalApp: {
    route: "computer-use",
    subject: { source: "local-app", appUrl: "http://127.0.0.1:3000/" },
    actor: cuActor,
    execution: { target: "local", timeoutMs: 60_000 },
  },
  scriptedAppUrl: {
    route: "scripted",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { type: "scripted-browser", persona: "synthetic-new-user" },
    scenario: "adm-journey",
    execution: { target: "local", timeoutMs: 30_000 },
  },
  scriptedClone: {
    route: "scripted",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/example-app"],
      serve: { ...serve, start: "pnpm start --host 0.0.0.0" },
      state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
    },
    actor: { type: "scripted-browser", persona: "synthetic-provider" },
    surfaces: ["desktop"],
    scenario: "adm-journey",
    execution: { target: "e2b-desktop", timeoutMs: 30_000 },
  },
  terminal: {
    route: "terminal",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actor: { type: "codex-exec", persona: "autonomous-creative-agent", mission: "Explore." },
    caps: { maxUsd: 0, maxMinutes: 5 },
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
  },
  sharedProvisioned: {
    route: "shared-world",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { ...serve, start: "pnpm start -H 0.0.0.0" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "psql query notes" }],
      },
    },
    actor: cuActor,
    participants: [
      { id: "author", persona: "persona-1", entry: "/seat-1" },
      { id: "reviewer", persona: "persona-2", entry: "/seat-2" },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  },
  sharedExternal: {
    route: "shared-world",
    subject: {
      source: "app-url",
      appUrl: "https://app.example.com/",
      publicTarget: { owner: "example-org", authorized: true },
    },
    actor: cuActor,
    participants: [{ id: "host", host: true }, { id: "guest" }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    policies: { allowPublicTargets: true },
  },
} satisfies Record<string, RawLab>;

export type BaseName = keyof typeof bases;

/** A patch value of `undefined` deletes the key; arrays and scalars replace. */
export type Patch = { readonly [key: string]: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

/**
 * A deep copy of a base manifest with `patch` merged in, and `actorPatch` merged into `actor`.
 * Cases use it to write shapes the types forbid.
 */
export function lab(base: BaseName, patch: Patch = {}, actorPatch?: Patch): RawLab {
  const raw = merge(
    { schema: STUDY_SCHEMA, id: `adm-${base.toLowerCase()}`, ...structuredClone(bases[base]) },
    patch,
  ) as RawLab;
  if (actorPatch !== undefined) raw.actor = merge(raw.actor, actorPatch);
  return raw;
}

/**
 * libraryConfig of a base manifest as a mutable record. The route admission-order tests edit it in
 * the v2 shape a library caller can still pass, including shapes a v3 file cannot hold.
 */
export function libraryLab(base: BaseName): RawLab {
  return libraryConfig(lab(base)) as unknown as RawLab;
}

export const SCENARIO_YAML = `schema: humanish.scenario.v1
id: adm-journey
title: Admission journey
goal: Load the app.
browser:
  startPath: /
  steps:
    - id: step-01-load
      label: Load landing page
      action: goto
      path: /
      expect:
        selectorVisible: "main"
`;
