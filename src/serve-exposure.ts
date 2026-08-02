// Shared fail-closed exposure validation + tunnel orchestration for BOTH `serve` (a library of
// finished runs) and `watch` (one live run). Exposure auth is TUNNEL-EDGE only: humanish carries no
// in-process auth. Exposure is admitted only behind edge auth (ngrok --oauth google, or an operator
// --public-url they secure) OR, for serve, behind --safe (share_ready runs only). A live watch run
// is never share_ready (raw, unverified screenshots), so watch --expose ALWAYS requires edge auth.
//
// This module is pure with respect to the fail-closed matrix (validateExposure) and thin over the
// tunnel launcher (startExposedObserver), so the CLI just maps flags in and results out.

import { parsePublicOrigin, type ServeMode } from "./serve-http.js";
import { startNgrokTunnel, type ServeTunnel, type StartNgrokTunnelOptions } from "./serve-tunnel.js";

export type ExposureSurface = "serve" | "watch";

export type ExposureErrorCode =
  | "HUMANISH_SERVE_ALLOW_REQUIRES_OAUTH"
  | "HUMANISH_SERVE_OAUTH_REQUIRES_TUNNEL"
  | "HUMANISH_SERVE_OPTION_CONFLICT"
  | "HUMANISH_SERVE_TUNNEL_REQUIRES_EXPOSE"
  | "HUMANISH_SERVE_EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE"
  | "HUMANISH_WATCH_ALLOW_REQUIRES_OAUTH"
  | "HUMANISH_WATCH_OAUTH_REQUIRES_TUNNEL"
  | "HUMANISH_WATCH_OPTION_CONFLICT"
  | "HUMANISH_WATCH_TUNNEL_REQUIRES_EXPOSE"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_EDGE_AUTH"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW";

export interface ExposureRequest {
  expose: boolean;
  tunnel?: "ngrok" | undefined;
  tunnelDomain?: string | undefined;
  oauth?: "google" | undefined;
  allowEmails: string[];
  allowDomains: string[];
  publicUrl?: string | undefined;
  safe: boolean;
}

// watch-only: a live run must actually stream a desktop AND keep an attached follow channel, so
// exposure is refused for dry-run (no desktop), --detach (no attached server), and --json (no follow).
export interface WatchLiveContext {
  dryRun: boolean;
  detach: boolean;
  json: boolean;
}

export interface ExposurePlan {
  // Whether exposure is active. False => plain loopback; the server never learns a public origin.
  exposed: boolean;
  // Edge auth present: ngrok --oauth OR an operator --public-url. Drives the serve mode label and
  // the serveObserver `exposed` hardening.
  edgeAuthed: boolean;
  mode: ServeMode;
  safe: boolean;
  tunnel?: "ngrok";
  tunnelDomain?: string;
  oauth?: { provider: "google"; allowEmails: string[]; allowDomains: string[] };
  publicOrigin?: { origin: string; host: string; scheme: "http" | "https" };
  warnings: string[];
}

export type ExposureValidation =
  | { ok: true; plan: ExposurePlan }
  | { ok: false; error: { code: ExposureErrorCode; message: string } };

function code(surface: ExposureSurface, suffix: string): ExposureErrorCode {
  return `HUMANISH_${surface.toUpperCase()}_${suffix}` as ExposureErrorCode;
}

export function validateExposure(
  surface: ExposureSurface,
  request: ExposureRequest,
  live?: WatchLiveContext
): ExposureValidation {
  const fail = (suffix: string, message: string): ExposureValidation => ({
    ok: false,
    error: { code: code(surface, suffix), message }
  });

  // Structural guards (both surfaces), in the fail-closed order documented in the matrix. These run
  // before any bind/spawn so a mis-configured exposure aborts before sandbox/provider spend.
  if ((request.allowEmails.length > 0 || request.allowDomains.length > 0) && !request.oauth) {
    return fail("ALLOW_REQUIRES_OAUTH", "--allow-email/--allow-domain configure the ngrok edge OAuth allow-list; they require --oauth google.");
  }
  if (request.oauth && !request.tunnel) {
    return fail("OAUTH_REQUIRES_TUNNEL", "--oauth turns on edge OAuth on the ngrok tunnel; it requires --tunnel ngrok (a --public-url operator brings their own edge auth).");
  }
  if (request.tunnel && request.publicUrl !== undefined) {
    return fail("OPTION_CONFLICT", "Use either --tunnel or --public-url as the public origin, not both.");
  }
  if (request.tunnelDomain !== undefined && !request.tunnel) {
    return fail("OPTION_CONFLICT", "--tunnel-domain requires --tunnel.");
  }

  const publicOrigin = request.publicUrl !== undefined ? parsePublicOrigin(request.publicUrl) : null;
  if (request.publicUrl !== undefined && !publicOrigin) {
    return fail("OPTION_CONFLICT", "--public-url must be an http(s) origin like https://observer.example.dev.");
  }

  if (!request.expose) {
    // Exposure flags without --expose are refused (no silent wide-open). --safe is orthogonal and
    // stays valid without --expose (a loopback share_ready filter).
    if (request.tunnel) {
      return fail("TUNNEL_REQUIRES_EXPOSE", "--tunnel exposes the surface; declare that intent with --expose.");
    }
    if (request.publicUrl !== undefined) {
      return fail("OPTION_CONFLICT", "--public-url only applies with --expose.");
    }
    return {
      ok: true,
      plan: { exposed: false, edgeAuthed: false, mode: "loopback", safe: request.safe, warnings: [] }
    };
  }

  const oauth = request.oauth
    ? { provider: "google" as const, allowEmails: request.allowEmails, allowDomains: request.allowDomains }
    : undefined;
  const edgeAuthed = Boolean(request.oauth) || Boolean(publicOrigin);
  const warnings: string[] = [];

  if (surface === "watch") {
    // A live, in-progress run is never share_ready (raw screenshots, unverified), so --safe would
    // admit nothing and expose nothing: watch --expose ALWAYS requires edge auth, and the live-follow
    // preconditions are checked first so `--dry-run`/`--detach`/`--json` fail with the clearer reason.
    if (live && (live.dryRun || live.detach || live.json)) {
      return fail(
        "EXPOSE_REQUIRES_LIVE_FOLLOW",
        "watch --expose streams a live desktop over an attached follow channel; it cannot combine with --dry-run, --detach, or --json."
      );
    }
    if (!edgeAuthed) {
      return fail(
        "EXPOSE_REQUIRES_EDGE_AUTH",
        "watch --expose serves a live run that is never share_ready, so --safe cannot gate it; require edge auth: --tunnel ngrok --oauth google, or an operator-secured --public-url."
      );
    }
  } else if (!edgeAuthed && !request.safe) {
    return fail(
      "EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE",
      "--expose opens a public URL to local run bundles; require edge auth (--oauth google with --tunnel, or a --public-url you secure) OR --safe (share_ready runs only)."
    );
  }

  if (request.oauth && request.allowEmails.length === 0 && request.allowDomains.length === 0) {
    warnings.push(
      "ngrok --oauth google with NO --allow-email/--allow-domain lets ANY Google account that reaches the URL in; add at least one allow rule to restrict who can watch."
    );
  }

  const mode: ServeMode = edgeAuthed ? "exposed" : "share-safe-open";
  return {
    ok: true,
    plan: {
      exposed: true,
      edgeAuthed,
      mode,
      safe: request.safe,
      ...(request.tunnel ? { tunnel: request.tunnel } : {}),
      ...(request.tunnelDomain ? { tunnelDomain: request.tunnelDomain } : {}),
      ...(oauth ? { oauth } : {}),
      ...(publicOrigin ? { publicOrigin } : {}),
      warnings
    }
  };
}

// The minimal server contract startExposedObserver drives: bound loopback port + url + a way to
// extend the Host allowlist. Both ObserverServer (live) and ServeLibraryServer satisfy it.
export interface ExposableServer {
  readonly port: number;
  readonly url: string;
  addPublicOrigin(origin: string): void;
}

export interface ExposureResult {
  tunnel?: ServeTunnel;
  publicUrl?: string;
  warnings: string[];
}

// Orchestrate the edge in front of an already-bound loopback server: spawn the ngrok tunnel (with
// oauth/allow args) or declare the operator's --public-url, then extend the server's Host allowlist.
// May throw a ServeTunnelError (ngrok missing/failed); callers close the loopback server on throw.
export async function startExposedObserver(
  server: ExposableServer,
  plan: ExposurePlan,
  deps: { startTunnel?: (options: StartNgrokTunnelOptions) => Promise<ServeTunnel> } = {}
): Promise<ExposureResult> {
  const warnings = [...plan.warnings];
  if (plan.tunnel === "ngrok") {
    const startTunnel = deps.startTunnel ?? startNgrokTunnel;
    const tunnel = await startTunnel({
      port: server.port,
      ...(plan.tunnelDomain ? { domain: plan.tunnelDomain } : {}),
      ...(plan.oauth
        ? {
            oauthProvider: plan.oauth.provider,
            oauthAllowEmails: plan.oauth.allowEmails,
            oauthAllowDomains: plan.oauth.allowDomains
          }
        : {})
    });
    server.addPublicOrigin(tunnel.url);
    return { tunnel, publicUrl: tunnel.url.replace(/\/$/, ""), warnings };
  }
  if (plan.publicOrigin) {
    server.addPublicOrigin(plan.publicOrigin.origin);
    return { publicUrl: plan.publicOrigin.origin, warnings };
  }
  return { warnings };
}
