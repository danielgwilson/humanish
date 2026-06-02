import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderObserver } from "./observer.js";
import type { ObserverResult } from "./observer.js";
import {
  DEFAULT_OSS_REPOS,
  normalizeOssRepoSlugs,
  validateOssRepoSlug
} from "./oss-lab.js";
import {
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  runDryRun
} from "./run.js";
import type {
  ReviewSummary,
  RunBundle,
  RunEvent,
  RunResult,
  RunSimulation,
  RunStream
} from "./run.js";

export const OSS_META_LAB_SCHEMA = "mimetic.oss-meta-lab-result.v1";

export interface OssMetaLabOptions {
  count?: number;
  cwd: string;
  dryRun?: boolean;
  open?: boolean;
  repos?: string[];
  runId?: string;
}

export interface OssMetaLabAssignment {
  index: number;
  repo: string;
  scenarioId: string;
  simId: string;
  streamId: string;
}

interface OssMetaLabLiveDesktop {
  error?: string;
  repo: string;
  sandboxId?: string;
  simId: string;
  streamId: string;
  url?: string;
}

export interface OssMetaLabResult {
  schema: typeof OSS_META_LAB_SCHEMA;
  ok: boolean;
  assignments: OssMetaLabAssignment[];
  count?: number;
  cwd: string;
  dryRun: boolean;
  error?: {
    code:
      | "MIMETIC_INVALID_OSS_COUNT"
      | "MIMETIC_INVALID_OSS_REPO"
      | "MIMETIC_META_RUN_FAILED";
    message: string;
  };
  liveRequested: boolean;
  observer?: ObserverResult;
  repos: string[];
  runId?: string;
  sandboxes: Array<{
    repo: string;
    sandboxId?: string;
    streamId: string;
    urlPresent: boolean;
  }>;
  warnings: string[];
}

export function buildOssRepoAssignments(repos: string[], count: number): OssMetaLabAssignment[] {
  return Array.from({ length: count }, (_, index) => {
    const repo = repos[index % repos.length];
    if (!repo) {
      throw new Error("At least one OSS repo is required.");
    }

    return {
      index: index + 1,
      repo,
      scenarioId: `oss-meta-${repoSlugToken(repo)}`,
      simId: `oss-${String(index + 1).padStart(2, "0")}`,
      streamId: `oss-${String(index + 1).padStart(2, "0")}-desktop`
    };
  });
}

export async function runOssMetaLab(options: OssMetaLabOptions): Promise<OssMetaLabResult> {
  const cwd = path.resolve(options.cwd);
  const dryRun = options.dryRun === true;
  const liveRequested = !dryRun;
  const warnings: string[] = [];
  const repos = normalizeOssRepoSlugs(options.repos);
  const count = options.count ?? DEFAULT_OSS_REPOS.length;

  if (!Number.isInteger(count) || count < 1 || count > 16) {
    return {
      schema: OSS_META_LAB_SCHEMA,
      ok: false,
      assignments: [],
      cwd,
      dryRun,
      error: {
        code: "MIMETIC_INVALID_OSS_COUNT",
        message: "--count must be an integer between 1 and 16."
      },
      liveRequested,
      repos,
      sandboxes: [],
      warnings
    };
  }

  const invalid = repos.find((repo) => !validateOssRepoSlug(repo));
  if (invalid) {
    return {
      schema: OSS_META_LAB_SCHEMA,
      ok: false,
      assignments: [],
      count,
      cwd,
      dryRun,
      error: {
        code: "MIMETIC_INVALID_OSS_REPO",
        message: `Only public GitHub owner/repo slugs are supported: ${invalid}`
      },
      liveRequested,
      repos,
      sandboxes: [],
      warnings
    };
  }

  const missingKeys = missingLiveKeys(process.env);
  if (liveRequested && missingKeys.length > 0) {
    warnings.push(`Live E2B/Codex launch is waiting on env vars: ${missingKeys.join(", ")}.`);
    warnings.push("Observer lanes stay in the live waiting state until keys are present.");
  }

  const assignments = buildOssRepoAssignments(repos, count);
  const liveDesktops = liveRequested && missingKeys.length === 0
    ? await launchLiveDesktops(assignments)
    : [];
  const liveDesktopCount = liveDesktops.filter((desktop) => desktop.url).length;
  const failedLiveDesktopCount = liveDesktops.filter((desktop) => desktop.error).length;
  if (liveDesktops.length > 0) {
    warnings.push(`Launched ${liveDesktopCount}/${liveDesktops.length} live E2B desktop stream${liveDesktops.length === 1 ? "" : "s"}.`);
    warnings.push("Codex TUI injection and nested Mimetic execution remain the next substrate slice behind these live desktops.");
  }
  if (failedLiveDesktopCount > 0) {
    warnings.push(`${failedLiveDesktopCount} E2B desktop launch${failedLiveDesktopCount === 1 ? "" : "es"} failed; see stream events in the Observer.`);
  }

  const runId = options.runId ?? makeMetaRunId();
  const runResult: RunResult = await runDryRun({
    cwd,
    dryRun: true,
    runId,
    simCount: count
  });

  if (!runResult.ok || !runResult.runId) {
    return {
      schema: OSS_META_LAB_SCHEMA,
      ok: false,
      assignments,
      count,
      cwd,
      dryRun,
      error: {
        code: "MIMETIC_META_RUN_FAILED",
        message: runResult.error?.message ?? "Failed to create OSS meta-lab run bundle."
      },
      liveRequested,
      repos,
      sandboxes: liveDesktops.map(formatLiveDesktopForResult),
      warnings: [...warnings, ...runResult.warnings]
    };
  }

  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const bundlePath = path.join(artifactRoot, "run.json");
  const createdAt = new Date().toISOString();
  const bundle = buildMetaBundle({
    assignments,
    createdAt,
    cwd,
    dryRun,
    liveDesktops,
    liveRequested,
    missingKeys,
    runId
  });

  await mkdir(artifactRoot, { recursive: true });
  await writeJson(bundlePath, bundle);
  await writeJson(path.join(artifactRoot, "review.json"), bundle.review);
  await writeFile(path.join(artifactRoot, "review.md"), renderMetaReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const observer = await renderObserver(cwd, runId, { open: options.open === true });

  return {
    schema: OSS_META_LAB_SCHEMA,
    ok: observer.ok,
    assignments,
    count,
    cwd,
    dryRun,
    liveRequested,
    observer,
    repos,
    runId,
    sandboxes: liveDesktops.map(formatLiveDesktopForResult),
    warnings: [...warnings, ...observer.warnings]
  };
}

function buildMetaBundle(args: {
  assignments: OssMetaLabAssignment[];
  createdAt: string;
  cwd: string;
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
  runId: string;
}): RunBundle {
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [
    {
      id: "event-000",
      at: args.createdAt,
      level: "info",
      type: "oss-meta.contract.created",
      message: "Created public-safe OSS meta-lab Observer-of-Observers contract."
    }
  ];

  for (const assignment of args.assignments) {
    const prompt = buildCodexBootstrapPrompt(assignment);
    const liveDesktop = args.liveDesktops.find((desktop) => desktop.streamId === assignment.streamId);
    const status = statusForMeta(args, liveDesktop);
    simulations.push({
      id: assignment.simId,
      index: assignment.index,
      personaId: `codex-oss-operator-${String(assignment.index).padStart(2, "0")}`,
      scenarioId: assignment.scenarioId,
      status,
      streamKind: "browser",
      mode: "ui-sim",
      progress: progressForMeta(status, liveDesktop),
      currentStep: currentStepForMeta(args, assignment),
      summary: `Headed E2B desktop lane assigned to ${assignment.repo}; nested Codex TUI should set up Mimetic and open a nested Observer inside that desktop.`,
      streamIds: [assignment.streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    streams.push({
      id: assignment.streamId,
      simId: assignment.simId,
      kind: "browser",
      label: `E2B desktop - ${assignment.repo}`,
      status,
      transport: liveDesktop?.url ? "sse" : status === "contract_proof_only" ? "snapshot" : "sse",
      updatedAt: args.createdAt,
      ...(liveDesktop?.url ? { url: liveDesktop.url } : {}),
      embed: {
        kind: liveDesktop?.url ? "iframe" : "placeholder",
        ...(liveDesktop?.url ? { url: liveDesktop.url } : {}),
        title: `E2B desktop ${assignment.index}`
      },
      viewport: {
        width: 1440,
        height: 960,
        deviceScaleFactor: 1
      },
      terminal: {
        title: `Codex TUI bootstrap - ${assignment.repo}`,
        format: "plain",
        stdin: "planned",
        tail: prompt
      },
      ui: {
        route: `e2b://desktop/${assignment.repo}`,
        intent: "Watch the headed desktop where Codex clones the repo, sets up Mimetic, and opens the nested Observer.",
        state: liveDesktop?.url ? "live E2B desktop" : args.dryRun ? "contract desktop" : "headed E2B desktop"
      },
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "events", path: "events.ndjson", kind: "events" }
      ]
    });

    events.push(
      {
        id: `event-${String(assignment.index).padStart(3, "0")}-assigned`,
        at: args.createdAt,
        level: "info",
        type: "oss-meta.repo.assigned",
        message: `Assigned ${assignment.repo} to Codex desktop lane ${assignment.index}.`,
        simId: assignment.simId,
        streamId: assignment.streamId
      },
      {
        id: `event-${String(assignment.index).padStart(3, "0")}-prompt`,
        at: args.createdAt,
        level: "info",
        type: "oss-meta.codex.prompt.ready",
        message: "Codex TUI bootstrap prompt is available in the stream logs tab.",
        simId: assignment.simId,
        streamId: assignment.streamId
      }
    );

    if (liveDesktop?.url) {
      events.push({
        id: `event-${String(assignment.index).padStart(3, "0")}-stream`,
        at: args.createdAt,
        level: "info",
        type: "oss-meta.e2b.stream.started",
        message: `Live E2B desktop stream started for ${assignment.repo}.`,
        simId: assignment.simId,
        streamId: assignment.streamId
      });
    } else if (liveDesktop?.error) {
      events.push({
        id: `event-${String(assignment.index).padStart(3, "0")}-stream-error`,
        at: args.createdAt,
        level: "error",
        type: "oss-meta.e2b.stream.failed",
        message: `E2B desktop stream failed for ${assignment.repo}: ${liveDesktop.error}`,
        simId: assignment.simId,
        streamId: assignment.streamId
      });
    }
  }

  if (args.liveRequested && args.missingKeys.length > 0) {
    events.push({
      id: "event-live-keys-blocked",
      at: args.createdAt,
      level: "warn",
      type: "oss-meta.live.keys_missing",
      message: `Live launch is blocked until ${args.missingKeys.join(", ")} are present.`
    });
  }

  if (args.liveRequested && args.liveDesktops.length === 0) {
    events.push({
      id: "event-live-substrate-planned",
      at: args.createdAt,
      level: "warn",
      type: "oss-meta.live.substrate_planned",
      message: args.missingKeys.length > 0
        ? "E2B desktop launch is waiting on required environment variables."
        : "Codex TUI injection and nested Mimetic execution are planned behind this Observer contract."
    });
  }
  if (args.liveDesktops.some((desktop) => desktop.url)) {
    events.push({
      id: "event-live-substrate-started",
      at: args.createdAt,
      level: "info",
      type: "oss-meta.live.substrate_started",
      message: "E2B desktop streams are connected; Codex TUI injection is still pending."
    });
  }

  const review = createMetaReview(args);
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "dry-run",
    simCount: args.assignments.length,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: {
      packageName: "mimetic-cli",
      mimeticSource: "present",
      git: {
        status: "not_captured",
        note: "OSS meta-lab does not capture host git state in this slice."
      }
    },
    persona: {
      id: "oss-meta-codex-tui-operators",
      name: "Codex TUI OSS Setup Operators",
      source: "lab:oss:meta",
      sourceDigest: "public-safe"
    },
    scenario: {
      id: "oss-meta-observer-of-observers",
      title: "OSS Observer-of-Observers Meta-Lab",
      goal: "Launch headed E2B desktops where Codex agents clone public OSS repos, set up Mimetic, author plausible personas/scenarios, run real nested sims, and keep each nested Observer visible.",
      source: "lab:oss:meta",
      sourceDigest: "public-safe"
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "oss-meta.run.created",
        message: `Created OSS meta-lab run with ${args.assignments.length} headed desktop lane${args.assignments.length === 1 ? "" : "s"}.`
      },
      {
        at: args.createdAt,
        event: "oss-meta.repos.assigned",
        message: `Assigned repos: ${args.assignments.map((assignment) => assignment.repo).join(", ")}.`
      },
      {
        at: args.createdAt,
        event: "oss-meta.observer.ready",
        message: "Top-level Observer is ready to watch nested Mimetic Observers."
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: "OSS meta-lab artifacts contain public GitHub slugs and synthetic bootstrap prompts only."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: []
  };
}

function statusForMeta(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
}, liveDesktop: OssMetaLabLiveDesktop | undefined): RunSimulation["status"] {
  if (args.dryRun) return "contract_proof_only";
  if (liveDesktop?.url) return "running";
  if (liveDesktop?.error) return "failed";
  if (args.missingKeys.length > 0) return "blocked";
  return "preparing";
}

function progressForMeta(status: RunSimulation["status"], liveDesktop: OssMetaLabLiveDesktop | undefined): number {
  if (status === "contract_proof_only") return 100;
  if (status === "blocked") return 18;
  if (status === "failed") return 8;
  if (liveDesktop?.url) return 58;
  return 34;
}

function currentStepForMeta(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
}, assignment: OssMetaLabAssignment): string {
  const liveDesktop = args.liveDesktops.find((desktop) => desktop.streamId === assignment.streamId);
  if (args.dryRun) {
    return `Contract ready for ${assignment.repo}; no E2B desktop launched.`;
  }
  if (liveDesktop?.url) {
    return `Live E2B desktop connected for ${assignment.repo}; Codex TUI injection pending.`;
  }
  if (liveDesktop?.error) {
    return `E2B desktop launch failed for ${assignment.repo}.`;
  }
  if (args.missingKeys.length > 0) {
    return `Waiting for ${args.missingKeys.join(", ")} before launching ${assignment.repo}.`;
  }
  return `Ready to launch E2B desktop and inject Codex TUI for ${assignment.repo}.`;
}

function createMetaReview(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
}): ReviewSummary {
  const gaps = [
    "Nested Mimetic Observer evidence is represented as a lane contract until Codex TUI injection and nested Mimetic execution land.",
    "The top-level run does not clone, modify, commit, push, or file issues in target repos.",
    "Only public GitHub owner/repo slugs are recorded."
  ];

  if (args.liveRequested && args.missingKeys.length > 0) {
    gaps.unshift(`Live launch is blocked until ${args.missingKeys.join(", ")} are available in environment.`);
  }
  if (args.liveDesktops.some((desktop) => desktop.url)) {
    gaps.unshift("Live E2B desktop streams are connected, but Codex TUI injection and nested Mimetic execution are not yet automated.");
  }

  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: args.dryRun
      ? "OSS meta-lab dry-run rendered the Observer-of-Observers contract without provider spend."
      : args.liveDesktops.some((desktop) => desktop.url)
        ? "OSS meta-lab launched live E2B desktop streams and rendered them in the top-level Observer."
        : "OSS meta-lab rendered the live headed-desktop control surface and marked the missing substrate truth in-lane.",
    gaps
  };
}

function buildCodexBootstrapPrompt(assignment: OssMetaLabAssignment): string {
  return [
    `# Mimetic OSS Meta-Lab Actor ${assignment.index}`,
    "",
    "You are running inside a disposable headed E2B desktop with a visible terminal and browser.",
    "Public-safety hard rails: use only public repo contents; never print keys; never commit, push, file issues, or preserve private artifacts.",
    "",
    `Target repo: https://github.com/${assignment.repo}.git`,
    "",
    "Mission:",
    "1. Clone the target repo into a clean disposable workspace.",
    "2. Inspect the package manager, dev scripts, README, and app shape.",
    "3. Get the repo into a local runnable dev mode if feasible.",
    "4. Install Mimetic as a dev dependency with the package manager the repo already uses.",
    "5. Run `npx mimetic init --yes` or the package-manager equivalent.",
    "6. Author plausible public-safe Mimetic personas and scenarios for this repo.",
    "7. Run a real Mimetic sim using the provided OPENAI_API_KEY and E2B_API_KEY environment variables.",
    "8. Open the nested Mimetic Observer in the E2B browser and keep it visible.",
    "9. Record public-safe blockers and evidence paths only.",
    "",
    "Expected nested outcome: the top-level Mimetic Observer shows this desktop, and this desktop shows its own nested Mimetic Observer."
  ].join("\n");
}

function renderMetaReviewMarkdown(bundle: RunBundle): string {
  return `# Mimetic OSS Meta-Lab Review

Run: ${bundle.runId}

Verdict: ${bundle.review.verdict}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Assigned Repos

${bundle.streams.map((stream) => `- ${stream.label}: ${stream.simId}`).join("\n")}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}

async function launchLiveDesktops(assignments: OssMetaLabAssignment[]): Promise<OssMetaLabLiveDesktop[]> {
  const e2bApiKey = process.env.E2B_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!e2bApiKey || !openaiApiKey) {
    return [];
  }

  const desktopPackage = "@e2b/desktop";
  const desktopModule = await import(desktopPackage) as unknown as E2BDesktopModule;
  const timeoutMs = readPositiveInt(process.env.MIMETIC_E2B_TIMEOUT_MS, 60 * 60 * 1000);
  const requestTimeoutMs = readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);

  return Promise.all(assignments.map(async (assignment) => {
    try {
      const desktop = await desktopModule.Sandbox.create({
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs,
        metadata: {
          tool: "mimetic-cli",
          mode: "oss-meta-lab",
          repo: assignment.repo,
          simId: assignment.simId
        },
        envs: {
          E2B_API_KEY: e2bApiKey,
          OPENAI_API_KEY: openaiApiKey
        },
        resolution: [1440, 960],
        dpi: 96,
        lifecycle: {
          onTimeout: "kill"
        }
      });
      await desktop.launch("google-chrome", `https://github.com/${assignment.repo}`).catch(() => undefined);
      await desktop.wait(2000).catch(() => undefined);
      await desktop.stream.start({ requireAuth: true });
      const authKey = desktop.stream.getAuthKey();
      const url = desktop.stream.getUrl({
        authKey,
        autoConnect: true,
        viewOnly: true,
        resize: "scale"
      });

      return {
        repo: assignment.repo,
        sandboxId: desktop.sandboxId,
        simId: assignment.simId,
        streamId: assignment.streamId,
        url
      };
    } catch (error) {
      return {
        error: compactError(error),
        repo: assignment.repo,
        simId: assignment.simId,
        streamId: assignment.streamId
      };
    }
  }));
}

function formatLiveDesktopForResult(desktop: OssMetaLabLiveDesktop): OssMetaLabResult["sandboxes"][number] {
  return {
    repo: desktop.repo,
    ...(desktop.sandboxId ? { sandboxId: desktop.sandboxId } : {}),
    streamId: desktop.streamId,
    urlPresent: Boolean(desktop.url)
  };
}

function missingLiveKeys(env: NodeJS.ProcessEnv): string[] {
  return ["E2B_API_KEY", "OPENAI_API_KEY"].filter((name) => !env[name]?.trim());
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function makeMetaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `oss-meta-${stamp}-${randomBytes(4).toString("hex")}`;
}

function repoSlugToken(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface E2BDesktopModule {
  Sandbox: {
    create(options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
  };
}

interface E2BDesktopCreateOptions {
  apiKey: string;
  dpi?: number;
  envs?: Record<string, string>;
  lifecycle?: {
    onTimeout: "kill" | "pause";
  };
  metadata?: Record<string, string>;
  requestTimeoutMs?: number;
  resolution?: [number, number];
  timeoutMs?: number;
}

interface E2BDesktopSandbox {
  sandboxId: string;
  launch(application: string, uri?: string): Promise<void>;
  wait(ms: number): Promise<void>;
  stream: {
    getAuthKey(): string;
    getUrl(options?: {
      authKey?: string;
      autoConnect?: boolean;
      resize?: "off" | "scale" | "remote";
      viewOnly?: boolean;
    }): string;
    start(options?: {
      requireAuth?: boolean;
      windowId?: string;
    }): Promise<void>;
  };
}
