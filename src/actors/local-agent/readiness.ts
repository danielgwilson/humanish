// Whether a local-agent participant can run on this machine before anything is acquired: its CLI
// is on `PATH` and signed in, a hosted Codex CLI is a qualified release on a supported platform, and
// a ChatGPT-account Codex is not asked to enforce a dollar cap it has no price for. Each route maps
// the refusal's kind to its own error code.

import { describeQualifiedCodexCliVersions } from "../codex/qualified-versions.js";
import { checkHostedCodexCompatibility, detectLocalAgents, type LocalAgentId } from "./cli.js";

/** Why a local-agent participant cannot run here. */
export type LocalAgentRefusal =
  /** The CLI is not on `PATH`. */
  | { kind: "agent-missing"; message: string }
  /** The CLI is signed out, or could not report its sign-in status. */
  | { kind: "signin-required"; message: string }
  /** Hosted Codex on an unsupported platform or an unqualified CLI release. */
  | { kind: "unsupported"; message: string }
  /** A ChatGPT-account Codex with execution.caps, which it cannot price. */
  | { kind: "unpriced-cap"; message: string };

export async function localAgentRefusal(args: {
  agent: LocalAgentId;
  env: Record<string, string | undefined>;
  caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number };
}): Promise<LocalAgentRefusal | undefined> {
  const { agent, env, caps } = args;
  const available = await detectLocalAgents({ env });
  const chosen = available.find((candidate) => candidate.id === agent);
  if (chosen === undefined) {
    return {
      kind: "agent-missing",
      message:
        `actors[0].type: local-agent needs the ${agent} CLI on PATH and signed in. ` +
        `Install it, or set OPENAI_API_KEY and use actors[0].type: openai-computer-use instead.`,
    };
  }
  if (chosen.authStatus !== "authenticated") {
    return {
      kind: "signin-required",
      message:
        chosen.authStatus === "unauthenticated"
          ? `${chosen.label} reports not signed in — run \`${chosen.id === "codex" ? "codex login" : "claude auth login"}\`, then retry.`
          : `${chosen.label} authentication status could not be checked. Run \`${chosen.id === "codex" ? "codex login status" : "claude auth status"}\` and update the CLI if needed. No desktop was launched.`,
    };
  }
  if (chosen.id !== "codex") return undefined;
  const compatibility = await checkHostedCodexCompatibility(chosen.binPath, { env });
  if (compatibility !== "supported") {
    return {
      kind: "unsupported",
      message:
        compatibility === "unsupported_platform"
          ? `Hosted Codex participants require Linux or macOS on x64 or arm64. This host is ${process.platform}/${process.arch}; no desktop was launched.`
          : `Hosted Codex participants require a qualified Codex CLI (${describeQualifiedCodexCliVersions()}). Run \`codex --version\` and install a qualified version before retrying; no desktop was launched.`,
    };
  }
  if (
    chosen.billing === "account-unknown" &&
    (caps.maxUsd !== undefined || caps.maxTotalUsd !== undefined)
  ) {
    return {
      kind: "unpriced-cap",
      message:
        "A ChatGPT-account Codex participant has no API-dollar price, so execution.caps.maxUsd/maxTotalUsd cannot be enforced. Remove the dollar cap and use finite execution timeout/step limits, or use an API-backed participant; no desktop was launched.",
    };
  }
  return undefined;
}
