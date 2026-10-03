// A warning a command prints, such as a study file's, goes to stderr when it happens and into the
// `warnings` array of the command's JSON result, so a caller that reads only stdout sees it too.
// writeResult adds the queued warnings.
import type { Command } from "commander";

import type { CliIo } from "./io.js";

const queued = new WeakMap<Command, string[]>();

/** Print `warning: <message>` on stderr, and queue the message for the command's JSON result. */
export function warnAndQueue(command: Command, io: CliIo, message: string): void {
  io.writeErr(`warning: ${message}\n`);
  queued.set(command, [...(queued.get(command) ?? []), message]);
}

/** `output` with the command's queued warnings at the front of its `warnings`. */
export function withQueuedWarnings<T>(command: Command, output: T): T {
  const messages = queued.get(command);
  if (messages === undefined || output === null || typeof output !== "object") return output;
  if (Array.isArray(output)) return output;
  const existing: unknown = (output as { warnings?: unknown }).warnings;
  if (existing !== undefined && !Array.isArray(existing)) return output;
  return { ...output, warnings: [...messages, ...(existing ?? [])] } as T;
}
