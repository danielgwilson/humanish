import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptSecret } from "../src/secret-prompt.js";

function terminal() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  output.isTTY = true;
  let written = "";
  output.on("data", chunk => { written += String(chunk); });
  return { input, output, written: () => written };
}

describe("host-owned secret prompt", () => {
  it("disables echo and installs handlers before advertising readiness", async () => {
    const t = terminal();
    t.output.on("data", chunk => {
      if (String(chunk).includes("input hidden")) {
        expect(t.input.isRaw).toBe(true);
        t.input.emit("data", "synthetic-immediate-paste\r");
      }
    });
    expect(await promptSecret("Key", t.input, t.output)).toBe("synthetic-immediate-paste");
    expect(t.written()).not.toContain("synthetic");
  });
  it("accepts typed and pasted input without echo; restores terminal mode", async () => {
    const t = terminal();
    const pending = promptSecret("AgentMail key", t.input, t.output);
    t.input.emit("data", "synthetic-wronx");
    t.input.emit("data", "\u007f");
    t.input.emit("data", "g-key-canary\r");
    expect(await pending).toBe("synthetic-wrong-key-canary");
    expect(t.written()).not.toContain("synthetic");
    expect(t.input.isRaw).toBe(false);
  });
  it("accepts a bracketed paste without storing terminal control sequences", async () => {
    const t = terminal();
    const pending = promptSecret("Key", t.input, t.output);
    t.input.emit("data", "\u001b[200~synthetic-paste-canary\u001b[201~");
    t.input.emit("data", "\r");
    expect(await pending).toBe("synthetic-paste-canary");
    expect(t.written()).not.toContain("synthetic");
  });
  it("cancels on Ctrl+C and EOF without persisting or echoing partial input", async () => {
    for (const cancel of ["\u0003", "\u0004"]) {
      const t = terminal();
      const pending = promptSecret("Key", t.input, t.output);
      if (cancel === "\u0003") t.input.emit("data", "synthetic-partial");
      t.input.emit("data", cancel);
      expect(await pending).toBeNull();
      expect(t.written()).not.toContain("synthetic");
      expect(t.input.isRaw).toBe(false);
    }
  });
  it("does not consume non-terminal input", async () => {
    const t = terminal(); t.input.isTTY = false;
    expect(await promptSecret("Key", t.input, t.output)).toBeNull();
    expect(t.written()).toBe("");
  });
});
