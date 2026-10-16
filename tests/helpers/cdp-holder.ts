import { spawn } from "node:child_process";
import {
  chromeCdpProbeCommand,
  type ChromeCdpProbeArgs,
} from "../../src/substrates/e2b/cdp-probe.js";

/** A running holder (`mode: "hold"`) and what it has printed so far. */
export interface SpawnedHolder {
  /** Every JSON line printed so far, the announce first. */
  lines(): string[];
  /** The announce line, or undefined when the holder exited or printed nothing within 20 s. */
  announce(): Promise<string | undefined>;
  /** The end of stderr, for a skip reason when the holder never came up. */
  stderrTail(): string;
  /** Resolves once the process has exited. */
  readonly exited: Promise<void>;
  kill(): void;
}

/**
 * Start the holder through `sh` with the exact command a sandbox runs, so the request fields
 * `chromeCdpProbeCommand` writes are the ones the script reads. `exec` makes python the process
 * the caller kills.
 */
export function spawnHolder(args: Omit<ChromeCdpProbeArgs, "mode">): SpawnedHolder {
  const child = spawn("sh", ["-c", `exec ${chromeCdpProbeCommand({ ...args, mode: "hold" })}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const lines = () => stdout.split("\n").filter((line) => line.startsWith("{"));
  return {
    lines,
    async announce() {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const first = lines()[0];
        if (first !== undefined) return first;
        if (child.exitCode !== null) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    },
    stderrTail: () => stderr.slice(-300),
    exited,
    kill: () => child.kill("SIGKILL"),
  };
}
