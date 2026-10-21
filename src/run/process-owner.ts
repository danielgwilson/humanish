// Which process owns a file humanish leaves on disk, and whether that process is still running.
// `reclaim --preflight` reads it from a probe's journal and the analysis lock from its owner file,
// so both decide "the owner is gone" by one rule.

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";

/**
 * A process, as recorded by itself. A pid means nothing outside its host and pid namespace (a
 * process in a container writing to a bind-mounted checkout has a pid the host cannot see), so a
 * dead pid is trusted only when both match the reader's own.
 */
export interface ProcessOwner {
  hostname: string;
  /** `pid:[inode]` from /proc/self/ns/pid, where the platform has one. */
  pidNamespace?: string;
  pid: number;
  /** Start time in clock ticks since boot (/proc/<pid>/stat), which tells a reused pid apart. */
  startTicks?: string;
}

function ownerContext(): Pick<ProcessOwner, "hostname" | "pidNamespace"> {
  let pidNamespace: string | undefined;
  try {
    pidNamespace = readlinkSync("/proc/self/ns/pid");
  } catch {
    // No procfs: this platform has no pid namespaces to tell apart.
  }
  return { hostname: hostname(), ...(pidNamespace === undefined ? {} : { pidNamespace }) };
}

/** The process's start ticks; null when procfs says it is gone; undefined without procfs. */
function startTicks(pid: number): string | null | undefined {
  if (!existsSync("/proc/self/stat")) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22; the command name before it is parenthesized and may contain spaces.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** This process, as an owner record names it. */
export function currentProcessOwner(): ProcessOwner {
  const ticks = startTicks(process.pid);
  return {
    ...ownerContext(),
    pid: process.pid,
    ...(typeof ticks === "string" ? { startTicks: ticks } : {}),
  };
}

/** The owner fields of a parsed record, or undefined when `hostname` or `pid` is missing. */
export function processOwnerOf(value: Record<string, unknown>): ProcessOwner | undefined {
  if (typeof value.hostname !== "string" || typeof value.pid !== "number") return undefined;
  return {
    hostname: value.hostname,
    ...(typeof value.pidNamespace === "string" ? { pidNamespace: value.pidNamespace } : {}),
    pid: value.pid,
    ...(typeof value.startTicks === "string" ? { startTicks: value.startTicks } : {}),
  };
}

/**
 * Whether `owner` is gone: it ran in this host and pid namespace, and its pid is free or now
 * belongs to a process that started at another time. Otherwise the reason says why it may still
 * be running.
 */
export function processOwnerGone(
  owner: ProcessOwner,
): { gone: true } | { gone: false; reason: string } {
  const here = ownerContext();
  if (owner.hostname !== here.hostname || owner.pidNamespace !== here.pidNamespace)
    return {
      gone: false,
      reason: `it was opened on host ${owner.hostname} in another host or pid namespace, where this process cannot see whether it is still running`,
    };
  const running = `process ${owner.pid} is still running`;
  if (owner.pid === process.pid) return { gone: false, reason: running };
  const ticks = startTicks(owner.pid);
  if (ticks === null) return { gone: true };
  if (typeof ticks === "string") {
    // The pid now belongs to a different process: the owner is gone.
    return owner.startTicks !== undefined && ticks !== owner.startTicks
      ? { gone: true }
      : { gone: false, reason: running };
  }
  try {
    process.kill(owner.pid, 0);
    return { gone: false, reason: running };
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
      ? { gone: false, reason: running }
      : { gone: true };
  }
}
