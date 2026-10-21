// E2B's base sandbox, the `base` template with no desktop, behind the same sandbox port as the
// desktop, so acquire(), receipts, release and reclaim work on it unchanged. A sandbox that runs
// humanish itself needs commands, files and one authenticated port; the desktop template would
// start an X session nobody uses and bill its 8 vCPU.
//
// @e2b/desktop re-exports the e2b SDK but replaces its Sandbox with the desktop subclass, and a
// strict install does not let humanish import `e2b`, which is only @e2b/desktop's dependency. The
// base class is the desktop class's parent.
import {
  guardDesktopSandboxCreate,
  importE2BDesktop,
  type E2BDesktopModule,
  type SandboxPortAccess,
} from "./sdk.js";
import { shellOnlySurface } from "./shell-only.js";

/** The header E2B's proxy reads a sandbox's traffic access token from (spike, 2026-10-21). */
const TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";

/** What humanish reads from an instance of the e2b SDK's base Sandbox. */
interface BaseSandboxInstance {
  readonly sandboxId: string;
  readonly trafficAccessToken?: string;
  getHost(port: number): string;
}

type BaseSandboxClass = new (...args: never[]) => BaseSandboxInstance;

class E2BDesktopOnlyError extends Error {
  constructor(what: string) {
    super(`${what} needs a desktop sandbox; this E2B sandbox runs the base template.`);
    this.name = "E2BDesktopOnlyError";
  }
}

/** A sandbox port that creates and connects to E2B base-template sandboxes. */
export async function loadE2BBaseModule(): Promise<E2BDesktopModule> {
  return guardDesktopSandboxCreate({ Sandbox: baseSandbox(await importE2BDesktop()) });
}

function baseSandbox(desktop: E2BDesktopModule): E2BDesktopModule["Sandbox"] {
  const Base = Object.getPrototypeOf(desktop.Sandbox) as BaseSandboxClass;
  if (typeof (Base as unknown as { create?: unknown }).create !== "function")
    throw new Error(
      "The installed @e2b/desktop does not extend the e2b SDK's Sandbox; update @e2b/desktop.",
    );
  class BaseSandbox extends Base {
    constructor(...args: never[]) {
      super(...args);
      Object.assign(
        this,
        shellOnlySurface((what) => new E2BDesktopOnlyError(what)),
      );
    }

    async portAccess(port: number): Promise<SandboxPortAccess> {
      const token = this.trafficAccessToken;
      if (token === undefined || token === "")
        throw new Error(
          "This E2B sandbox accepts public traffic, so it has no traffic access token. Create it with network.allowPublicTraffic set to false.",
        );
      return { url: `https://${this.getHost(port)}`, headers: { [TRAFFIC_TOKEN_HEADER]: token } };
    }
  }
  return BaseSandbox as unknown as E2BDesktopModule["Sandbox"];
}
