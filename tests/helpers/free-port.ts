import { createServer } from "node:net";

// Ports for tests that spawn a real server and hand it a port on the command line.
//
// WHY: `8700 + Math.floor(Math.random() * 200)` appeared in two different test FILES, so two
// vitest workers could hand the same port to two python servers; the loser fails to bind, exits,
// and its test waits out a health loop that will never succeed. That is the intermittent
// `comms-catch-host` failure — it passes alone and fails about one full-suite run in two.
//
// Asking the OS is the only way to know a port is free. A window still exists between closing the
// probe socket and the child binding it, which is why `withFreePort` retries rather than trusting
// one attempt: a race you cannot close, you retry.

/** Ask the OS for a port nobody is using, then release it. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not read an ephemeral port from the OS")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Run `attempt` with a free port, retrying on a fresh one if it reports failure. `attempt` returns
 * false when the server never came up — the caller decides what "came up" means, because only it
 * knows what it spawned. Throws with the attempt count when every try fails, so a genuine breakage
 * does not read as a flake.
 */
export async function withFreePort(
  attempt: (port: number) => Promise<boolean>,
  tries = 3
): Promise<number> {
  let lastPort = 0;
  for (let index = 0; index < tries; index += 1) {
    lastPort = await freePort();
    if (await attempt(lastPort)) return lastPort;
  }
  throw new Error(`server did not come up on any of ${tries} free ports (last ${lastPort})`);
}
