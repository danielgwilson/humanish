// Find a Chromium binary on the host for the scripted browser: HUMANISH_BROWSER_COMMAND first, then
// the macOS Chrome path, then google-chrome, chromium and chromium-browser on PATH. A candidate
// counts only if `--version` runs.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveBrowserCommand(): Promise<string | null> {
  const candidates = [
    await resolveBrowserCandidate(process.env.HUMANISH_BROWSER_COMMAND),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    await resolveExecutableFromPath("google-chrome"),
    await resolveExecutableFromPath("chromium"),
    await resolveExecutableFromPath("chromium-browser"),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      });
      return candidate;
    } catch {}
  }

  return null;
}

async function resolveBrowserCandidate(value: string | undefined): Promise<string | null> {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }

  return path.isAbsolute(candidate) ? candidate : resolveExecutableFromPath(candidate);
}

async function resolveExecutableFromPath(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const resolved = stdout.trim().split(/\r?\n/)[0]?.trim();
    return resolved ? resolved : null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}
