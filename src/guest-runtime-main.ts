import { writeSync } from "node:fs";
import { Duplex } from "node:stream";
import { runGuestRuntime } from "./guest-runtime.js";
import { createGuestRuntimeDesktop } from "./guest-runtime-desktop.js";
import { GUEST_RUNTIME_REVISION } from "./guest-runtime-revision.js";

// Fixed packaged command only. Stdout is reserved for framed protocol bytes.
const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
process.on("SIGINT", () => stop.abort());
const transport = Duplex.from({ readable: process.stdin, writable: process.stdout });
transport.on("error", () => stop.abort());
try {
  if (!/^guest-api1-[a-f0-9]{64}$/.test(GUEST_RUNTIME_REVISION)) throw new Error();
  const markerFd = process.env.HUMANISH_GUEST_SUPERVISION_FD;
  if (!markerFd || !/^[1-9][0-9]{0,3}$/.test(markerFd) || Number(markerFd) < 3 || Number(markerFd) > 4095) throw new Error();
  const runtime = await runGuestRuntime({ transport, revision: GUEST_RUNTIME_REVISION, signal: stop.signal,
    marker: value => { if (writeSync(Number(markerFd), value) !== 1) throw new Error(); },
    createDesktop: (signal, onTerminal, initialUrl) => createGuestRuntimeDesktop({ signal, onTerminal,
      ...(initialUrl === undefined ? {} : { initialUrl }) }) });
  const result = await runtime.closed;
  process.exit(result.complete ? 0 : 1);
} catch {
  stop.abort(); transport.destroy();
  process.stderr.write("humanish_guest_failed\n");
  process.exitCode = 1;
}
