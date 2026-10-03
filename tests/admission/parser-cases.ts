// One case per cross-field parser rule (src/study/config.ts:175-576 and the validation.ts reasons it
// calls). Each raw manifest breaks exactly that rule. The library suite also hands the raw
// manifest to runStudyWith and to the route's exported runner, the way a caller that skips the parser
// can, and pins what each entry point does with it today.

import { lab, type RawLab } from "./fixtures.js";

export interface AdmissionCase {
  readonly name: string;
  readonly raw: RawLab;
  /** The typed config a library caller would pass, where it differs from the manifest shape. */
  readonly typed?: RawLab;
  /** A substring of the parser's refusal message, or "accepts". Proves the case hits its rule. */
  readonly parser: string;
  readonly options?: AdmissionOptions;
  /** Entry points beyond the parser. Default: runStudyWith and the route's exported runner. */
  readonly entries?: readonly ("runLab" | "runner")[];
}

export interface AdmissionOptions {
  readonly dryRun?: boolean;
  readonly count?: number;
  readonly rerun?: { readonly sourceRunId: string };
  /** Caller hooks that change admission today. */
  readonly hooks?: "executor" | "provider" | "executor+provider";
  /** Hook env: none (default), both hosted keys, E2B only or OpenAI only. */
  readonly env?: "none" | "keys" | "e2b" | "openai";
  /** Make browser discovery find nothing: stub `PATH` and HUMANISH_BROWSER_COMMAND. */
  readonly isolateBrowser?: boolean;
  /** Call this route's runner regardless of the config's route. */
  readonly runner?: "computer-use" | "scripted" | "terminal" | "shared-world";
  /** Parse first and hand the parsed config to the entry points. */
  readonly parsed?: boolean;
}

const task = [{ id: "sign-up", goal: "Create an account." }];
const camera = { camera: { source: "synthetic" } };
// The parser turns `connection` into this typed shape.
export const realEmail = { kind: "real", connection: "team-inbox" };
const secondActor = { type: "openai-computer-use", mission: "Try it.", tasks: task };

export const parserCases: readonly AdmissionCase[] = [
  // Before the route blocks.
  {
    name: "smtp on shared world",
    raw: lab("sharedProvisioned", {
      comms: { email: { kind: "fake", smtp: { hostEnv: "SMTP_HOST", portEnv: "SMTP_PORT" } } },
    }),
    parser: "SMTP capture is not yet wired",
  },
  {
    name: "recording on shared world",
    raw: lab("sharedProvisioned", { execution: { desktop: { recording: { audio: false } } } }),
    parser: "execution.desktop.recording is supported only",
  },
  {
    name: "media on scripted",
    raw: lab("scriptedAppUrl", { execution: { desktop: { media: camera } } }),
    parser: "execution.desktop.media is supported only",
  },
  {
    name: "media with firefox",
    raw: lab("cuAppUrl", { execution: { desktop: { browser: "firefox", media: camera } } }),
    parser: "requires Chrome or Chromium",
  },
  {
    name: "maxOutputTokens on local-agent",
    raw: lab("cuAppUrl", {}, { type: "local-agent", maxOutputTokens: 1000 }),
    parser: "maxOutputTokens is supported only",
  },
  {
    name: "real receiving on scripted",
    raw: lab("scriptedAppUrl", { comms: { email: { connection: "team-inbox" } } }),
    typed: lab("scriptedAppUrl", { comms: { email: realEmail } }),
    parser: "Real email receiving requires",
  },
  {
    name: "real receiving with local-agent",
    raw: lab(
      "cuAppUrl",
      { comms: { email: { connection: "team-inbox" } } },
      { type: "local-agent" },
    ),
    typed: lab("cuAppUrl", { comms: { email: realEmail } }, { type: "local-agent" }),
    parser: "unavailable for local-agent",
  },
  {
    name: "recipient names unknown lane",
    raw: lab("cuClone", {
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_BASE_URL",
          recipients: [{ lane: "nobody", address: "a@example.test" }],
        },
      },
    }),
    parser: "that do not exist",
  },
  {
    name: "recipients without address",
    raw: lab("cuClone", {
      comms: {
        email: { kind: "fake", injectEnv: "RESEND_BASE_URL", recipients: [{ lane: "lane-01" }] },
      },
    }),
    parser: "cover no participant with an address",
  },
  {
    name: "this-repo with target",
    raw: lab("preview", { execution: { target: "local" } }),
    parser: "applies only to clone/app-url/local-app",
  },
  {
    name: "this-repo live",
    raw: lab("preview", { scenario: { mode: "live" } }),
    parser: "dry-run only",
  },
  {
    name: "preview count zero",
    raw: lab("preview"),
    parser: "accepts",
    options: { count: 0 },
  },

  // local-app
  {
    name: "local-app on e2b-desktop",
    raw: lab("cuLocalApp", { execution: { target: "e2b-desktop" } }),
    parser: "A local-app subject drives a local dev server",
  },
  {
    name: "local-app with scripted actor",
    raw: lab("cuLocalApp", {}, { type: "scripted-browser" }),
    parser: "for local-app subjects",
  },
  {
    name: "local-app count 2",
    raw: lab("cuLocalApp", {}, { count: 2 }),
    parser: "Fan-out to more than one participant is not supported on the in-process/local-app",
  },
  {
    name: "local-app lanes",
    raw: lab("cuLocalApp", {}, { lanes: [{ id: "a" }] }),
    parser: "is not supported on the in-process/local-app",
  },
  {
    name: "local-app public targets",
    raw: lab("cuLocalApp", { policies: { allowPublicTargets: true } }),
    parser: "does not apply to a local-app subject",
  },

  // app-url, scripted
  {
    name: "scripted app-url on e2b-desktop",
    raw: lab("scriptedAppUrl", { execution: { target: "e2b-desktop" } }),
    parser: "runs on this machine",
  },
  {
    name: "scripted app-url without ref",
    raw: lab("scriptedAppUrl", { scenario: undefined }),
    parser: "needs `scenario.ref`",
  },
  {
    name: "scripted app-url count 3",
    raw: lab("scriptedAppUrl", {}, { count: 3 }),
    parser: "takes `actors[0].count` 1 (desktop) or 2",
  },
  {
    name: "scripted app-url redacted screenshots",
    raw: lab("scriptedAppUrl", { policies: { redactScreenshots: true } }),
    parser: "is not supported on the scripted-browser route yet",
  },
  {
    name: "scripted app-url public targets",
    raw: lab("scriptedAppUrl", { policies: { allowPublicTargets: true } }),
    parser: "not supported on the scripted-browser route",
  },
  {
    name: "scripted app-url public url",
    raw: lab("scriptedAppUrl", { subject: { appUrl: "https://example.com/" } }),
    parser: "must be a loopback URL",
  },

  // app-url, computer use
  {
    name: "cu app-url without target",
    raw: lab("cuAppUrl", { execution: { target: undefined } }),
    parser: "require `execution.target: local` or `e2b-desktop`",
  },
  {
    name: "cu app-url unknown actor",
    raw: lab("cuAppUrl", {}, { type: "not-an-actor" }),
    parser: "registered computer-use actor for app-url",
  },
  {
    name: "cu app-url codex-app-server",
    raw: lab("cuAppUrl", {}, { type: "codex-app-server" }),
    parser: "registered computer-use actor for app-url",
  },
  {
    name: "cu app-url public url without policy",
    raw: lab("cuAppUrl", { subject: { appUrl: "https://example.com/" } }),
    parser: "must be loopback URLs",
  },

  // clone and local-tree, scripted
  {
    name: "scripted on local-tree",
    raw: lab("cuLocalTree", {}, { type: "scripted-browser" }),
    parser: "scripted-browser actors require `subject.source: app-url`",
  },
  {
    name: "scripted clone on local",
    raw: lab("scriptedClone", { execution: { target: "local" } }),
    parser: "scripted-browser actor needs `execution.target: e2b-desktop`",
  },
  {
    name: "scripted clone without serve",
    raw: lab("scriptedClone", { subject: { serve: undefined } }),
    parser: "scripted-browser actor needs `subject.serve`",
  },
  {
    name: "scripted clone two repos",
    raw: lab("scriptedClone", { subject: { repos: ["example-org/a", "example-org/b"] } }),
    parser: "exactly one repo",
  },
  {
    name: "scripted clone topology",
    raw: lab("scriptedClone", { subject: { topology: "shared-world" } }),
    parser: "does not support `subject.topology`",
  },
  {
    name: "scripted clone keep",
    raw: lab("scriptedClone", { subject: { clone: { keep: true } } }),
    parser: "`subject.clone.keep` yet",
  },
  {
    name: "scripted clone without ref",
    raw: lab("scriptedClone", { scenario: undefined }),
    parser: "needs `scenario.ref`",
  },
  {
    name: "scripted clone count 3",
    raw: lab("scriptedClone", {}, { count: 3 }),
    parser: "takes `actors[0].count` 1 (desktop) or 2",
  },
  {
    name: "scripted clone lanes",
    raw: lab("scriptedClone", {}, { count: undefined, lanes: [{ id: "a" }] }),
    parser: "is not supported on the scripted-browser route yet",
  },
  {
    name: "scripted clone redacted screenshots",
    raw: lab("scriptedClone", { policies: { redactScreenshots: true } }),
    parser: "is not supported on the scripted-browser route yet",
  },
  {
    name: "scripted clone public targets",
    raw: lab("scriptedClone", { policies: { allowPublicTargets: true } }),
    parser: "does not apply to a clone scripted-browser study",
  },
  {
    name: "scripted clone without exposure",
    raw: lab("scriptedClone", { subject: { exposure: undefined } }),
    parser: "scripted-browser study needs `subject.exposure: synthetic`",
  },
  {
    name: "scripted clone without seed",
    raw: lab("scriptedClone", { subject: { state: undefined } }),
    parser: "needs `subject.state.seed`",
  },
  {
    name: "scripted clone loopback bind",
    raw: lab("scriptedClone", { subject: { serve: { start: "pnpm start" } } }),
    parser: "to listen on all interfaces",
  },

  // clone and local-tree, computer use
  {
    name: "cu clone on local",
    raw: lab("cuClone", { execution: { target: "local" } }),
    parser: "clone subjects require `execution.target: e2b-desktop`",
  },
  {
    name: "cu clone without serve",
    raw: lab("cuClone", { subject: { serve: undefined } }),
    parser: "before the participant opens it",
  },
  {
    name: "cu clone two repos",
    raw: lab("cuClone", { subject: { repos: ["example-org/a", "example-org/b"] } }),
    parser: "declare exactly one repo",
  },
  {
    name: "cu local-tree without target",
    raw: lab("cuLocalTree", { execution: { target: undefined } }),
    parser: "local-tree subjects require `execution.target: e2b-desktop`",
  },
  {
    name: "cu local-tree terminal actor",
    raw: lab("cuLocalTree", {}, { type: "codex-exec" }),
    parser: "for local-tree subjects",
  },
  {
    name: "terminal actor on clone",
    raw: lab("cuClone", {}, { type: "codex-exec" }),
    parser: "terminal actors require `subject.source: terminal-product`",
  },
  // Refused at parse since P0b; library callers still reach the route's actor check.
  {
    name: "codex-app-server on clone",
    raw: lab("cuClone", {}, { type: "codex-app-server" }),
    parser: 'Got "codex-app-server"',
  },

  // Computer-use fan-out
  {
    name: "lanes and count",
    raw: lab("cuAppUrl", {}, { count: 2, lanes: [{ id: "a" }, { id: "b" }] }),
    parser: "Set either `actors[0].count`",
  },
  {
    name: "laneFocus and lanes",
    raw: lab(
      "cuAppUrl",
      {},
      { laneFocus: { instruction: "Focus." }, lanes: [{ id: "a" }, { id: "b" }] },
    ),
    parser: "are mutually exclusive",
  },
  {
    name: "lane device and raw resolution",
    raw: lab(
      "cuAppUrl",
      { execution: { desktop: { resolution: [1280, 800] } } },
      { lanes: [{ id: "a", device: "small-mobile" }, { id: "b" }] },
    ),
    parser: "a per-participant device preset",
  },
  {
    name: "lane target on clone",
    raw: lab(
      "cuClone",
      {},
      {
        lanes: [
          { id: "a", target: "http://127.0.0.1:3001/" },
          { id: "b", target: "http://127.0.0.1:3002/" },
        ],
      },
    ),
    parser: "works only on app-url computer-use studies",
  },
  {
    name: "lane target and entry",
    raw: lab(
      "cuAppUrl",
      {},
      {
        lanes: [
          { id: "a", target: "http://127.0.0.1:3001/", entry: "/x" },
          { id: "b", target: "http://127.0.0.1:3002/" },
        ],
      },
    ),
    parser: "are mutually exclusive",
  },
  {
    name: "partial lane targets",
    raw: lab(
      "cuAppUrl",
      {},
      { lanes: [{ id: "a", target: "http://127.0.0.1:3001/" }, { id: "b" }] },
    ),
    parser: "every participant in the roster must declare target",
  },
  {
    name: "seventeen lanes",
    raw: lab("cuAppUrl", {}, { count: 17 }),
    parser: "runs at most 16 participants",
  },
  {
    name: "public target fan-out",
    raw: lab(
      "cuAppUrl",
      { subject: { appUrl: "https://example.com/" }, policies: { allowPublicTargets: true } },
      { count: 2 },
    ),
    parser: "with more than one participant sends them all to one public app",
  },
  {
    name: "clone fanout on computer use",
    raw: lab("cuClone", { subject: { clone: { fanout: 2 } } }),
    parser: "is not used on the computer-use route",
  },
  {
    name: "duplicate lane ids",
    raw: lab("cuAppUrl", {}, { lanes: [{ id: "a" }, { id: "a" }] }),
    parser: "unique",
  },

  // Shared world, provisioned
  {
    name: "shared world on local",
    raw: lab("sharedProvisioned", { execution: { target: "local" } }),
    parser: "clone subjects require `execution.target: e2b-desktop`",
  },
  {
    name: "shared world without serve",
    raw: lab("sharedProvisioned", { subject: { serve: undefined } }),
    parser: "before the participant opens it",
  },
  {
    name: "shared world one seat",
    raw: lab("sharedProvisioned", {}, { lanes: [{ id: "author", entry: "/seat-1" }] }),
    parser: "roster of at least 2",
  },
  {
    name: "shared world without checkpoint",
    raw: lab("sharedProvisioned", { subject: { state: { checkpoint: undefined } } }),
    parser: "read-only `subject.state.checkpoint` probe",
  },
  {
    name: "shared world cross-origin entry",
    raw: lab(
      "sharedProvisioned",
      {},
      { lanes: [{ id: "author", entry: "https://elsewhere.example/" }, { id: "reviewer" }] },
    ),
    parser: "must resolve same-origin",
  },
  {
    name: "shared world concurrency 1",
    raw: lab("sharedProvisioned", { execution: { concurrency: 1 } }),
    parser: "of at least 2",
  },
  {
    name: "shared world without exposure",
    raw: lab("sharedProvisioned", { subject: { exposure: undefined } }),
    parser: "A shared-world study needs `subject.exposure: synthetic`",
  },
  {
    name: "shared world loopback bind",
    raw: lab("sharedProvisioned", { subject: { serve: { start: "pnpm start" } } }),
    parser: "to listen on all interfaces",
  },
  {
    name: "shared world clone keep",
    raw: lab("sharedProvisioned", { subject: { clone: { keep: true } } }),
    parser: "is not supported on the concurrent shared-world route",
  },

  // Shared world, external public
  {
    name: "external without public-target policy",
    raw: lab("sharedExternal", { policies: undefined }),
    parser: "must be loopback URLs",
  },
  {
    name: "external loopback url",
    raw: lab("sharedExternal", { subject: { appUrl: "http://127.0.0.1:3000/" } }),
    parser: "needs a public http(s) `subject.appUrl`",
  },
  {
    name: "external without ownership",
    raw: lab("sharedExternal", { subject: { publicTarget: undefined } }),
    parser: "needs `subject.publicTarget",
  },
  {
    name: "external with exposure",
    raw: lab("sharedExternal", { subject: { exposure: "synthetic" } }),
    parser: "does not apply to an external-public shared-world study",
  },
  {
    name: "external seat entry",
    raw: lab(
      "sharedExternal",
      {},
      { lanes: [{ id: "host", host: true, entry: "/x" }, { id: "guest" }] },
    ),
    parser: "is forbidden on the external-public",
  },
  {
    name: "external without host",
    raw: lab("sharedExternal", {}, { lanes: [{ id: "a" }, { id: "b" }] }),
    parser: "exactly one `host: true` participant",
  },
  {
    name: "external one seat",
    raw: lab(
      "sharedExternal",
      { execution: { concurrency: 2 } },
      { lanes: [{ id: "host", host: true }] },
    ),
    parser: "roster of at least 2",
  },

  // desktop-cli
  {
    name: "desktop-cli without product name",
    raw: lab("cuDesktopCli", { subject: { product: { name: undefined } } }),
    parser: "must be a public-safe token",
  },
  {
    name: "desktop-cli on local",
    raw: lab("cuDesktopCli", { execution: { target: "local" } }),
    parser: "runs on a hosted desktop",
  },
  {
    name: "desktop-cli codex-app-server",
    raw: lab("cuDesktopCli", {}, { type: "codex-app-server" }),
    parser: "need a registered computer-use actor",
  },
  {
    name: "desktop-cli blank install",
    raw: lab("cuDesktopCli", { subject: { product: { install: " " } } }),
    parser: "must be a non-empty command",
  },

  // terminal
  {
    name: "terminal on e2b-desktop",
    raw: lab("terminal", { execution: { target: "e2b-desktop" } }),
    parser: "runs its agent in an E2B shell",
  },
  {
    name: "terminal computer-use actor",
    raw: lab("terminal", {}, { type: "openai-computer-use" }),
    parser: "must be a registered terminal actor",
  },
  {
    name: "terminal count 2",
    raw: lab("terminal", {}, { count: 2 }),
    parser: "Terminal fan-out to more than one participant",
  },

  // Tasks, analysis, local browser
  {
    name: "tasks on scripted",
    raw: lab("scriptedAppUrl", {}, { tasks: task }),
    parser: "tasks is unsupported on this execution path",
  },
  // The parser refuses a second actor outright; the task rule for it is reachable only by library callers.
  {
    name: "tasks on second actor",
    raw: lab("cuAppUrl", {
      actors: [{ type: "openai-computer-use", mission: "Try it." }, secondActor],
    }),
    parser: "Multiple actors are not supported",
  },
  {
    name: "analysis on preview",
    raw: lab("preview", { review: { analysis: { maxCostUsd: 1 } } }),
    parser: "review.analysis requires",
  },
  // runStudyWith would start the local VM path, which probes the host; the parser case is enough.
  {
    name: "local browser long session",
    raw: lab("cuAppUrl", { execution: { target: "local", timeoutMs: 1_800_000 } }),
    parser: "at most 20 minutes",
    entries: [],
  },
];
