// Provider keys E2B's egress proxy can hold for a sandbox. Each of these keys travels as one
// request header to one fixed host, so an E2B header transform on that host can add it to every
// request the sandbox sends there. The sandbox's own processes then hold only a placeholder.
import type { E2BNetworkOptions } from "./sdk.js";

/** An inert nonsecret value that satisfies a client's "key is set" check. E2B replaces the header. */
export const EGRESS_PLACEHOLDER = "humanish-egress-auth-placeholder";
/** E2B envd installs the sandbox-specific proxy CA into this system bundle before routing. */
export const E2B_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/** The one host a key is sent to and the header that carries it. */
interface HeaderKey {
  host: string;
  header: string;
  value: (key: string) => string;
}

const GEMINI: HeaderKey = {
  host: "generativelanguage.googleapis.com",
  header: "x-goog-api-key",
  value: (key) => key,
};

/**
 * Where each key name humanish sends as a header goes, beside the E2B key. Every host is fixed in
 * the code that calls it: src/actors/openai-endpoint.ts, the Messages endpoint in
 * src/actors/computer-use/anthropic-provider.ts and src/analysis/gemini-wire.ts. A participant
 * vendor whose key travels as one header to one host adds its row here.
 */
const HEADER_KEYS: Readonly<Record<string, HeaderKey>> = {
  OPENAI_API_KEY: {
    host: "api.openai.com",
    header: "Authorization",
    value: (key) => `Bearer ${key}`,
  },
  ANTHROPIC_API_KEY: { host: "api.anthropic.com", header: "x-api-key", value: (key) => key },
  GEMINI_API_KEY: GEMINI,
  GOOGLE_API_KEY: GEMINI,
};

/** Where `name` goes as a header: its row, or for the E2B key the E2B SDK's `https://api.<domain>`. */
function headerKey(name: string, domain: string): HeaderKey | undefined {
  if (name === "E2B_API_KEY")
    return { host: `api.${domain}`, header: "X-API-Key", value: (key) => key };
  return Object.hasOwn(HEADER_KEYS, name) ? HEADER_KEYS[name] : undefined;
}

const sameHost = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");

/**
 * Hold every key in `keys` that travels as a header to a fixed host in an E2B header transform on
 * `existing`, and give the env a placeholder for it. Other names pass through unchanged. The
 * installed E2B SDK declares that transform headers override the request's own. The returned
 * network carries the key values: never log or persist it. E2B's sandbox info endpoint returns
 * the transforms as given, so a process that can call the E2B API for this sandbox can read them.
 * An existing rule for a held key's host is refused, never overwritten.
 */
export function holdKeysInEgress(
  keys: Readonly<Record<string, string>>,
  options: {
    /** The account's E2B_DOMAIN; the E2B API host is `api.<domain>`. */
    domain?: string | undefined;
    existing?: E2BNetworkOptions | undefined;
  } = {},
): { network: E2BNetworkOptions; env: Record<string, string>; held: string[] } {
  const { existing } = options;
  const domain = options.domain?.trim() || "e2b.app";
  const rules: NonNullable<E2BNetworkOptions["rules"]> = {};
  const env: Record<string, string> = {};
  const held: string[] = [];
  for (const [name, value] of Object.entries(keys)) {
    const placed = headerKey(name, domain);
    if (placed === undefined) {
      env[name] = value;
      continue;
    }
    const taken = [...Object.keys(existing?.rules ?? {}), ...Object.keys(rules)].some((host) =>
      sameHost(host, placed.host),
    );
    if (taken)
      throw new Error(
        `${name} would be held in a header transform on ${placed.host}, which already has a network rule; refusing to overwrite it.`,
      );
    rules[placed.host] = [{ transform: { headers: { [placed.header]: placed.value(value) } } }];
    env[name] = EGRESS_PLACEHOLDER;
    held.push(name);
  }
  if (held.length === 0) return { network: { ...existing }, env, held };
  return {
    network: { ...existing, rules: { ...existing?.rules, ...rules } },
    env,
    held: held.sort(),
  };
}
