import { availableParallelism, totalmem } from "node:os";
import { cli } from "../../cli/invocation.js";
import { plural } from "../../run/text.js";

const GiB = 1024 ** 3;

/**
 * What one participant desktop container may use: Docker's `--memory` and `--memory-swap` limit
 * and its `--cpus` quota. The Firecracker guest inside it has 2 GiB and 2 vCPUs; the rest is room
 * for Firecracker and its jailer.
 */
export const DESKTOP_RESERVATION = { memoryGiB: 3, cpus: 2 } as const;

/** Memory the runtime host keeps for its own Linux, Docker daemon and SSH before any desktop. */
const HOST_RESERVED_MEMORY_GIB = 1;

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
  /**
   * More desktops fit by memory than by CPUs at 2 each, so busy desktops share CPU time and run
   * slower. A CPU quota throttles; it does not kill, so CPUs never lower `desktops`.
   */
  readonly sharesCpus?: true;
  /** No humanish Lima VM exists yet: the size is the one setup would create. */
  readonly planned?: true;
  /** The Mac's own memory and CPUs, which a Lima VM cannot exceed. */
  readonly machine?: { readonly memoryGiB: number; readonly cpus: number };
}

/**
 * Desktops that fit in a host of this size, after the host's own memory. Memory decides: a desktop
 * past it is killed, while one past the CPUs only runs slower.
 */
export function localCapacity(
  host: LocalCapacity["host"],
  size: MachineSize,
  more: { planned?: boolean; machine?: MachineSize } = {},
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
    desktops: Math.max(0, byMemory),
    ...(byMemory > byCpus ? { sharesCpus: true as const } : {}),
    ...(more.planned ? { planned: true as const } : {}),
    ...(more.machine === undefined
      ? {}
      : {
          machine: {
            memoryGiB: Math.floor(more.machine.memoryBytes / GiB),
            cpus: more.machine.cpus,
          },
        }),
  };
}

/** The memory and CPUs a VM needs to hold `desktops` desktops. */
function vmSizeFor(desktops: number): VmSize {
  return {
    memoryGiB: HOST_RESERVED_MEMORY_GIB + desktops * DESKTOP_RESERVATION.memoryGiB,
    cpus: desktops * DESKTOP_RESERVATION.cpus,
  };
}

/** This machine's memory and CPUs, or the size a test passes in. */
export function machineSize(machine?: MachineSize): MachineSize {
  return machine ?? { memoryBytes: totalmem(), cpus: availableParallelism() };
}

/** The humanish Lima VM as `limactl list` shows it: whether it exists, and its size when listed. */
interface LimaVmListing {
  readonly exists: boolean;
  readonly size?: MachineSize;
}

/**
 * The humanish Lima VM's memory and CPUs: the size Lima lists for it, or for a VM that does not
 * exist yet, the size setup creates (room for four desktops, capped at half the Mac's memory and
 * CPUs). Undefined for an existing VM that lists no size: Lima omits the memory it cannot parse,
 * and a default in its place would be a guess.
 */
export function limaVmSize(vm: LimaVmListing, mac: MachineSize): VmSize | undefined {
  if (vm.size !== undefined) return { memoryGiB: vm.size.memoryBytes / GiB, cpus: vm.size.cpus };
  if (vm.exists) return undefined;
  const wanted = vmSizeFor(DEFAULT_VM_DESKTOPS);
  return {
    memoryGiB: Math.min(wanted.memoryGiB, Math.floor(mac.memoryBytes / GiB / 2)),
    cpus: Math.min(wanted.cpus, Math.floor(mac.cpus / 2)),
  };
}

/**
 * Desktops the humanish Lima VM holds, or will hold once setup creates it. Undefined when its size
 * is unknown.
 */
export function limaCapacity(vm: LimaVmListing, mac: MachineSize): LocalCapacity | undefined {
  const size = limaVmSize(vm, mac);
  if (size === undefined) return undefined;
  return localCapacity(
    "lima-vm",
    { memoryBytes: size.memoryGiB * GiB, cpus: size.cpus },
    { planned: !vm.exists, machine: mac },
  );
}

/**
 * Why a VM size the user asked for cannot work, or undefined: it must hold at least one desktop
 * and fit within the Mac.
 */
export function vmSizeProblem(size: VmSize, mac: MachineSize): string | undefined {
  const one = vmSizeFor(1);
  const macGiB = Math.floor(mac.memoryBytes / GiB);
  if (size.memoryGiB < one.memoryGiB || size.cpus < one.cpus)
    return `One participant desktop needs a VM with at least ${one.memoryGiB} GiB and ${one.cpus} CPUs: ${DESKTOP_RESERVATION.memoryGiB} GiB and ${DESKTOP_RESERVATION.cpus} CPUs for the desktop and ${HOST_RESERVED_MEMORY_GIB} GiB for the VM itself.`;
  if (size.memoryGiB > macGiB)
    return `--memory ${size.memoryGiB} is more than the ${macGiB} GiB this Mac has. Choose ${macGiB} or less; about half leaves room for macOS and your app.`;
  if (size.cpus > mac.cpus)
    return `--cpus ${size.cpus} is more than the ${mac.cpus} CPUs this Mac has. Choose ${mac.cpus} or fewer.`;
  return undefined;
}

/** "2 desktops fit", "1 desktop fits". */
function desktopsFit(count: number, future = false): string {
  return `${plural(count, "desktop")} ${future ? "will fit" : count === 1 ? "fits" : "fit"}`;
}

/** The capacity in a sentence or two: the host's size, what each desktop takes and how many fit. */
export function describeCapacity(capacity: LocalCapacity): string {
  const each = `each participant desktop reserves ${capacity.perDesktop.memoryGiB} GiB`;
  const cpus = capacity.sharesCpus
    ? ` The desktops share ${capacity.cpus} CPUs, so they run slower when all of them are busy.`
    : "";
  const size = `${capacity.memoryGiB} GiB and ${capacity.cpus} CPUs`;
  if (capacity.host === "linux-host")
    return `This machine has ${size}. After ${capacity.reservedMemoryGiB} GiB for the system, ${each}, so ${desktopsFit(capacity.desktops)} at once.${cpus}`;
  const vm = capacity.planned
    ? `Setup will create the humanish Lima VM with ${size}.`
    : `The humanish Lima VM has ${size}.`;
  return `${vm} It keeps ${capacity.reservedMemoryGiB} GiB for itself and ${each}, so ${desktopsFit(capacity.desktops, capacity.planned)} at once.${cpus} To change its size, run ${cli("runtime setup --memory <GiB> --cpus <n>")}.`;
}

/**
 * What a local study that runs `needed` desktops at once is told: a refusal on a Mac, whose Lima
 * VM has a fixed size, or a warning on Linux, where free memory varies. Undefined when they fit.
 */
export function capacityShortfall(
  capacity: LocalCapacity,
  needed: number,
): { refusal: string } | { warning: string } | undefined {
  const fits = capacity.desktops;
  if (needed <= fits) return undefined;
  const host =
    capacity.host === "linux-host"
      ? "this machine"
      : capacity.planned
        ? "the humanish Lima VM that setup creates"
        : "the humanish Lima VM";
  const holds = `${host} holds ${fits}: it has ${capacity.memoryGiB} GiB, keeps ${capacity.reservedMemoryGiB} GiB for ${capacity.host === "lima-vm" ? "itself" : "the system"}, and each desktop reserves ${capacity.perDesktop.memoryGiB} GiB.`;
  const runs = `This study runs ${plural(needed, "participant desktop")} at once, and ${holds}`;
  const cloud = [
    "Run it on cloud desktops, which have no local memory limit. In the study file, set these two fields, add `subject.serve` with the command that starts your app, and provide E2B_API_KEY:",
    "     subject.source: local-tree",
    "     execution.target: e2b-desktop",
  ];
  const fewer =
    fits === 0
      ? []
      : [
          `Run fewer at once: set \`execution.concurrency: ${fits}\` to run them ${fits} at a time, or lower \`participants\` to ${fits}.`,
        ];
  if (capacity.host === "linux-host")
    return {
      warning: `${runs} The run starts anyway because free memory on Linux varies, but a desktop that runs out of memory is killed and its participant fails. To avoid that, run it on cloud desktops (\`subject.source: local-tree\` and \`execution.target: e2b-desktop\`, with a \`subject.serve\` command)${fits === 0 ? "" : `, or set \`execution.concurrency: ${fits}\``}.`,
    };
  const memoryGiB = Math.max(vmSizeFor(needed).memoryGiB, Math.ceil(capacity.memoryGiB));
  const machine = capacity.machine;
  const bigger =
    machine !== undefined && memoryGiB > machine.memoryGiB
      ? `This Mac has ${machine.memoryGiB} GiB, too little for a VM that holds ${needed} desktops.`
      : `Give the VM room for ${needed} desktops: ${cli(`runtime setup --memory ${memoryGiB}`)}`;
  const steps = [cloud.join("\n"), bigger, ...fewer];
  return {
    refusal: [
      `${runs} More desktops than that run the VM out of memory and their browsers crash, so nothing was started.`,
      "To run this study, do one of these:",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
    ].join("\n"),
  };
}

/** What a participant whose desktop Docker killed for memory is told, with what to change. */
export function outOfMemoryMessage(host: LocalCapacity["host"]): string {
  const shared =
    host === "lima-vm"
      ? `all desktops share the humanish Lima VM's memory. Run fewer participants at once with \`execution.concurrency\`, give the VM more memory with ${cli("runtime setup --memory <GiB>")}, or run on cloud desktops (\`subject.source: local-tree\` with \`execution.target: e2b-desktop\`).`
      : `all desktops share this machine's memory. Run fewer participants at once with \`execution.concurrency\`, close other memory-heavy programs, or run on cloud desktops (\`subject.source: local-tree\` with \`execution.target: e2b-desktop\`).`;
  return `The participant's desktop ran out of memory: Docker killed its container (OOMKilled), so its browser closed mid-session. Each desktop may use ${DESKTOP_RESERVATION.memoryGiB} GiB, and ${shared}`;
}
