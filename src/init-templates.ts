export interface StarterFile {
  path: string;
  contents: string;
  plane: "source";
}

export interface RuntimeDirectory {
  path: string;
  plane: "runtime";
}

export const starterFiles: StarterFile[] = [
  {
    path: "humanish/README.md",
    plane: "source",
    contents: `# Humanish

This directory is the committed source of persona simulation intent for this app.

Keep this directory public-safe:

- synthetic personas only;
- synthetic fixtures only;
- env var names only, never values;
- no PII, PHI, secrets, raw private transcripts, private screenshots, customer data, or patient data.

Generated run bundles, screenshots, traces, logs, and local overrides belong in ignored \`.humanish/\`.

Labs:

- committed reusable labs live in humanish/labs/*.yaml;
- private or machine-local labs live in ignored .humanish/labs/*.yaml or .humanish/local/labs/*.yaml;
- run a lab with \`humanish watch <lab>\` or \`humanish lab run <lab>\`.

Format standard:

- human-authored Humanish source uses .yaml;
- executable integration uses .ts;
- generated artifacts, synthetic fixtures, and event streams use .json or .ndjson;
- .yml is reserved for outside ecosystem files such as GitHub Actions, not Humanish source.
`
  },
  {
    path: "humanish/config.ts",
    plane: "source",
    contents: `export default {
  schema: "humanish.config.v1",
  app: {
    name: "synthetic-app",
    baseUrl: "http://localhost:3000",
    startCommand: "npm run dev"
  },
  personasDir: "humanish/personas",
  scenariosDir: "humanish/scenarios",
  policiesDir: "humanish/policies",
  artifactsDir: ".humanish/runs"
};
`
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
  accessibility_needs: none_declared
constraints:
  - Do not use real personal data.
  - Do not use production accounts.
  - Treat all credentials as env var names only.
`
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
`
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
`
  },
  {
    path: "humanish/scenarios/onboarding-regression.yaml",
    plane: "source",
    contents: `schema: humanish.scenario.v1
id: onboarding-regression
title: Onboarding regression
persona: skeptical-power-user
goal: Exercise onboarding friction using synthetic inputs and explicit recovery checks.
mode: dry-run
steps:
  - name: Start onboarding
    expectation: Required information is clear.
  - name: Use synthetic fixture data
    expectation: No real user data is entered.
  - name: Check recovery path
    expectation: The user can back out or retry safely.
`
  },
  {
    path: "humanish/labs/first-run.yaml",
    plane: "source",
    contents: `schema: humanish.lab.v2
id: first-run
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
subject:
  source: this-repo
actors:
  - type: synthetic-persona
    count: 4
scenario:
  mode: dry-run
defaults:
  open: true
`
  },
  {
    path: "humanish/labs/cua-browser.yaml",
    plane: "source",
    contents: `schema: humanish.lab.v2
id: cua-browser
title: Computer-use browser lab
description: >-
  A registered computer-use actor drives your app in a hosted desktop browser and emits an
  evidence bundle into gitignored .humanish/. Screenshots are full-fidelity (raw) by default;
  set policies.redactScreenshots: true to blur at capture for a share-as-is bundle. Typed
  text is recorded as length only. Dry-run by default; switch scenario.mode to live (with
  OPENAI_API_KEY + E2B_API_KEY via --env-file) for a real session. The clone subject below
  serves your repo INSIDE the sandbox; declared subject env NAMES are provisioned from
  --env-file (values are never persisted).
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
  # state:                        # the subject's STATE story (recorded as provenance):
  #   seed:                       # ordered, bounded seed/migration/fixture steps (commands are
  #     - name: db-up             # author-trusted; evidence records sha256 digests, never text)
  #       command: sudo service postgresql start && pg_isready -t 30
  #       when: before-start      # before-build | before-start (default) | after-ready
  #     - name: db-migrate
  #       command: pnpm prisma migrate deploy
  #       timeoutMs: 300000       # per-step budget (default 300000)
  #     - name: admin-user        # after-ready steps run against the RUNNING app
  #       command: curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin
  #       when: after-ready
  #   # Or point at a shared DB you do NOT control — recorded as UNPINNED in provenance;
  #   # each name must also be declared in subject.env:
  #   # external: [DATABASE_URL]
  # clone:
  #   keep: true                  # leave the sandbox up on FAILURE so you can debug install/boot
  # Alternative: drive a deployment you own (Vercel preview, staging) instead of a clone:
  # source: app-url
  # appUrl: https://your-preview.vercel.app/
actors:
  - type: openai-computer-use
    persona: first-time-visitor
    mission: >-
      Explore the app as a brand-new user trying to complete its primary flow. Note anything
      confusing. Stop when the flow completes or you are stuck.
execution:
  target: e2b-desktop
  timeoutMs: 300000
  desktop:
    device: desktop             # mobile | small-mobile | narrow-mobile | tablet | desktop | wide
    # browser: chrome            # default | chrome | chromium | firefox; concrete values fail closed
    # On this route only width/height render (real mobile LAYOUT); the model is told its device.
    # True touch/DPR/UA emulation comes with the deterministic CDP actor (a later slice).
scenario:
  mode: dry-run
# policies:
#   redactScreenshots: true       # blur persisted frames (default off — full fidelity for local use)
#   allowPublicTargets: true      # required to drive a non-loopback app-url (a deployment you own)
defaults:
  open: true
`
  },
  {
    path: "humanish/policies/redaction.yaml",
    plane: "source",
    contents: `schema: humanish.redaction-policy.v1
# Public-safety policy of intent for this project.
#
# Enforcement scope: \`humanish verify\` detects the classes under \`enforced\`
# (secret/key/token shapes and known local-path shapes) and fails closed on a
# match. It does NOT detect free-form PII/PHI (names, emails, DOBs, MRNs). The
# classes under \`author_responsibility\` are forbidden in public output but rely
# on using synthetic data and on review, not automated detection. So
# \`redaction: passed\` means the secret/path scan found no matches, not that the
# artifact was certified free of PII/PHI.
deny:
  - pii
  - phi
  - secrets
  - tokens
  - raw_private_transcripts
  - private_screenshots
  - customer_data
  - patient_data
enforced:
  - secret_key_token_shapes
  - known_local_path_shapes
author_responsibility:
  - pii
  - phi
  - patient_data
  - customer_data
  - names_emails_and_other_identifiers
allow:
  - synthetic_personas
  - synthetic_fixtures
  - env_var_names
`
  },
  {
    path: "humanish/policies/network.yaml",
    plane: "source",
    contents: `schema: humanish.network-policy.v1
default: local_only
allowed_hosts:
  - localhost
  - 127.0.0.1
notes:
  - Add external hosts only after confirming they are safe for public proof artifacts.
`
  },
  {
    path: "humanish/policies/credentials.example.yaml",
    plane: "source",
    contents: `schema: humanish.credentials-policy.v1
env_names:
  openai: OPENAI_API_KEY
  e2b: E2B_API_KEY
rules:
  - Store values outside the repository.
  - Commit env var names only.
  - Do not paste keys into personas, scenarios, issue drafts, or run bundles.
`
  },
  {
    path: "humanish/adapters/app.ts",
    plane: "source",
    contents: `export const appAdapter = {
  schema: "humanish.adapter.v1",
  id: "synthetic-app",
  name: "Synthetic App",
  routes: [
    {
      id: "home",
      path: "/",
      description: "Synthetic app entry point"
    }
  ]
};
`
  },
  {
    path: "humanish/review/vocabulary.yaml",
    plane: "source",
    contents: `schema: humanish.review-vocabulary.v1
verdicts:
  - pass
  - fail
  - blocked
  - needs_evidence
labels:
  friction: User-visible friction.
  gap: Missing evidence or missing coverage.
  public_safety: Potential privacy, secret, or public-boundary issue.
`
  },
  {
    path: "humanish/review/milestones.yaml",
    plane: "source",
    contents: `schema: humanish.milestones.v1
milestones:
  - id: first-visible-state
    description: The first meaningful app state is visible.
  - id: synthetic-action-complete
    description: A synthetic user action reaches an expected state.
  - id: review-ready
    description: Public-safe evidence is ready for review.
`
  },
  {
    path: "humanish/coverage-map.md",
    plane: "source",
    contents: `# Coverage Map

This file should enumerate screens, roles, states, and paths before scenarios are treated as complete.

Current starter coverage is intentionally minimal and synthetic.
`
  },
  {
    path: "humanish/coverage-matrix.md",
    plane: "source",
    contents: `# Coverage Matrix

| Area | Persona | Happy Path | Sad Path | Status |
| --- | --- | --- | --- | --- |
| First run | synthetic-new-user | planned | planned | starter |
| Onboarding | skeptical-power-user | planned | planned | starter |
`
  },
  {
    path: "humanish/fixtures/synthetic-login-state.json",
    plane: "source",
    contents: `{
  "schema": "humanish.synthetic-fixture.v1",
  "kind": "login-state",
  "user": {
    "id": "synthetic-user-001",
    "email": "synthetic.user@example.test"
  },
  "notes": [
    "Synthetic fixture only.",
    "Do not replace with real user data."
  ]
}
`
  }
];

export const runtimeDirectories: RuntimeDirectory[] = [
  { path: ".humanish/runs", plane: "runtime" },
  { path: ".humanish/cache", plane: "runtime" },
  { path: ".humanish/tmp", plane: "runtime" },
  { path: ".humanish/logs", plane: "runtime" },
  { path: ".humanish/labs", plane: "runtime" },
  { path: ".humanish/local/labs", plane: "runtime" },
  { path: ".humanish/local/personas", plane: "runtime" },
  { path: ".humanish/local/policies", plane: "runtime" },
  { path: ".humanish/secrets", plane: "runtime" }
];

export const humanishScripts: Record<string, string> = {
  humanish: "humanish",
  "humanish:doctor": "humanish doctor",
  "humanish:run": "humanish run --dry-run",
  "humanish:watch": "humanish watch",
  "humanish:watch:ci": "humanish watch --json --no-open",
  "humanish:verify": "humanish verify"
};
