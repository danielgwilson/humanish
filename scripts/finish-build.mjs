// Post-build placement of the two artifacts that are BUILT ELSEWHERE and shipped inside dist:
// the Observer's single-file app and the TUI bundle. Both are loaded at runtime by path, so a
// missing one is a broken command rather than a compile error — this script fails loudly instead.

import { chmodSync, copyFileSync, existsSync, statSync } from "node:fs";

const artifacts = [
  { from: "observer/dist/index.html", to: "dist/observer-app.html", label: "observer" },
  { from: "tui/dist/tui-app.js", to: "dist/tui-app.js", label: "tui" }
];

chmodSync("dist/cli.js", 0o755);

for (const artifact of artifacts) {
  if (!existsSync(artifact.from)) {
    throw new Error(
      `${artifact.label} build artifact missing at ${artifact.from} — the workspace build did not run or failed silently.`
    );
  }
  copyFileSync(artifact.from, artifact.to);
  const bytes = statSync(artifact.to).size;
  if (bytes === 0) {
    throw new Error(`${artifact.label} build artifact is empty at ${artifact.to}.`);
  }
  console.log(`${artifact.label}: ${(bytes / 1024).toFixed(0)}KB -> ${artifact.to}`);
}
