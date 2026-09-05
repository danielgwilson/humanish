import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { containsSensitive, redactText, redactToSecretLabel } from "../src/redaction.js";

const localPaths = [
  ["", "tmp", "synthetic-workspace"],
  ["", "private", "tmp", "synthetic-workspace"],
  ["", "var", "folders", "synthetic-workspace"],
  ["", "private", "var", "folders", "synthetic-workspace"],
  ["", "Users", "synthetic", "workspace"],
  ["", "home", "synthetic", "workspace"]
].map((parts) => parts.join("/"));

describe("local-path redaction preserves JSON framing", () => {
  it.each([redactText, redactToSecretLabel])("preserves nested serialization and literal backslashes (%s)", (redact) => {
    for (const localPath of localPaths) {
      for (let depth = 1; depth <= 5; depth += 1) {
        for (const suffix of ["", "\\", "\\\\", "\\nested", '"quoted"']) {
          let text = JSON.stringify({ cwd: localPath + suffix, ok: true });
          for (let index = 1; index < depth; index += 1) text = JSON.stringify({ payload: text });
          const cleaned = redact(text);
          expect(containsSensitive(cleaned)).toBe(false);
          expect(cleaned).not.toContain("synthetic");
          let decoded = JSON.parse(cleaned);
          for (let index = 1; index < depth; index += 1) decoded = JSON.parse(decoded.payload);
          expect(decoded.ok).toBe(true);
          expect(decoded.cwd).toMatch(/^\[REDACTED_(?:LOCAL_PATH|RUNTIME_PATH|SECRET)\]/);
        }
      }
    }
  });

  it("keeps the closing escape when its quote arrives in the next callback", () => {
    const text = JSON.stringify({ payload: JSON.stringify({ cwd: localPaths[0], ok: true }) });
    const split = text.indexOf(String.raw`\",\"ok`);
    expect(split).toBeGreaterThan(0);
    for (const at of [split, split + 1, split + 2]) {
      const output = redactText(text.slice(0, at)) + redactText(text.slice(at));
      expect(JSON.parse(JSON.parse(output).payload).ok).toBe(true);
      expect(output).not.toContain("synthetic-workspace");
    }
  });

  it("retains plain-text behavior, secret scrubbing and malformed upstream input", () => {
    const secret = `sk-${"z".repeat(24)}`;
    const cleaned = redactText(`Opened ${localPaths[0]} with ${secret}.`);
    expect(containsSensitive(cleaned)).toBe(false);
    expect(cleaned).toContain("[REDACTED_SECRET]");
    expect(redactText('{"upstream":')).toBe('{"upstream":');
  });

  it("the actual release report reader retains a captured-shape message with a quoted path", () => {
    // Message shape captured in terminal-2026-09-05T03-44-35-879Z-b7b3c4c2.
    // The item id and text are synthetic substitutions, not observed report loss.
    const message = { type: "item.completed", item: {
      id: "synthetic-message", type: "agent_message", text: `I opened "${localPaths[0]}".`
    } };
    const transcript = redactText(JSON.stringify(message)) + '\n{"upstream":\n';
    const report = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { terminalParticipantReport } from './scripts/lib/terminal-report.mjs';
      console.log(JSON.stringify(terminalParticipantReport(readFileSync(0, 'utf8'))));
    `], { input: transcript, encoding: "utf8" }));
    expect(report).toEqual({ last: 'I opened "[REDACTED_LOCAL_PATH]".', malformedLines: 1 });
  });
});
