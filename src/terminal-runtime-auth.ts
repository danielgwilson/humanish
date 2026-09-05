import type { E2BNetworkOptions } from "./e2b-desktop-launch.js";

export const OPENAI_EGRESS_HOST = "api.openai.com";
/** E2B envd installs the sandbox-specific proxy CA into this system bundle before routing. */
export const E2B_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
/** An inert nonsecret value satisfies Codex exec's auth prerequisite. E2B replaces the header. */
export const OPENAI_EGRESS_PLACEHOLDER = "humanish-egress-auth-placeholder";

/**
 * Keep the runtime key in the host-side E2B request, outside sandbox env/files. The installed
 * E2B SDK declares that transform headers override existing request headers. This adds no routing
 * restrictions: every sandbox process can still spend via the provider proxy. Never log the
 * returned options. An adopter's existing exact-host rule must not be silently overwritten.
 */
export function buildOpenAiEgressNetwork(
  keyValue: string,
  existing?: E2BNetworkOptions
): E2BNetworkOptions {
  if (Object.keys(existing?.rules ?? {}).some((host) => host.toLowerCase().replace(/\.$/, "") === OPENAI_EGRESS_HOST)) {
    throw new Error("openai-egress conflicts with an existing api.openai.com network rule; refusing to overwrite it.");
  }
  return {
    ...existing,
    rules: {
      ...existing?.rules,
      [OPENAI_EGRESS_HOST]: [{ transform: { headers: { Authorization: `Bearer ${keyValue}` } } }]
    }
  };
}
