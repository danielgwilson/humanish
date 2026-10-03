import type { Command, Option } from "commander";
import { describe, expect, it } from "vitest";

import {
  CWD_OPTION_DESCRIPTION,
  DOTENV_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  PORT_OPTION_DESCRIPTION,
  RUN_OPTION_DESCRIPTION,
} from "../../src/cli/io.js";
import { createProgram } from "../../src/cli/program.js";

const SHARED = new Map([
  ["--cwd", CWD_OPTION_DESCRIPTION],
  ["--dotenv", DOTENV_OPTION_DESCRIPTION],
  ["--json", JSON_OPTION_DESCRIPTION],
  ["--port", PORT_OPTION_DESCRIPTION],
  ["--run", RUN_OPTION_DESCRIPTION],
]);

/** Options that share a flag but not its meaning, each with the reason. */
const OWN_TEXT = new Map([
  ["comms recover --run", "it matches an exact run id and does not resolve latest"],
]);

/** Every option below the root, named `<command path> <flag>`. The root's own --json is left out. */
function* optionsOf(command: Command, trail: string[] = []): Generator<[string, Option]> {
  for (const child of command.commands) {
    const path = [...trail, child.name()];
    for (const option of child.options) yield [`${path.join(" ")} ${option.long ?? ""}`, option];
    yield* optionsOf(child, path);
  }
}

describe("shared flags", () => {
  it("read the same on every command", () => {
    const drifted: string[] = [];
    let checked = 0;
    for (const [name, option] of optionsOf(createProgram())) {
      const shared = SHARED.get(option.long ?? "");
      // A hidden option is a deprecated alias whose text names its replacement.
      if (shared === undefined || option.hidden || OWN_TEXT.has(name)) continue;
      checked += 1;
      if (option.description !== shared) drifted.push(`${name}: ${option.description}`);
    }

    expect(drifted).toEqual([]);
    // A walk that found nothing would pass vacuously.
    expect(checked).toBeGreaterThan(90);
  });
});
