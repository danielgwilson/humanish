// Where humanish keeps per-user files (the key store, telemetry state, the update-check cache) and
// how it reads an on/off environment variable. The key store, telemetry and the update check each
// had their own copy of both.

import { homedir } from "node:os";
import path from "node:path";

/**
 * `$XDG_CONFIG_HOME/humanish/<fileName>`, or `<home>/.config/humanish/<fileName>`. The XDG spec
 * says to ignore a relative XDG_CONFIG_HOME. Honoring one would put the file in whichever project
 * is open, and for the key store that writes a secret into the repo.
 */
export function humanishConfigFile(
  env: NodeJS.ProcessEnv,
  fileName: string,
  home = homedir(),
): string {
  const declared = env.XDG_CONFIG_HOME?.trim();
  const configHome =
    declared !== undefined && declared !== "" && path.isAbsolute(declared)
      ? declared
      : path.join(home, ".config");
  return path.join(configHome, "humanish", fileName);
}

/**
 * Whether a flag variable such as `CI` or `DO_NOT_TRACK` is on. Unset, blank, `0` and `false` (any
 * case, surrounding spaces ignored) are off, as is-in-ci reads `CI`; any other value is on.
 */
export function envFlag(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed !== "" && trimmed !== "0" && trimmed.toLowerCase() !== "false";
}
