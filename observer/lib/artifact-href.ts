import type { ObserverStream } from "./observer-data";

// Relative artifact hrefs resolve from observer/index.html, which sits one level under
// the run root — the same containment rule the legacy client applies: run-root-relative
// paths only; nothing absolute, no traversal, no URL schemes.
export function runArtifactHref(artifactPath: string): string | null {
  if (
    artifactPath === "" ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("..") ||
    artifactPath.includes("://") ||
    artifactPath.startsWith("data:")
  ) {
    return null;
  }
  return `../${artifactPath}`;
}

/** The lane's keyframe: its last recorded screenshot (the state the persona left behind). */
export function keyframeHref(stream: ObserverStream): string | null {
  const items = stream.actor?.items ?? [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const ref = items[i]?.screenshotRef;
    if (ref) return runArtifactHref(ref.path);
  }
  return null;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
