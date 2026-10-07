import { availableParallelism, totalmem } from "node:os";

const GiB = 1024 ** 3;

/**
 * What one participant desktop container may use: Docker's `--memory` and `--memory-swap` limit
 * and its `--cpus` quota. The Firecracker guest inside it has 2 GiB and 2 vCPUs; the rest is room
 * for Firecracker and its jailer.
 */
export const DESKTOP_RESERVATION = { memoryGiB: 3, cpus: 2 } as const;

/** Memory the runtime host keeps for its own Linux, Docker daemon and SSH before any desktop. */
export const HOST_RESERVED_MEMORY_GIB = 1;

/** The VM setup creates holds this many desktops, unless half the Mac is smaller. */
const DEFAULT_VM_DESKTOPS = 4;

/** A machine's or a VM's total memory and CPU count. */
export interface MachineSize {
  readonly memoryBytes: number;
  readonly cpus: number;
}

/** A Lima VM size as `limactl` takes it: whole GiB and CPUs. */
export interface VmSize {
  readonly memoryGiB: number;
  readonly cpus: number;
}

/** How many participant desktops the local runtime holds at once, and why. */
export interface LocalCapacity {
  /** The humanish Lima VM on a Mac, or this Linux machine, which runs desktops directly. */
  readonly host: "lima-vm" | "linux-host";
  /** The VM's or the machine's memory, rounded down to a tenth of a GiB, and CPUs. */
  readonly memoryGiB: number;
  readonly cpus: number;
  readonly reservedMemoryGiB: number;
  readonly perDesktop: { readonly memoryGiB: number; readonly cpus: number };
  readonly desktops: number;
  /** No humanish Lima VM exists yet: the size is the one setup would create. */
  readonly planned?: true;
}

/** Desktops that fit in a host of this size, after the host's own memory, by memory and by CPUs. */
export function localCapacity(
  host: LocalCapacity["host"],
  size: MachineSize,
  planned = false,
): LocalCapacity {
  const memoryGiB = size.memoryBytes / GiB;
  const byMemory = Math.floor(
    (memoryGiB - HOST_RESERVED_MEMORY_GIB) / DESKTOP_RESERVATION.memoryGiB,
  );
  const byCpus = Math.floor(size.cpus / DESKTOP_RESERVATION.cpus);
  return {
    host,
    memoryGiB: Math.floor(memoryGiB * 10) / 10,
    cpus: size.cpus,
    reservedMemoryGiB: HOST_RESERVED_MEMORY_GIB,
    perDesktop: { ...DESKTOP_RESERVATION },
    desktops: Math.max(0, Math.min(byMemory, byCpus)),
    ...(planned ? { planned: true as const } : {}),
  };
}

/** The memory and CPUs a VM needs to hold `desktops` desktops. */
export function vmSizeFor(desktops: number): VmSize {
  return {
    memoryGiB: HOST_RESERVED_MEMORY_GIB + desktops * DESKTOP_RESERVATION.memoryGiB,
    cpus: desktops * DESKTOP_RESERVATION.cpus,
  };
}

/** This machine's memory and CPUs, or the size a test passes in. */
export function machineSize(machine?: MachineSize): MachineSize {
  return machine ?? { memoryBytes: totalmem(), cpus: availableParallelism() };
}

/** A new VM's size: room for four desktops, capped at half the Mac's memory and CPUs. */
export function defaultVmSize(mac: MachineSize): VmSize {
  const wanted = vmSizeFor(DEFAULT_VM_DESKTOPS);
  return {
    memoryGiB: Math.min(wanted.memoryGiB, Math.floor(mac.memoryBytes / GiB / 2)),
    cpus: Math.min(wanted.cpus, Math.floor(mac.cpus / 2)),
  };
}
