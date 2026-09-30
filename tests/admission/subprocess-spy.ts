// A node:child_process module whose process-starting functions count their calls. Used from a
// vi.mock factory, so an admission case can assert that a refusal started no process.

import { promisify } from "node:util";
import type * as ChildProcess from "node:child_process";

export function countedChildProcess(
  actual: typeof ChildProcess,
  counter: { calls: number },
): typeof ChildProcess {
  type Callable = ((...args: unknown[]) => unknown) & { [key: symbol]: unknown };
  const counted = <F>(fn: F): F => {
    const original = fn as unknown as Callable;
    const wrapped = ((...args: unknown[]) => {
      counter.calls += 1;
      return original(...args);
    }) as Callable;
    // execFile and exec resolve to { stdout, stderr } under promisify only through this symbol.
    const custom = original[promisify.custom];
    if (typeof custom === "function") {
      wrapped[promisify.custom] = (...args: unknown[]) => {
        counter.calls += 1;
        return (custom as (...values: unknown[]) => unknown)(...args);
      };
    }
    return wrapped as unknown as F;
  };
  return {
    ...actual,
    exec: counted(actual.exec),
    execFile: counted(actual.execFile),
    execFileSync: counted(actual.execFileSync),
    execSync: counted(actual.execSync),
    fork: counted(actual.fork),
    spawn: counted(actual.spawn),
    spawnSync: counted(actual.spawnSync),
  };
}
