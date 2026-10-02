// The built Observer app and the HTML that carries a run's data into it. The app comes from the
// package's dist/observer-app.html, or in a repo checkout is built from observer/ when missing or
// stale, and is cached for the process. Run data and study analysis are embedded as JSON scripts.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectShareCheckedAnalysis, analysisSharingProblems } from "../analysis/sharing.js";
import type { LoadedAnalysis } from "../analysis/types.js";
import { withObserverEndings, type ObserverData } from "./data.js";

const OBSERVER_DATA_PLACEHOLDER = "__HUMANISH_OBSERVER_DATA__";

const OBSERVER_DATA_SLOT = `<script id="observer-data" type="application/json">${OBSERVER_DATA_PLACEHOLDER}</script>`;

let cachedObserverArtifact: string | null = null;

/**
 * Resolve (and in a repo checkout, build) the Observer artifact before any run or
 * lab work starts. A missing artifact must cost seconds at startup, never a completed
 * session (a live participant spends real money before the render step would have noticed).
 * Unconditional on purpose: the artifact is the only renderer now, so the fail-before-
 * spend property this preflight bought under the flag matters more, not less.
 */
export function preflightObserverArtifact(): void {
  loadObserverArtifact();
}

function loadObserverArtifact(): string {
  if (cachedObserverArtifact !== null) return cachedObserverArtifact;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  // Published package: the root build ships the artifact at the dist/ root, one level above
  // this module. Never auto-built: an installed package either carries it or is broken.
  const packagedHtml = readObserverArtifact(path.join(moduleDir, "..", "observer-app.html"));
  if (packagedHtml !== null) {
    cachedObserverArtifact = packagedHtml;
    return packagedHtml;
  }

  // Repo checkout (this module sits two levels under the root, in src/observer/ or
  // dist/observer/): build the workspace on demand when it is missing or stale.
  const repoRoot = path.join(moduleDir, "..", "..");
  const workspaceDir = path.join(repoRoot, "observer");
  const artifactPath = path.join(workspaceDir, "dist", "index.html");
  if (existsSync(path.join(workspaceDir, "package.json"))) {
    if (observerArtifactNeedsBuild(workspaceDir, artifactPath)) {
      // Concurrent cold starts (parallel test workers, two watch processes launched
      // together) must not race one `vite build` output: a reader can catch the
      // artifact half-written. A mkdir lock serializes builders across processes;
      // whoever loses the race re-checks staleness and usually just reads.
      // The lock lives outside dist/ (vite empties dist mid-build) and inside an
      // ignored path so a crashed builder cannot dirty the tree.
      const lockDir = path.join(workspaceDir, "node_modules", ".observer-build-lock");
      mkdirSync(path.dirname(lockDir), { recursive: true });
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          mkdirSync(lockDir);
          break; // lock acquired — this process builds
        } catch {
          if (Date.now() > deadline) break; // stale lock: build anyway, last writer wins
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          if (!observerArtifactNeedsBuild(workspaceDir, artifactPath)) {
            const built = readObserverArtifact(artifactPath);
            if (built !== null) {
              cachedObserverArtifact = built;
              return built;
            }
          }
        }
      }
      try {
        if (observerArtifactNeedsBuild(workspaceDir, artifactPath)) {
          process.stderr.write("observer: building the Observer artifact (observer/ workspace)…\n");
          try {
            // NODE_ENV is forced: Vite respects a preset NODE_ENV (test, development),
            // and a dev-flavored artifact embeds jsxDEV plus the builder's absolute
            // filesystem paths — which the run's public-safety scan then rightly rejects.
            execSync("pnpm --filter humanish-observer build", {
              cwd: repoRoot,
              stdio: ["ignore", "pipe", "inherit"],
              env: { ...process.env, NODE_ENV: "production" },
            });
          } catch {
            throw new Error(
              "observer workspace build failed — run `pnpm --filter humanish-observer build` for the full output.",
            );
          }
        }
      } finally {
        rmSync(lockDir, { force: true, recursive: true });
      }
    }
    const html = readObserverArtifact(artifactPath);
    if (html !== null) {
      cachedObserverArtifact = html;
      return html;
    }
  }

  throw new Error(
    "the Observer needs its prebuilt artifact (dist/observer-app.html in the package, observer/dist/index.html in a repo checkout); run `pnpm --filter humanish-observer build`, or reinstall the package.",
  );
}

function readObserverArtifact(candidate: string): string | null {
  let html: string;
  try {
    html = readFileSync(candidate, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!html.includes(OBSERVER_DATA_SLOT)) {
    throw new Error(`Observer artifact at ${candidate} has no observer-data slot.`);
  }
  return html;
}

/** internal: exported for tests. Missing artifact, or any workspace source newer than it. */
export function observerArtifactNeedsBuild(workspaceDir: string, artifactPath: string): boolean {
  let artifactMtime: number;
  try {
    artifactMtime = statSync(artifactPath).mtimeMs;
  } catch {
    return true;
  }
  return newestSourceMtime(workspaceDir) > artifactMtime;
}

function newestSourceMtime(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // A file vanishing mid-scan (editor save) just doesn't advance the clock.
      }
    }
  }
  return newest;
}

/** Portable files store each exact raster once, outside the run-data JSON. */
export type ObserverExportAssets = Record<string, { mime: string; base64: string }>;

function renderExportAssets(assets: ObserverExportAssets): string {
  return Object.entries(assets)
    .map(([hash, image]) => {
      if (
        !/^[a-f0-9]{64}$/.test(hash) ||
        !/^image\/(png|jpeg|gif|webp)$/.test(image.mime) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)
      )
        throw new Error("Invalid portable raster");
      return `<script id="humanish-image-${hash}" type="application/octet-stream" data-mime="${image.mime}">${image.base64}</script>`;
    })
    .join("");
}

function renderObserverAppHtml(
  data: ObserverData,
  snapshot: boolean,
  analysis: LoadedAnalysis,
  assets: ObserverExportAssets,
): string {
  const artifact = loadObserverArtifact();
  // A renderer-owned boot marker, outside the untrusted run-data contract. Only
  // portable HTML exports opt out of a live feed; ordinary served pages still poll.
  return (
    snapshot
      ? artifact.replace(
          "</head>",
          '<meta name="humanish-observer-mode" content="snapshot"></head>',
        )
      : artifact
  )
    .replace(
      OBSERVER_DATA_SLOT,
      () => `<script id="observer-data" type="application/json">${escapeJsonScript(data)}</script>`,
    )
    .replace(
      /<script id="study-analysis" type="application\/json">[\s\S]*?<\/script>/,
      () =>
        `<script id="study-analysis" type="application/json">${escapeJsonScript(analysis)}</script>`,
    )
    .replace("</body>", () => `${renderExportAssets(assets)}</body>`)
    .replace(
      /<title>[^<]*<\/title>/,
      () => `<title>humanish Observer — ${escapeHtml(data.run.runId)}</title>`,
    );
}

/** Render current packaged UI around a validated/projected Observer snapshot. */
export function renderObserverHtml(
  data: ObserverData,
  options: {
    snapshot?: boolean;
    analysis?: LoadedAnalysis;
    assets?: ObserverExportAssets;
  } = {},
): string {
  let analysis = options.analysis ?? {
    state: "none",
    analysis: null,
    corrections: [],
    warnings: [],
  };
  // A portable snapshot cannot claim that a writer on another machine is still active.
  if (
    options.snapshot === true &&
    analysis.automatic &&
    ["queued", "running"].includes(analysis.automatic.state)
  ) {
    analysis = {
      ...analysis,
      automatic: {
        ...analysis.automatic,
        state: "unknown",
        reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN",
      },
    };
  }
  const sharing = analysisSharingProblems(analysis);
  if (data.publicSafety && (sharing.sensitive || sharing.unverified)) {
    const share = data.publicSafety.share;
    data = {
      ...data,
      publicSafety: {
        ...data.publicSafety,
        share: {
          status: sharing.sensitive || share?.status === "blocked" ? "blocked" : "local_only",
          verifiedAt: share?.verifiedAt ?? new Date().toISOString(),
          reasons: [...new Set([...(share?.reasons ?? []), "ANALYSIS_UNVERIFIED"])],
        },
      },
    };
  }
  return renderObserverAppHtml(
    withObserverEndings(data),
    options.snapshot === true,
    projectShareCheckedAnalysis(analysis),
    options.assets ?? {},
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
