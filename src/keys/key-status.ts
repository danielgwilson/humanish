// `humanish keys`: which provider keys are set and where each comes from, through the same chain a
// live command resolves. Never a value.

import { cli } from "../cli/invocation.js";
import {
  listUserKeys,
  probeKeySources,
  setUserKey,
  type KeyResolutionDeps,
  type KeySourceProbe,
} from "./key-resolution.js";

/**
 * The keys a person sets for humanish, in the order the status lists them and `keys set` asks for
 * them. ANTHROPIC_API_KEY is left out: a Claude Code participant runs on its own login and never
 * receives it. CODEX_API_KEY is an alternative spelling of the OpenAI key for terminal studies.
 */
const STATUS_KEYS = [
  { name: "E2B_API_KEY", use: "hosted desktops" },
  { name: "OPENAI_API_KEY", use: "participant model and analysis" },
  { name: "GH_TOKEN", use: "private repository subjects" },
  { name: "AGENTMAIL_API_KEY", use: "email in studies" },
] as const;

interface KeyStatusRow extends KeySourceProbe {
  /** What humanish uses the key for, in a few words. */
  use: string;
}

export async function keyStatus(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  deps?: KeyResolutionDeps;
}): Promise<KeyStatusRow[]> {
  const probes = await probeKeySources(
    STATUS_KEYS.map((key) => key.name),
    {
      cwd: args.cwd,
      env: args.env,
      ...(args.deps === undefined ? {} : { deps: args.deps }),
    },
  );
  return probes.map((probe, index) => ({ ...probe, use: STATUS_KEYS[index]!.use }));
}

/** Names in the user store that the status does not list, such as ANTHROPIC_API_KEY. */
export function otherStoredKeys(env: NodeJS.ProcessEnv, deps: KeyResolutionDeps = {}): string[] {
  const listed = new Set<string>(STATUS_KEYS.map((key) => key.name));
  return listUserKeys(env, deps).filter((name) => !listed.has(name));
}

export function formatKeyStatus(
  rows: readonly KeyStatusRow[],
  otherStored: readonly string[] = [],
): string {
  const lines = rows.map(
    (row) =>
      `${row.name} (${row.use}): ${row.source === null ? `missing; ${row.hint}` : `set, from ${row.source}`}`,
  );
  if (otherStored.length > 0)
    lines.push(
      `Also in the user store: ${otherStored.join(", ")}. humanish does not use ${otherStored.length === 1 ? "it" : "them"} today.`,
    );
  const missing = rows.some((row) => row.source === null);
  lines.push(
    "",
    missing
      ? `Values are never printed. \`${cli("keys set")}\` asks for each missing key in turn.`
      : "Values are never printed.",
  );
  return `${lines.join("\n")}\n`;
}

interface MissingKeysOutcome {
  stored: string[];
  /** Keys left unset because the person pressed Enter without a value. */
  skipped: string[];
  /** Keys whose value the store refused, with the reason. */
  rejected?: Array<{ name: string; message: string }>;
  /** The key whose prompt was cancelled. No later key was asked for. */
  stoppedAt?: string;
}

/**
 * `humanish keys set` with no key named: ask for each missing key in turn and store each answer in
 * the user store. An empty answer skips that key; a cancelled prompt (null) stops the walk and
 * keeps what was already stored.
 */
export async function askForMissingKeys(args: {
  rows: readonly KeyStatusRow[];
  env: NodeJS.ProcessEnv;
  deps?: KeyResolutionDeps;
  prompt: (label: string) => Promise<string | null>;
}): Promise<MissingKeysOutcome> {
  const outcome: MissingKeysOutcome = { stored: [], skipped: [] };
  for (const row of args.rows) {
    if (row.source !== null) continue;
    const value = await args.prompt(`${row.name} for ${row.use}`);
    if (value === null) return { ...outcome, stoppedAt: row.name };
    if (value === "") {
      outcome.skipped.push(row.name);
      continue;
    }
    try {
      setUserKey(row.name, value, args.env, args.deps);
      outcome.stored.push(row.name);
    } catch (error) {
      (outcome.rejected ??= []).push({
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}
