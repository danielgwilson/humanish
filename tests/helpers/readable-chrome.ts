import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CHROME_CDP_PROBE_PY,
  parseChromeCdpProbeOutput,
  type ChromeCdpProbeResult,
} from "../../src/substrates/e2b/cdp-probe.js";

const execFileAsync = promisify(execFile);

/** A headless Chrome whose launch page reads back through the in-sandbox probe. */
interface ReadableChrome {
  browser: ChildProcess;
  profileDir: string;
  cdpPort: number;
}

/** What a launch produced: the readable Chrome, or one line per failed attempt saying why. */
export interface ChromeLaunch {
  chrome?: ReadableChrome;
  failures: string[];
}

/** Signal a process group; a group that is already gone is not an error. */
function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // Esrch: nothing left in the group.
  }
}

/** True once no process is left in the group, false if one still is after `timeoutMs`. */
async function groupGone(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-group, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Stop Chrome's whole process group and remove its profile. Chrome's helpers outlive its main
 * process, and one still running can write into the profile dir after rm, so the group must be
 * empty first, and the dir is removed a second time in case a writer the wait missed recreated it.
 */
export async function stopChrome(
  browser: ChildProcess | undefined,
  profileDir: string,
): Promise<void> {
  const group = browser?.pid;
  if (group !== undefined) {
    signalGroup(group, "SIGTERM");
    if (!(await groupGone(group, 5_000))) {
      signalGroup(group, "SIGKILL");
      await groupGone(group, 3_000);
    }
  }
  if (!profileDir) return;
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** One probe run, killed at `timeoutMs`: a probe that cannot finish is reported, never awaited. */
async function probeState(
  cdpPort: number,
  pageUrl: string,
  timeoutMs: number,
): Promise<ChromeCdpProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-c",
        CHROME_CDP_PROBE_PY,
        JSON.stringify({ mode: "state", prefer: "active", cdpPort, targetUrl: pageUrl }),
      ],
      { timeout: Math.max(1, timeoutMs), killSignal: "SIGKILL" },
    );
    return parseChromeCdpProbeOutput(stdout);
  } catch (error) {
    // The error's message repeats the whole command line, which is the probe's source.
    const { killed, code } = error as { killed?: boolean; code?: unknown };
    return {
      unavailable: killed
        ? `the probe was killed after ${timeoutMs} ms`
        : `the probe exited with ${String(code)}`,
    };
  }
}

const describeState = (state: ChromeCdpProbeResult | undefined): string =>
  state === undefined
    ? "no probe ran"
    : `the last probe read url=${state.url ?? "none"}, text=${state.text === undefined ? "none" : "present"}` +
      (state.unavailable ? `, unavailable: ${state.unavailable}` : "");

/**
 * One launch: spawn Chrome on `pageUrl` and poll until the probe reads the page (url and text) or
 * `deadline` passes. On failure Chrome is stopped and its profile removed, and the reason names
 * the step that never completed, with the end of Chrome's stderr.
 */
async function launchOnce(
  chromePath: string,
  pageUrl: string,
  deadline: number,
): Promise<ReadableChrome | string> {
  const started = Date.now();
  const profileDir = await mkdtemp(path.join(tmpdir(), "humanish-cdp-chrome-"));
  // Detached, so Chrome leads its own process group: its zygote, GPU, network and renderer
  // helpers join that group and can be signalled and waited for at once.
  const browser = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      pageUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  // A worker that exits before afterAll must not leave a detached Chrome running.
  const group = browser.pid;
  if (group !== undefined) process.once("exit", () => signalGroup(group, "SIGKILL"));
  let stderr = "";
  browser.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
  });
  let exited: string | undefined;
  browser.once("exit", (code, signal) => {
    exited = `Chrome exited (code ${code}, signal ${signal})`;
  });
  const elapsed = () => `${Math.round((Date.now() - started) / 100) / 10} s`;
  const fail = async (step: string, detail = ""): Promise<string> => {
    const after = elapsed();
    await stopChrome(browser, profileDir);
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");
    return `${step} after ${after}${detail ? `; ${detail}` : ""}${tail ? `; Chrome stderr: ${tail}` : ""}`;
  };

  // Same seam the sandbox uses: the marker file appears once DevTools is listening.
  let cdpPort = 0;
  while (cdpPort === 0) {
    if (exited) return fail(`${exited} before writing DevToolsActivePort`);
    if (Date.now() >= deadline) return fail("no DevToolsActivePort");
    const marker = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8").catch(
      () => "",
    );
    const parsed = Number.parseInt(marker.split("\n")[0] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) cdpPort = parsed;
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Let the tab finish navigating so the "active" read is the page, not the launch blank.
  let last: ChromeCdpProbeResult | undefined;
  for (;;) {
    if (exited) return fail(`${exited} with DevTools on port ${cdpPort}`, describeState(last));
    // A probe needs up to about 3.5 s against a page that does not answer; one cut short by the
    // deadline would only report that it was cut short.
    const remaining = deadline - Date.now();
    if (remaining < 4_000)
      return fail(`the page on port ${cdpPort} never read back`, describeState(last));
    last = await probeState(cdpPort, pageUrl, Math.min(10_000, remaining));
    if (last.url === pageUrl && last.text !== undefined) return { browser, profileDir, cdpPort };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Launch headless Chrome on `pageUrl` and wait until the in-sandbox probe reads the page, within
 * `budgetMs` overall. A launch that is not readable by its share of the budget is stopped and
 * replaced once.
 *
 * A healthy launch reads back in about 1 s, and in under 4 s on two cores shared with six busy
 * loops. A launch whose renderer stops answering never reads back, and each state probe against it
 * waits out its 1.5 s socket timeout, so the wait is bounded by time, not by a count of probes.
 */
export async function launchReadableChrome(
  chromePath: string,
  pageUrl: string,
  budgetMs: number,
): Promise<ChromeLaunch> {
  const end = Date.now() + budgetMs;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const share = attempt === 1 ? Math.floor(budgetMs / 2) : end - Date.now();
    const result = await launchOnce(chromePath, pageUrl, Math.min(end, Date.now() + share));
    if (typeof result !== "string") return { chrome: result, failures };
    failures.push(`launch ${attempt}: ${result}`);
    if (Date.now() >= end) break;
  }
  return { failures };
}
