import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type ServeTunnelErrorCode =
  | "HUMANISH_SERVE_TUNNEL_NOT_FOUND"
  | "HUMANISH_SERVE_TUNNEL_START_FAILED";

export class ServeTunnelError extends Error {
  readonly code: ServeTunnelErrorCode;

  constructor(code: ServeTunnelErrorCode, message: string) {
    super(message);
    this.name = "ServeTunnelError";
    this.code = code;
  }
}

export interface ServeTunnel {
  url: string;
  close(): Promise<void>;
}

export interface StartNgrokTunnelOptions {
  port: number;
  domain?: string;
  // Edge OAuth: ngrok authenticates the viewer at its edge before any request reaches the loopback
  // port. On ngrok 3.39.x these flags are ACCEPTED and functional but reported deprecated (an info
  // line, not an error) — the JSON stdout parser skips every line except "started tunnel", so the
  // deprecation notice is ignored automatically. A future ngrok major may require a Traffic Policy
  // instead; that is a documented fast-follow, not part of 0.18.0.
  oauthProvider?: "google";
  oauthAllowEmails?: string[];
  oauthAllowDomains?: string[];
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

export async function startNgrokTunnel(options: StartNgrokTunnelOptions): Promise<ServeTunnel> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const oauthArgs = options.oauthProvider
    ? [
        "--oauth",
        options.oauthProvider,
        ...(options.oauthAllowEmails ?? []).flatMap((email) => ["--oauth-allow-email", email]),
        ...(options.oauthAllowDomains ?? []).flatMap((domain) => ["--oauth-allow-domain", domain])
      ]
    : [];
  const args = [
    "http",
    "--log",
    "stdout",
    "--log-format",
    "json",
    ...(options.domain ? ["--url", options.domain] : []),
    ...oauthArgs,
    String(options.port)
  ];

  const child = spawnImpl("ngrok", args, { stdio: ["ignore", "pipe", "ignore"] });

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let buffered = "";

    const settle = (outcome: { url: string } | { error: ServeTunnelError }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if ("url" in outcome) {
        resolve(outcome.url);
      } else {
        killChild(child);
        reject(outcome.error);
      }
    };

    const timer = setTimeout(() => {
      settle({
        error: new ServeTunnelError(
          "HUMANISH_SERVE_TUNNEL_START_FAILED",
          `ngrok did not report a started tunnel within ${timeoutMs}ms.`
        )
      });
    }, timeoutMs);

    child.once("error", (error: NodeJS.ErrnoException) => {
      settle({
        error: error.code === "ENOENT"
          ? new ServeTunnelError(
            "HUMANISH_SERVE_TUNNEL_NOT_FOUND",
            "ngrok binary not found on PATH. Install ngrok, or run your own tunnel and pass --public-url <origin>."
          )
          : new ServeTunnelError(
            "HUMANISH_SERVE_TUNNEL_START_FAILED",
            `ngrok failed to start: ${error.message}`
          )
      });
    });

    child.once("exit", (code) => {
      settle({
        error: new ServeTunnelError(
          "HUMANISH_SERVE_TUNNEL_START_FAILED",
          `ngrok exited (${code ?? "signal"}) before reporting a started tunnel.`
        )
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof parsed === "object"
          && parsed !== null
          && (parsed as { msg?: unknown }).msg === "started tunnel"
          && typeof (parsed as { url?: unknown }).url === "string"
        ) {
          settle({ url: (parsed as { url: string }).url });
          return;
        }
      }
    });
  });

  return {
    url,
    close: async () => {
      await killChild(child);
    }
  };
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    // Reclamation stays scoped to the exact child this call created.
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000).unref();
  });
}
