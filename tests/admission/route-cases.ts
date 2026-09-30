// Rules the parser cannot see (caller hooks, overrides, live-only rules), missing external
// prerequisites, a config handed to another route's runner, raw vs parsed configs, and pairs of
// violations the parser and the routes check in different orders.

import { lab } from "./fixtures.js";
import { realEmail, type AdmissionCase } from "./parser-cases.js";

const live = { scenario: { mode: "live" } };
const task = [{ id: "sign-up", goal: "Create an account." }];
const camera = { camera: { source: "synthetic" } };
const email = { kind: "fake", injectEnv: "RESEND_BASE_URL" };

export const routeCases: readonly AdmissionCase[] = [
  // Caller hooks and overrides
  {
    name: "maxOutputTokens with a caller provider",
    raw: lab("cuAppUrl", {}, { maxOutputTokens: 1000 }),
    parser: "accepts",
    options: { hooks: "provider" },
  },
  {
    name: "executor without provider",
    raw: lab("cuAppUrl"),
    parser: "accepts",
    options: { hooks: "executor" },
  },
  { name: "local-app without executor", raw: lab("cuLocalApp"), parser: "accepts" },
  {
    name: "count override above the cap",
    raw: lab("cuAppUrl"),
    parser: "accepts",
    options: { count: 17 },
  },
  {
    name: "in-process fan-out",
    raw: lab("cuAppUrl"),
    parser: "accepts",
    options: { hooks: "executor+provider", count: 2 },
  },
  {
    name: "rerun on scripted",
    raw: lab("scriptedAppUrl"),
    parser: "accepts",
    options: { rerun: { sourceRunId: "prior-run" } },
  },
  {
    name: "sandbox deadline too long",
    raw: lab("cuClone", { execution: { timeoutMs: 3_300_000 } }),
    parser: "accepts",
  },

  // Live-only rules
  {
    name: "terminal live without caps",
    raw: lab("terminal", { scenario: { mode: "live", caps: undefined } }),
    parser: "accepts",
  },
  {
    name: "terminal runtime version",
    raw: lab("terminal", { execution: { runtime: { version: "latest" } } }),
    parser: "runtime",
  },
  {
    name: "terminal product without surfaces",
    raw: lab("terminal", { subject: { product: { publicSurfaces: [] } } }),
    parser: "publicSurfaces",
  },
  {
    name: "shared world unpriced cap",
    raw: lab(
      "sharedProvisioned",
      { ...live, execution: { caps: { maxUsd: 1 } } },
      { model: "unpriced-model" },
    ),
    parser: "accepts",
  },
  {
    name: "cu unpriced cap without keys",
    raw: lab(
      "cuAppUrl",
      { ...live, execution: { caps: { maxUsd: 1 } } },
      { model: "unpriced-model" },
    ),
    parser: "accepts",
  },
  {
    name: "cu unpriced cap with keys",
    raw: lab(
      "cuAppUrl",
      { ...live, execution: { caps: { maxUsd: 1 } } },
      { model: "unpriced-model" },
    ),
    parser: "accepts",
    options: { env: "keys" },
  },

  // Missing external prerequisites
  { name: "cu live without keys", raw: lab("cuAppUrl", live), parser: "accepts" },
  {
    name: "cu live local agent absent",
    raw: lab("cuAppUrl", live, { type: "local-agent" }),
    parser: "accepts",
    options: { env: "e2b" },
  },
  {
    name: "cu clone subject env missing",
    raw: lab("cuClone", { ...live, subject: { env: ["DATABASE_URL"] } }),
    parser: "accepts",
    options: { env: "keys" },
  },
  {
    name: "cu external catch unreachable",
    raw: lab("cuAppUrl", {
      ...live,
      comms: { email: { kind: "fake", external: { catchBaseUrl: "http://127.0.0.1:9/" } } },
    }),
    parser: "accepts",
    options: { env: "keys" },
  },
  { name: "scripted clone without e2b key", raw: lab("scriptedClone", live), parser: "accepts" },
  {
    name: "scripted clone subject env missing",
    raw: lab("scriptedClone", { ...live, subject: { env: ["GITHUB_TOKEN"] } }),
    parser: "accepts",
    options: { env: "e2b" },
  },
  { name: "terminal live without keys", raw: lab("terminal", live), parser: "accepts" },
  {
    name: "shared world live without keys",
    raw: lab("sharedProvisioned", live),
    parser: "accepts",
  },

  // A config handed to another route's exported runner
  {
    name: "shared-world config to the cu runner",
    raw: lab("sharedProvisioned"),
    parser: "accepts",
    options: { runner: "cua" },
    entries: ["runner"],
  },
  {
    name: "cu config to the shared-world runner",
    raw: lab("cuAppUrl"),
    parser: "accepts",
    options: { runner: "concurrent-shared-world" },
    entries: ["runner"],
  },
  {
    name: "terminal config to the scripted runner",
    raw: lab("terminal"),
    parser: "accepts",
    options: { runner: "scripted" },
    entries: ["runner"],
  },
  {
    name: "scripted config to the terminal runner",
    raw: lab("scriptedAppUrl"),
    parser: "accepts",
    options: { runner: "terminal" },
    entries: ["runner"],
  },

  // Raw vs parsed with a count override: the parser fills concurrency and recipients for 2 lanes.
  {
    name: "count override on a raw config",
    raw: lab("cuClone", { comms: { email } }, { count: 2 }),
    parser: "accepts",
    options: { count: 3 },
  },
  {
    name: "count override on a parsed config",
    raw: lab("cuClone", { comms: { email } }, { count: 2 }),
    parser: "accepts",
    options: { count: 3, parsed: true },
  },

  // Two violations, checked in a different order by the parser and the route
  {
    name: "overlap cu: unknown actor and firefox media",
    raw: lab(
      "cuAppUrl",
      { execution: { desktop: { browser: "firefox", media: camera } } },
      { type: "not-an-actor" },
    ),
    parser: "execution.desktop.media is supported only",
  },
  {
    name: "overlap scripted: real receiving and media",
    raw: lab("scriptedAppUrl", {
      comms: { email: { connection: "team-inbox" } },
      execution: { desktop: { media: camera } },
    }),
    typed: lab("scriptedAppUrl", {
      comms: { email: realEmail },
      execution: { desktop: { media: camera } },
    }),
    parser: "execution.desktop.media is supported only",
  },
  {
    name: "overlap terminal: real receiving and media",
    raw: lab("terminal", {
      comms: { email: { connection: "team-inbox" } },
      execution: { desktop: { media: camera } },
    }),
    typed: lab("terminal", {
      comms: { email: realEmail },
      execution: { desktop: { media: camera } },
    }),
    parser: "execution.desktop.media is supported only",
  },
  {
    name: "overlap shared world: tasks and one seat",
    raw: lab("sharedProvisioned", {}, { tasks: task, lanes: [{ id: "author", entry: "/seat-1" }] }),
    parser: "at least 2 roles",
  },
];
