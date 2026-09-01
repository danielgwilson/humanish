// One loopback bind for every humanish server, with the one failure people actually hit named.
//
// `listen EADDRINUSE` used to surface as HUMANISH_UNEXPECTED, the command-boundary catch-all for
// "a handler threw" (#484). Something already serving on the port is the most expected condition
// a serve command has: a second session, a forgotten background one, someone's dev server. It only
// bites with an explicit --port, which is exactly when a person is asking for a stable address.

import type { Server } from "node:http";

export type PortHolder = "humanish" | "other";

export class PortInUseError extends Error {
  constructor(readonly port: number, readonly holder: PortHolder) {
    super(
      holder === "humanish"
        ? `port ${port} is already served by another humanish process on this machine; stop it, or pass --port 0 for a free port`
        : `something else is already listening on 127.0.0.1:${port}; pass --port 0 for a free port, or stop it`
    );
    this.name = "PortInUseError";
  }
}

/**
 * Is the process on this port one of ours? humanish's serve and observer servers answer
 * `/_humanish/history.json` (serve) or `/observer-data.json` (observer) as JSON with a humanish
 * schema; anything else is somebody's app. Bounded to half a second and never throws: a probe
 * that cannot decide says "other", which is the answer that suggests the safer action.
 */
export async function probePortHolder(port: number, fetchFn: typeof fetch = fetch): Promise<PortHolder> {
  // The whole probe is raced against a hard clock as well: a fetch that ignores its abort signal
  // (a test double, a proxy) must not turn "tell me whose port this is" into a hang.
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<PortHolder>((resolve) => {
    hardTimer = setTimeout(() => resolve("other"), 1_500);
    hardTimer.unref?.();
  });
  try {
    return await Promise.race([probeRoutes(port, fetchFn), hardStop]);
  } finally {
    clearTimeout(hardTimer);
  }
}

async function probeRoutes(port: number, fetchFn: typeof fetch): Promise<PortHolder> {
  for (const route of ["/_humanish/history.json", "/observer-data.json"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetchFn(`http://127.0.0.1:${port}${route}`, { signal: controller.signal });
      if (!response.ok) continue;
      const body = (await response.json()) as { schema?: unknown };
      if (typeof body?.schema === "string" && body.schema.startsWith("humanish.")) return "humanish";
    } catch {
      // not ours, or not answering: keep probing, then say "other"
    } finally {
      clearTimeout(timer);
    }
  }
  return "other";
}

/** Bind on loopback only; resolve the port that was actually bound; name a taken port. */
export function listenOnLoopback(
  server: Server,
  port: number,
  probe: (port: number) => Promise<PortHolder> = probePortHolder
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        void probe(port).then((holder) => reject(new PortInUseError(port, holder)));
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    // Never beyond loopback; exposure only ever happens through a tunnel or proxy forwarding here.
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}
