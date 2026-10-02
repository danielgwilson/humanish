// Options renamed in this minor keep their older name for one more minor, so a skill installed
// before the rename still runs. The older name is hidden from --help, sets the same value and
// prints one stderr line naming the new name. Each command reads its options through these
// functions once, at the top of its action, so one invocation prints the line once.

import type { CliIo } from "./io.js";

function renamedOption(
  io: CliIo,
  name: string,
  value: string | undefined,
  olderName: string,
  olderValue: string | undefined,
): string | undefined {
  if (olderValue !== undefined) {
    io.writeErr(
      `warning: --${olderName} is deprecated and is removed in the next minor. Use --${name}.\n`,
    );
  }
  return value ?? olderValue;
}

/** `--count`, or `--sims` when only the older spelling is set. */
export function countOption(
  io: CliIo,
  options: { count?: string | undefined; sims?: string | undefined },
): string | undefined {
  return renamedOption(io, "count", options.count, "sims", options.sims);
}
