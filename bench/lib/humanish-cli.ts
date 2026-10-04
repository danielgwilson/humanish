// Runs the humanish CLI as a child process and reads its `--json` output. The benchmark never
// reads a key itself: live commands get `--dotenv <path>`, or Node's `--env-file` where the command
// has no such flag, and neither prints a value.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface CliResult {
  code: number | null;
  json: Record<string, unknown> | null;
  timedOut: boolean;
}

let active: ChildProcess | null = null;

/** Forward an interrupt to the running CLI, which records the run as interrupted. */
export function interruptActive(): void {
  active?.kill("SIGINT");
}

export function runCli(
  cliPath: string,
  args: readonly string[],
  options: { logFile: string; timeoutMs: number; nodeArgs?: readonly string[] },
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), cliPath, ...args], {
      env: { ...process.env, DO_NOT_TRACK: "1", HUMANISH_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => appendFileSync(options.logFile, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
    }, options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      active = null;
      appendFileSync(options.logFile, `\n[bench] exit ${code ?? "signal"} for: ${args[0] ?? ""}\n`);
      resolve({ code, json: parseJson(stdout), timedOut });
    });
  });
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

export function objectField(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const field = value?.[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}

export function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}
