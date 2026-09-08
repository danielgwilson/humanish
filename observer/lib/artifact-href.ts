import type { ObserverStream } from "./observer-data";

// Relative artifact hrefs resolve from observer/index.html, which sits one level under
// the run root — the same containment rule the legacy client applies: run-root-relative
// paths only; nothing absolute, no traversal, no URL schemes.
export function runArtifactHref(artifactPath: string): string | null {
  if (!safePath(artifactPath)) return null;
  return `../${artifactPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Validate before URL normalization can turn an encoded name into traversal.
 * Filenames remain filesystem names: encode once when constructing the URL. */
function safePath(value: string): boolean {
  if (!value || value.length > 8192) return false;
  try { encodeURIComponent(value); } catch { return false; }
  let checked = value;
  for (let n = 0; n < 5; n++) {
    if (/^[\\/]|[\\\\\u0000-\u001f\u007f]|^[a-z][a-z\d+.-]*:/i.test(checked)
      || checked.split("/").some((part) => part === "." || part === ".." || part === "")) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(checked); } catch { return !/%[0-9a-f]{2}/i.test(checked); }
    if (decoded === checked) return true;
    if (decoded.split("/").length !== checked.split("/").length) return false;
    checked = decoded;
  }
  return false;
}

/** Observer-generated links may step up exactly once, into this run's root.
 * Arbitrary schemes and history routes are not artifact links. */
export function observerArtifactHref(value: string): string | null {
  if (value.startsWith("../")) return runArtifactHref(value.slice(3));
  if (!safePath(value)) return null;
  return value.split("/").map(encodeURIComponent).join("/");
}

export function historyRunHref(runId: string): string | null {
  if (!runId || runId.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(runId) || runId === "." || runId === "..") return null;
  try { return `/_humanish/runs/${encodeURIComponent(runId)}/observer/index.html`; } catch { return null; }
}

/** Screenshot rendering additionally accepts the raster data URIs emitted by HTML
 * export. Keep this separate from artifact links: SVG, HTML and arbitrary schemes
 * must never become navigable content through the screenshot exception. */
export function screenshotHref(screenshotPath: string): string | null {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshotPath)) {
    return screenshotPath;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(screenshotPath)) return null;
  return runArtifactHref(screenshotPath);
}

/** A lane's recorded trace items: the finished actor's, else the mid-run `liveActor`
 *  partial's (#441 incremental flush) — one accessor so every reader grows live. */
export function traceItems(stream: ObserverStream): NonNullable<NonNullable<ObserverStream["actor"]>["items"]> {
  return stream.actor?.items ?? stream.liveActor?.items ?? [];
}

/** The lane's keyframe: its last recorded screenshot (the state the persona left behind). */
export function keyframeHref(stream: ObserverStream): string | null {
  const items = traceItems(stream);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const ref = items[i]?.screenshotRef;
    if (ref) {
      const href = screenshotHref(ref.path);
      if (href !== null) return href;
    }
  }
  return null;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
