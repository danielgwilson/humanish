import { ownDesktopAllocation, type OwnedDesktopAllocation } from "./desktop-session.js";
import {
  createDesktopSandbox,
  type E2BDesktopCreateOptions,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
  type TransientRetryHooks
} from "./e2b-desktop-launch.js";

/** Provider-specific provisioning stays in the hosted adapter; the actor consumes an executor. */
export async function allocateE2BDesktopSession(
  module: E2BDesktopModule,
  options: E2BDesktopCreateOptions,
  template?: string,
  retry?: TransientRetryHooks
): Promise<{ desktop: E2BDesktopSandbox; allocation: OwnedDesktopAllocation }> {
  const desktop = await createDesktopSandbox(module, options, template, retry);
  // The mutable SDK handle is passed to provisioning hooks. Capture its acquired identity
  // and the provider method now, before any hook can change either one.
  const resourceId = desktop.sandboxId;
  const kill = typeof module.Sandbox.kill === "function"
    ? module.Sandbox.kill.bind(module.Sandbox)
    : undefined;
  const allocation = ownDesktopAllocation({
    resourceId,
    release: async () => {
      if (kill === undefined) return { status: "unconfirmed", reason: "release_unavailable" };
      const result = await kill(resourceId, { requestTimeoutMs: 60_000 });
      // SDK false means 404/already absent, not an unconfirmed request. Anything else is
      // an incompatible response and cannot prove release. Never list the account.
      if (result === true) return { status: "released", reason: "terminated" };
      if (result === false) return { status: "released", reason: "already_gone" };
      return { status: "unconfirmed", reason: "invalid_result" };
    }
  });
  return { desktop, allocation };
}
