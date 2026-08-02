import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { ServeTunnelError, startNgrokTunnel } from "../src/serve-tunnel.js";

// Field shape captured from a real ngrok 3.x `--log stdout --log-format json`
// session; the url value has been genericized.
const STARTED_TUNNEL_LINE =
  '{"addr":"http://localhost:8732","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-08-01T23:33:48.610569992Z","url":"https://observer.example.com"}';

class FakeStdout extends EventEmitter {
  encoding: string | undefined;

  setEncoding(encoding: string): this {
    this.encoding = encoding;
    return this;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStdout();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
      this.emit("exit", null, this.signalCode);
    }
    return true;
  }

  exitWithCode(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

interface SpawnHarness {
  calls: Array<{ command: string; args: string[] }>;
  children: FakeChildProcess[];
  spawnImpl: typeof spawn;
}

function createSpawnHarness(): SpawnHarness {
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: FakeChildProcess[] = [];
  const spawnImpl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new FakeChildProcess();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { calls, children, spawnImpl };
}

function onlyChild(harness: SpawnHarness): FakeChildProcess {
  const child = harness.children[0];
  if (!child) {
    throw new Error("spawnImpl was not called");
  }
  return child;
}

async function captureRejection(promise: Promise<unknown>): Promise<ServeTunnelError> {
  const outcome = await promise.then(
    () => {
      throw new Error("expected the tunnel promise to reject");
    },
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(ServeTunnelError);
  return outcome as ServeTunnelError;
}

describe("startNgrokTunnel", () => {
  // Spec item 30: started-tunnel line resolves the url; --url iff domain; close() kills.
  it("resolves the tunnel url from a started-tunnel log line and kills the child on close", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 1_000 });
    const child = onlyChild(harness);

    child.stdout.emit("data", `${STARTED_TUNNEL_LINE}\n`);

    const tunnel = await tunnelPromise;
    expect(tunnel.url).toBe("https://observer.example.com");
    expect(child.stdout.encoding).toBe("utf8");

    const call = harness.calls[0];
    expect(call?.command).toBe("ngrok");
    expect(call?.args).not.toContain("--url");
    expect(call?.args).toContain("8732");

    expect(child.killCalls).toHaveLength(0);
    await tunnel.close();
    expect(child.killCalls).toContain("SIGTERM");
  });

  it("passes --url <domain> to ngrok only when a domain is provided", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({
      domain: "observer.example.com",
      port: 8732,
      spawnImpl: harness.spawnImpl,
      timeoutMs: 1_000
    });
    onlyChild(harness).stdout.emit("data", `${STARTED_TUNNEL_LINE}\n`);
    await tunnelPromise;

    const args = harness.calls[0]?.args ?? [];
    const urlFlagIndex = args.indexOf("--url");
    expect(urlFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[urlFlagIndex + 1]).toBe("observer.example.com");
  });

  it("maps --oauth google plus each allow rule onto the ngrok edge OAuth flags", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({
      port: 8732,
      oauthProvider: "google",
      oauthAllowEmails: ["a@example.com", "b@example.com"],
      oauthAllowDomains: ["example.com"],
      spawnImpl: harness.spawnImpl,
      timeoutMs: 1_000
    });
    onlyChild(harness).stdout.emit("data", `${STARTED_TUNNEL_LINE}\n`);
    await tunnelPromise;

    const args = harness.calls[0]?.args ?? [];
    const oauthIndex = args.indexOf("--oauth");
    expect(oauthIndex).toBeGreaterThanOrEqual(0);
    expect(args[oauthIndex + 1]).toBe("google");
    // One flag emitted per repeated allow value, each preceding its value.
    expect(args.filter((arg) => arg === "--oauth-allow-email")).toHaveLength(2);
    expect(args.filter((arg) => arg === "--oauth-allow-domain")).toHaveLength(1);
    const emailIndexes = args.flatMap((arg, index) => (arg === "--oauth-allow-email" ? [index] : []));
    expect(emailIndexes.map((index) => args[index + 1])).toEqual(["a@example.com", "b@example.com"]);
    const domainIndex = args.indexOf("--oauth-allow-domain");
    expect(args[domainIndex + 1]).toBe("example.com");
    // The port is still the trailing positional arg.
    expect(args[args.length - 1]).toBe("8732");
  });

  it("emits --oauth google with no allow flags when no allow rules are provided", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({
      port: 8732,
      oauthProvider: "google",
      spawnImpl: harness.spawnImpl,
      timeoutMs: 1_000
    });
    onlyChild(harness).stdout.emit("data", `${STARTED_TUNNEL_LINE}\n`);
    await tunnelPromise;

    const args = harness.calls[0]?.args ?? [];
    expect(args).toContain("--oauth");
    expect(args).not.toContain("--oauth-allow-email");
    expect(args).not.toContain("--oauth-allow-domain");
  });

  it("emits no oauth flags when oauth is absent", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 1_000 });
    onlyChild(harness).stdout.emit("data", `${STARTED_TUNNEL_LINE}\n`);
    await tunnelPromise;

    const args = harness.calls[0]?.args ?? [];
    expect(args).not.toContain("--oauth");
    expect(args).not.toContain("--oauth-allow-email");
    expect(args).not.toContain("--oauth-allow-domain");
  });

  // Spec item 31: ENOENT spawn error maps to the not-found code with actionable guidance.
  it("rejects with HUMANISH_SERVE_TUNNEL_NOT_FOUND when the ngrok binary is missing", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 1_000 });

    const spawnError: NodeJS.ErrnoException = new Error("spawn ngrok ENOENT");
    spawnError.code = "ENOENT";
    onlyChild(harness).emit("error", spawnError);

    const error = await captureRejection(tunnelPromise);
    expect(error.code).toBe("HUMANISH_SERVE_TUNNEL_NOT_FOUND");
    expect(error.message).toContain("Install ngrok");
    expect(error.message).toContain("--public-url");
  });

  // Spec item 32: startup timeout maps to start-failed and reclaims the child.
  it("rejects with HUMANISH_SERVE_TUNNEL_START_FAILED and kills the child when no url arrives in time", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 50 });

    const error = await captureRejection(tunnelPromise);
    expect(error.code).toBe("HUMANISH_SERVE_TUNNEL_START_FAILED");
    expect(onlyChild(harness).killCalls).toContain("SIGTERM");
  });

  // Spec item 33: child exit before a url maps to start-failed.
  it("rejects with HUMANISH_SERVE_TUNNEL_START_FAILED when the child exits before reporting a url", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 1_000 });

    onlyChild(harness).exitWithCode(1);

    const error = await captureRejection(tunnelPromise);
    expect(error.code).toBe("HUMANISH_SERVE_TUNNEL_START_FAILED");
    expect(error.message).toContain("1");
  });

  // Spec item 34: log noise is skipped, and lines split across chunks reassemble.
  it("skips non-JSON and unrelated JSON lines before resolving on the started-tunnel line", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 1_000 });
    const child = onlyChild(harness);

    child.stdout.emit("data", "t=2026-08-01 lvl=info msg=plain-text-noise\n");
    child.stdout.emit("data", '{"lvl":"info","msg":"open config file","obj":"config"}\n');
    child.stdout.emit("data", `${STARTED_TUNNEL_LINE}\n`);

    const tunnel = await tunnelPromise;
    expect(tunnel.url).toBe("https://observer.example.com");
  });

  it("resolves when the started-tunnel line is split across two data chunks", async () => {
    const harness = createSpawnHarness();
    const tunnelPromise = startNgrokTunnel({ port: 8732, spawnImpl: harness.spawnImpl, timeoutMs: 1_000 });
    const child = onlyChild(harness);

    const splitAt = 40;
    child.stdout.emit("data", STARTED_TUNNEL_LINE.slice(0, splitAt));
    child.stdout.emit("data", `${STARTED_TUNNEL_LINE.slice(splitAt)}\n`);

    const tunnel = await tunnelPromise;
    expect(tunnel.url).toBe("https://observer.example.com");
  });
});
