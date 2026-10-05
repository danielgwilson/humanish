import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveRunsRoot } from "./paths.js";
import { cli } from "../cli/invocation.js";

/**
 * The message for a run that is not there: how to start one when the project has no runs, or how
 * to list them when it has. Only the runs directory's entry names are read.
 */
export async function runNotFoundMessage(cwdInput: string, runInput: string): Promise<string> {
  const cwd = path.resolve(cwdInput);
  const entries = await readdir(resolveRunsRoot(cwd)).catch(() => [] as string[]);
  const hasRun = entries.some((name) => !name.startsWith(".") && !name.endsWith(".json"));
  return hasRun
    ? `No run ${runInput}; ${cli("runs")} lists them.`
    : `No runs in ${cwd} yet; start one with ${cli("run first-run")}.`;
}
