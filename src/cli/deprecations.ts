// A warning a command prints, such as a deprecated spelling or a study file 0.109 stops reading,
// goes to stderr when it happens and into the `warnings` array of the command's JSON result, so a
// caller that reads only stdout sees it too. writeResult adds the queued warnings.
import { Option, type Command } from "commander";

import type { CliIo } from "./io.js";

const queued = new WeakMap<Command, string[]>();

/** `<old> is deprecated and is removed in the next minor. Use <replacement>.` */
export function deprecationMessage(old: string, replacement: string): string {
  return `${old} is deprecated and is removed in the next minor. Use ${replacement}.`;
}

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

/**
 * The 0.107 spelling of `--study`, hidden for one minor. Commander refuses it together with
 * `--study`. Read the value with studyOptionValue.
 */
export function oldStudyOption(valueName: string): Option {
  return new Option(`--lab <${valueName}>`).hideHelp().conflicts("study");
}

/** The `--study` value, or the `--lab` value with its deprecation warning. */
export function studyOptionValue(
  command: Command,
  io: CliIo,
  options: { study?: string | undefined; lab?: string | undefined },
): string | undefined {
  if (options.lab === undefined) return options.study;
  const path = commandPath(command);
  warnAndQueue(
    command,
    io,
    deprecationMessage(`humanish ${path} --lab`, `humanish ${path} --study <study>`),
  );
  return options.lab;
}

/** The command's words after `humanish`, such as `comms check`. */
function commandPath(command: Command): string {
  const words: string[] = [];
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name());
  return words.join(" ");
}
