// How the commands humanish suggests should invoke humanish, chosen from where the running copy is
// installed. A dev-dependency install puts no `humanish` on `PATH`, so a bare name there reaches a
// stale global install when one exists, or nothing. `npx humanish` with no version, run where no
// project declares humanish, also resolves a global install before it fetches one. A one-shot run
// therefore names its own version, so the next command runs the same CLI.

import { humanishInstall, type HumanishInstall } from "../substrates/e2b/peer-install.js";
import { CLI_VERSION } from "./version.js";

/** The prefix for a suggested command, by install. */
export function invocationFor(install: HumanishInstall, version: string): string {
  switch (install.kind) {
    case "project":
    case "other":
      return "npx humanish";
    case "one-shot":
      return `npx humanish@${version}`;
    // A global install is on `PATH`. A source checkout runs through a link or `pnpm humanish`, and
    // keeping the bare name there keeps test output the same on every machine.
    case "global":
    case "checkout":
      return "humanish";
  }
}

let cached: string | undefined;

/** How this process's suggested commands invoke humanish, read once per process. */
export function humanishCommand(): string {
  cached ??= invocationFor(humanishInstall(), CLI_VERSION);
  return cached;
}

/** A suggested command: `cli("review --run x")` is `npx humanish review --run x` in a project. */
export function cli(rest: string): string {
  return `${humanishCommand()} ${rest}`;
}
