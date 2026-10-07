// `humanish keys`: which provider keys are set and where each comes from, through the same chain a
// live command resolves. Never a value.

import { cli } from "../cli/invocation.js";
import { probeKeySources, type KeyResolutionDeps, type KeySourceProbe } from "./key-resolution.js";

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

export function formatKeyStatus(rows: readonly KeyStatusRow[]): string {
  const lines = rows.map(
    (row) =>
      `${row.name} (${row.use}): ${row.source === null ? `missing; ${row.hint}` : `set, from ${row.source}`}`,
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
