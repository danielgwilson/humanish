// Which E2B account each call reaches. The SDK falls back to process.env's E2B_API_KEY and
// E2B_DOMAIN for a call that names neither, while a run reads its key from the env it was given,
// which a library caller can keep apart from process.env. A kill, check or list that named no
// account could then fail or reach another account than the create, and the sandbox would run
// until its create-time timeout. A route's release of its sandbox and every call of
// `humanish reclaim` go through an E2BAccount, which names the account on each one.
import type { E2BConnection, E2BDesktopModule } from "./sdk.js";

/** The connection an env names: E2B_API_KEY and E2B_DOMAIN, trimmed, each only when set. */
export function e2bConnection(env: Readonly<Record<string, string | undefined>>): E2BConnection {
  return named({ apiKey: env.E2B_API_KEY?.trim(), domain: env.E2B_DOMAIN?.trim() });
}

/** The calls humanish makes on sandboxes that already exist. */
export type E2BAccount = Pick<E2BDesktopModule["Sandbox"], "kill" | "getInfo" | "list">;

/**
 * The kill, getInfo and list of `module`, each carrying `connection`'s key and domain over the
 * call's own options. `connection` may be a create's options, so the release of a sandbox reaches
 * the account that created it. Each method is bound now: a hook that later replaces one on the
 * shared module does not change this account. A method the installed SDK lacks stays absent.
 */
export function e2bAccount(module: E2BDesktopModule, connection: E2BConnection): E2BAccount {
  const sdk = module.Sandbox;
  const reached = named(connection);
  const account: E2BAccount = {};
  if (typeof sdk.kill === "function") {
    const kill = sdk.kill.bind(sdk);
    account.kill = (sandboxId, options) => kill(sandboxId, { ...options, ...reached });
  }
  if (typeof sdk.getInfo === "function") {
    const getInfo = sdk.getInfo.bind(sdk);
    account.getInfo = (sandboxId, options) => getInfo(sandboxId, { ...options, ...reached });
  }
  if (typeof sdk.list === "function") {
    const list = sdk.list.bind(sdk);
    account.list = (options) => list({ ...options, ...reached });
  }
  return account;
}

/** Only the key and the domain, and only when non-empty: the SDK reads an empty one as unset. */
function named(values: {
  apiKey?: string | undefined;
  domain?: string | undefined;
}): E2BConnection {
  return {
    ...(values.apiKey ? { apiKey: values.apiKey } : {}),
    ...(values.domain ? { domain: values.domain } : {}),
  };
}
