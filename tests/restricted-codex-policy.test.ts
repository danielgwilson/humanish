import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admitsRestrictedCodexConfig, restrictedCodexRequestError, type RestrictedCodexRequest } from "../src/restricted-codex-policy.js";

const captured = JSON.parse(readFileSync(new URL("./fixtures/restricted-codex/effective-config.json", import.meta.url), "utf8"));
const admitted = (raw: unknown) => admitsRestrictedCodexConfig(raw, "/private/probe/home/config.toml", "gpt-6-astra");
const request: RestrictedCodexRequest = { model: "gpt-6-astra", instructions: "Synthetic instructions", evidence: "Synthetic evidence",
  images: [], schema: { type: "object" }, maxOutputTokens: null, timeoutMs: 1000 };

describe("restricted Codex effective policy", () => {
  it("accepts the captured effective config, including an absent optional disabledReason", () => {
    expect(admitted(captured)).toBe(true);
    const value = structuredClone(captured); value.layers[0].disabledReason = null;
    expect(admitted(value)).toBe(true);
    value.layers[0].disabledReason = "synthetic policy disabled this layer";
    expect(admitted(value)).toBe(false);
  });
  it.each(["model_instructions_file", "experimental_compact_prompt_file", "sqlite_home", "log_dir", "openai_base_url", "js_repl_node_path", "compact_prompt", "notify"])(
    "rejects an effective %s override even with otherwise clean layers", key => {
      const value = structuredClone(captured); value.config[key] = "/synthetic/authority";
      expect(admitted(value)).toBe(false);
    });
  it.each(["otel", "marketplaces", "plugins", "mcp_servers", "profiles", "permissions", "apps"])("rejects configured %s", key => {
    const value = structuredClone(captured); value.config[key] = { synthetic: "enabled" };
    expect(admitted(value)).toBe(false);
  });
  it("rejects unsupported file/remote image sources, image count and malformed base64", () => {
    for (const dataUrl of ["https://example.invalid/image.png", "file:///synthetic/image.png", "data:image/svg+xml;base64,YQ==", "data:image/png;base64,YQ="])
      expect(restrictedCodexRequestError({ ...request, images: [{ evidenceId: "e1", dataUrl }] })).toBe("invalid_request");
    expect(restrictedCodexRequestError({ ...request, images: Array.from({ length: 129 }, () => ({ evidenceId: "e1", dataUrl: "data:image/png;base64,YQ==" })) })).toBe("invalid_request");
  });
  it("enforces the complete packet bound without silently dropping any captures", () => {
    const dataUrl = `data:image/png;base64,${Buffer.alloc(21 * 1024 * 1024).toString("base64")}`;
    expect(restrictedCodexRequestError({ ...request, images: [{ evidenceId: "e1", dataUrl }] })).toBe("invalid_request");
    expect(restrictedCodexRequestError({ ...request, evidence: "x".repeat(33 * 1024 * 1024) })).toBe("invalid_request");
  });
});
