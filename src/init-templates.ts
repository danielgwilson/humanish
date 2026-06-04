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
    path: "mimetic/README.md",
    plane: "source",
    contents: `# Mimetic

This directory is the committed source of persona simulation intent for this app.

Keep this directory public-safe:

- synthetic personas only;
- synthetic fixtures only;
- env var names only, never values;
- no PII, PHI, secrets, raw private transcripts, private screenshots, customer data, or patient data.

Generated run bundles, screenshots, traces, logs, and local overrides belong in ignored \`.mimetic/\`.

Labs:

- committed reusable labs live in mimetic/labs/*.yaml;
- private or machine-local labs live in ignored .mimetic/labs/*.yaml or .mimetic/local/labs/*.yaml;
- run a lab with \`mimetic watch <lab>\` or \`mimetic lab run <lab>\`.

Format standard:

- human-authored Mimetic source uses .yaml;
- executable integration uses .ts;
- generated artifacts, synthetic fixtures, and event streams use .json or .ndjson;
- .yml is reserved for outside ecosystem files such as GitHub Actions, not Mimetic source.
`
  },
  {
    path: "mimetic/config.ts",
    plane: "source",
    contents: `export default {
  schema: "mimetic.config.v1",
  app: {
    name: "synthetic-app",
    baseUrl: "http://localhost:3000",
    startCommand: "npm run dev"
  },
  personasDir: "mimetic/personas",
  scenariosDir: "mimetic/scenarios",
  policiesDir: "mimetic/policies",
  artifactsDir: ".mimetic/runs"
};
`
  },
  {
    path: "mimetic/personas/synthetic-new-user.yaml",
    plane: "source",
    contents: `schema: mimetic.persona.v1
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
    path: "mimetic/personas/skeptical-power-user.yaml",
    plane: "source",
    contents: `schema: mimetic.persona.v1
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
    path: "mimetic/scenarios/first-run-smoke.yaml",
    plane: "source",
    contents: `schema: mimetic.scenario.v1
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
    path: "mimetic/scenarios/onboarding-regression.yaml",
    plane: "source",
    contents: `schema: mimetic.scenario.v1
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
    path: "mimetic/labs/first-run.yaml",
    plane: "source",
    contents: `schema: mimetic.lab.v1
id: first-run
kind: synthetic
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
sims: 4
defaults:
  dryRun: true
  open: true
`
  },
  {
    path: "mimetic/policies/redaction.yaml",
    plane: "source",
    contents: `schema: mimetic.redaction-policy.v1
deny:
  - pii
  - phi
  - secrets
  - tokens
  - raw_private_transcripts
  - private_screenshots
  - customer_data
  - patient_data
allow:
  - synthetic_personas
  - synthetic_fixtures
  - env_var_names
`
  },
  {
    path: "mimetic/policies/network.yaml",
    plane: "source",
    contents: `schema: mimetic.network-policy.v1
default: local_only
allowed_hosts:
  - localhost
  - 127.0.0.1
notes:
  - Add external hosts only after confirming they are safe for public proof artifacts.
`
  },
  {
    path: "mimetic/policies/credentials.example.yaml",
    plane: "source",
    contents: `schema: mimetic.credentials-policy.v1
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
    path: "mimetic/adapters/app.ts",
    plane: "source",
    contents: `export const appAdapter = {
  schema: "mimetic.adapter.v1",
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
    path: "mimetic/review/vocabulary.yaml",
    plane: "source",
    contents: `schema: mimetic.review-vocabulary.v1
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
    path: "mimetic/review/milestones.yaml",
    plane: "source",
    contents: `schema: mimetic.milestones.v1
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
    path: "mimetic/coverage-map.md",
    plane: "source",
    contents: `# Coverage Map

This file should enumerate screens, roles, states, and paths before scenarios are treated as complete.

Current starter coverage is intentionally minimal and synthetic.
`
  },
  {
    path: "mimetic/coverage-matrix.md",
    plane: "source",
    contents: `# Coverage Matrix

| Area | Persona | Happy Path | Sad Path | Status |
| --- | --- | --- | --- | --- |
| First run | synthetic-new-user | planned | planned | starter |
| Onboarding | skeptical-power-user | planned | planned | starter |
`
  },
  {
    path: "mimetic/fixtures/synthetic-login-state.json",
    plane: "source",
    contents: `{
  "schema": "mimetic.synthetic-fixture.v1",
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
  { path: ".mimetic/runs", plane: "runtime" },
  { path: ".mimetic/cache", plane: "runtime" },
  { path: ".mimetic/tmp", plane: "runtime" },
  { path: ".mimetic/logs", plane: "runtime" },
  { path: ".mimetic/labs", plane: "runtime" },
  { path: ".mimetic/local/labs", plane: "runtime" },
  { path: ".mimetic/local/personas", plane: "runtime" },
  { path: ".mimetic/local/policies", plane: "runtime" },
  { path: ".mimetic/secrets", plane: "runtime" }
];

export const mimeticScripts: Record<string, string> = {
  mimetic: "mimetic",
  "mimetic:doctor": "mimetic doctor",
  "mimetic:run": "mimetic run --dry-run",
  "mimetic:watch": "mimetic watch",
  "mimetic:watch:ci": "mimetic watch --json --no-open",
  "mimetic:verify": "mimetic verify"
};
