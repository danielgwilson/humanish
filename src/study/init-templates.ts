import type { LocalAgentId } from "../actors/local-agent/cli.js";
import { DEFAULT_ANALYSIS_MAX_COST_USD } from "../analysis/automatic-config.js";

export interface StarterFile {
  path: string;
  contents: string;
  plane: "source";
}

export interface RuntimeDirectory {
  path: string;
  plane: "runtime";
}

export interface LocalBrowserStarter {
  appUrl: string;
  mission: string;
}

export const DEFAULT_LOCAL_BROWSER_STARTER: LocalBrowserStarter = {
  appUrl: "http://127.0.0.1:3000",
  mission:
    "Use the app's primary flow. Explain anything confusing and stop when the task is complete or you are stuck.",
};

function localBrowserStudy(
  starter: LocalBrowserStarter = DEFAULT_LOCAL_BROWSER_STARTER,
): StarterFile {
  return {
    path: "humanish/studies/local-browser.yaml",
    plane: "source",
    contents: `schema: humanish.study.v3
id: local-browser
title: Local browser · your app · Codex account
description: >-
  Runs one participant on your Codex account in an isolated local browser against your loopback
  app. Needs no E2B or OpenAI API key: inference is remote and uses your Codex account quota.
  Before the first live run, check the Codex login and the local runtime with humanish doctor
  --study local-browser.
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: ${JSON.stringify(starter.appUrl)}
actor:
  type: local-agent
  localAgent: codex
  persona: synthetic-new-user
  mission: ${JSON.stringify(starter.mission)}
execution:
  target: local
  concurrency: 1
  timeoutMs: 120000
defaults:
  open: true
`,
  };
}

type StarterActor = "openai-computer-use" | "local-agent";

/**
 * The flagship live study. A ChatGPT-account Codex participant has no API-dollar price, so preflight
 * refuses a dollar cap on it (HUMANISH_COMPUTER_USE_UNPRICED_CAP); that variant is bounded by the
 * session timeout instead of a cap it could never enforce.
 */
function tryLiveStudy(actor: StarterActor, localAgent: LocalAgentId = "codex"): StarterFile {
  const account = actor === "local-agent";
  const needs = account
    ? `  Needs E2B_API_KEY and the coding agent signed in on this machine. Cost: one small task, a few
  E2B desktop minutes and the agent's account usage. humanish cannot put a dollar cap on account
  usage, so the ten-minute session limit below bounds the run. When OPENAI_API_KEY is set, the
  analysis after the run bills it: humanish refuses that request before it starts if its estimate
  is over $${DEFAULT_ANALYSIS_MAX_COST_USD}. Set review.analysis: false to skip it.`
    : `  Needs E2B_API_KEY and OPENAI_API_KEY. Cost: one small task with a $2 cap on estimated model
  spend. The run stops before its next model request once the estimate passes $2, so the last
  request can go slightly over, and hosted desktop time is billed separately. The analysis after
  the run bills the same key outside that cap: humanish refuses it before it starts if its
  estimate is over $${DEFAULT_ANALYSIS_MAX_COST_USD}. Set review.analysis: false to skip it.`;
  const participant = account
    ? `# Your machine has a coding agent signed in, so this study uses it: no provider API key, only
# E2B. To use a provider key instead, swap to \`type: openai-computer-use\` and add caps.maxUsd.
actor:
  type: local-agent
  localAgent: ${localAgent}`
    : `actor:
  type: openai-computer-use
  # Bounds each model reply. Under the cap below it also bounds what a stalled or lost request
  # can cost, so the run can retry it instead of stopping.
  maxOutputTokens: 8192`;
  const caps = account
    ? ""
    : `caps:
  maxUsd: 2 # estimated model spend; the run stops before its next request once it passes this
`;
  const timeout = account
    ? "  timeoutMs: 600000 # bounds the run; a dollar cap cannot be enforced on account usage"
    : "  timeoutMs: 600000";
  return {
    path: "humanish/studies/try-live.yaml",
    plane: "source",
    contents: `schema: humanish.study.v3
id: try-live
title: "Your first live study: one participant on a demo app"
description: >-
  Runs one participant live on drawDB, a public open-source diagram editor that humanish clones
  and serves in a hosted desktop, so it runs with nothing to configure. The app under study is
  that demo, not yours. The other starter studies need your app's details first.
${needs}
  A participant who gets stuck and says where is a useful result: humanish does not count that
  run as a pass, and the friction the participant describes is the finding. To study your own
  app, change subject; humanish/studies/cua-browser.yaml shows the shape.
route: computer-use
mode: live # the other starter studies start as dry runs
subject:
  source: clone
  repos:
    - drawdb-io/drawdb
  clone:
    depth: 1
  serve:
    # Plain npm: humanish provides the Node runtime that the stock desktop image lacks.
    install: npm install --no-audit --no-fund
    build: npm run build
    start: npx vite preview --host 127.0.0.1 --port 3000
    url: http://127.0.0.1:3000/
${participant}
  persona: synthetic-new-user
  mission: >-
    You have never seen this diagram tool before. Add two tables and give them meaningful names,
    then stop and say what you did, what confused you, and where you hesitated.
${caps}execution:
  target: e2b-desktop
${timeout}
defaults:
  open: true
`,
  };
}

export const starterFiles: StarterFile[] = [
  {
    path: "humanish/README.md",
    plane: "source",
    contents: `# humanish

This directory holds the committed definitions of this app's humanish studies: study files,
personas and scenarios.

Keep this directory public-safe:

- synthetic personas only;
- synthetic fixtures only;
- env var names only, never values;
- no PII, PHI, secrets, raw private transcripts, private screenshots, customer data, or patient data.

Generated run bundles, screenshots, traces, logs, and local overrides belong in ignored \`.humanish/\`.

Studies:

- committed reusable studies live in humanish/studies/*.yaml;
- private or machine-local studies live in ignored .humanish/studies/*.yaml or
  .humanish/local/studies/*.yaml;
- run a study with \`humanish run <study>\`, or \`humanish watch <study>\` to stay attached;
- files under humanish/labs/ move there with \`humanish migrate\`.

Format standard:

- human-authored humanish source uses .yaml;
- generated artifacts, synthetic fixtures, and event streams use .json or .ndjson;
- .yml is reserved for outside ecosystem files such as GitHub Actions, not humanish source.
`,
  },
  {
    path: "humanish/personas/synthetic-new-user.yaml",
    plane: "source",
    contents: `schema: humanish.persona.v1
id: synthetic-new-user
name: Synthetic New User
summary: A privacy-safe first-time user evaluating the app with realistic but synthetic needs.
traits:
  patience: medium
  technical_confidence: medium
constraints:
  - Do not use real personal data.
  - Do not use production accounts.
  - Treat all credentials as env var names only.
`,
  },
  {
    path: "humanish/personas/skeptical-power-user.yaml",
    plane: "source",
    contents: `schema: humanish.persona.v1
id: skeptical-power-user
name: Skeptical Power User
summary: A privacy-safe experienced user looking for speed, reversibility, and clear proof.
traits:
  patience: low
  technical_confidence: high
  accessibility_needs: keyboard_first
constraints:
  - Do not use real personal data.
  - Prefer synthetic fixture inputs.
  - Flag unclear recovery paths.
`,
  },
  {
    path: "humanish/scenarios/first-run-smoke.yaml",
    plane: "source",
    contents: `schema: humanish.scenario.v1
id: first-run-smoke
title: First-run smoke
persona: synthetic-new-user
goal: Reach the first meaningful product state without using private data.
mode: dry-run
steps:
  - name: Open the app
    expectation: The app shell is reachable.
  - name: Complete the first synthetic action
    expectation: The user sees a clear next state.
  - name: Capture review notes
    expectation: Notes are public-safe and evidence-backed.
`,
  },
  {
    path: "humanish/studies/first-run.yaml",
    plane: "source",
    contents: `schema: humanish.study.v3
id: first-run
title: First-run synthetic Observer
description: >-
  Does a dry run: writes a synthetic run bundle and Observer for four participants. Needs no browser,
  model or keys, and costs nothing. Run it with humanish run first-run.
route: preview
mode: dry-run
subject:
  source: this-repo
actor:
  type: synthetic-persona
participants: 4
defaults:
  open: true
`,
  },
  tryLiveStudy("openai-computer-use"),
  localBrowserStudy(),
  {
    path: "humanish/studies/cua-browser.yaml",
    plane: "source",
    contents: `schema: humanish.study.v3
id: cua-browser
title: Computer-use browser study
description: >-
  A computer-use participant drives your app in a hosted desktop browser and writes its evidence
  to gitignored .humanish/. Starts as a dry run. For a live session, set mode to live
  and pass OPENAI_API_KEY and E2B_API_KEY with --dotenv. The clone subject below serves your
  repo inside the sandbox, and the env names declared under subject get their values from
  --dotenv without the values being saved. Screenshots keep full fidelity by default; set
  policies.redactScreenshots: true to blur them at capture for a bundle you can share as is.
  Typed text is recorded as its length only.
route: computer-use
mode: dry-run
subject:
  source: clone
  repos: [your-org/your-app]
  serve:
    install: pnpm install --frozen-lockfile
    build: pnpm build
    start: pnpm start
    url: http://127.0.0.1:3000/
    # installTimeoutMs: 1200000   # bump for monorepo-scale installs/builds (default 600000)
    # buildTimeoutMs: 1800000
  # env: [DATABASE_URL]
  # state:                        # the subject's state, recorded as provenance:
  #   seed:                       # ordered, bounded seed/migration/fixture steps (commands are
  #     - name: db-up             # author-trusted; evidence records sha256 digests, never text)
  #       command: sudo service postgresql start && pg_isready -t 30
  #       when: before-start      # before-build | before-start (default) | after-ready
  #     - name: db-migrate
  #       command: pnpm prisma migrate deploy
  #       timeoutMs: 300000       # per-step budget (default 300000)
  #     - name: admin-user        # after-ready steps run against the running app
  #       command: curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin
  #       when: after-ready
  #   # Or point at a shared DB you do not control; provenance records it as unpinned.
  #   # each name must also be declared in subject.env:
  #   # external: [DATABASE_URL]
  # clone:
  #   keep: true                  # keep the sandbox after a failure to debug install or boot
  # Alternative: drive a deployment you own (Vercel preview, staging) instead of a clone:
  # source: app-url
  # appUrl: https://your-preview.vercel.app/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Explore the app as a brand-new user trying to complete its primary flow. Note anything
    confusing. Stop when the flow completes or you are stuck.
execution:
  target: e2b-desktop
  # 20 minutes, the longest this route allows, so a session ends when the participant finishes.
  # The route clones, installs, builds and serves the subject before the participant starts, so
  # the sandbox deadline is this budget plus 40 minutes of provisioning and teardown, and a sandbox
  # lives at most 60 minutes. A value above 20 minutes fails the run before it starts; raise
  # execution.desktop.sandboxTimeoutMs if you need more. The dollar caps limit spend.
  timeoutMs: 1200000
  desktop:
    device: desktop             # mobile | small-mobile | narrow-mobile | tablet | desktop | wide
    # browser: chrome            # default | chrome | chromium | firefox; concrete values fail closed
    # Presets size the physical screen; Chrome's window width has a ~500px minimum.
    # For mobile presets, opt into CSS viewport, touch, DPR and mobile user-agent emulation:
    # fidelity: { mobileEmulation: true } # Chrome/Chromium only; desktop and tablet are unchanged
    # The bundle records measured screen, page viewport and emulation fidelity separately.
# policies:
#   redactScreenshots: true       # blur saved frames (off by default: full fidelity for local use)
#   allowPublicTargets: true      # required to drive a non-loopback app-url (a deployment you own)
defaults:
  open: true
`,
  },
];

export const runtimeDirectories: RuntimeDirectory[] = [
  { path: ".humanish/runs", plane: "runtime" },
  { path: ".humanish/cache", plane: "runtime" },
  { path: ".humanish/tmp", plane: "runtime" },
  { path: ".humanish/logs", plane: "runtime" },
  { path: ".humanish/studies", plane: "runtime" },
  { path: ".humanish/local/studies", plane: "runtime" },
  { path: ".humanish/local/personas", plane: "runtime" },
];

export const humanishScripts: Record<string, string> = {
  humanish: "humanish",
  "humanish:doctor": "humanish doctor",
  "humanish:run": "humanish run --dry-run",
  "humanish:watch": "humanish watch",
  "humanish:watch:ci": "humanish watch --json --no-open",
  "humanish:verify": "humanish verify",
};

/**
 * The starter files, with the live study written for the brain this machine can use.
 *
 * `local-agent` is not a variant of the study so much as a different participant: on a machine with
 * a signed-in Codex and no provider key, the study runs with the operator's own agent and needs
 * only E2B. Writing the other one there would hand someone homework instead of a first run.
 */
export function starterFilesFor(
  actor: StarterActor,
  localBrowser: LocalBrowserStarter = DEFAULT_LOCAL_BROWSER_STARTER,
  localAgent?: LocalAgentId,
): StarterFile[] {
  return starterFiles.map((file) =>
    file.path === "humanish/studies/local-browser.yaml"
      ? localBrowserStudy(localBrowser)
      : file.path === "humanish/studies/try-live.yaml"
        ? tryLiveStudy(actor, localAgent)
        : file,
  );
}
