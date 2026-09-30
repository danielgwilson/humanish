import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../../src/substrates/shell.js";

const execFileAsync = promisify(execFile);

// Every command line humanish builds quotes its words with this one helper, so its escape is
// pinned here once.
describe("shellQuote", () => {
  it("closes, escapes and reopens the quote around a single quote", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });

  it("gives the shell back exactly the word it was given", async () => {
    const words = [
      "plain",
      "it's",
      "'",
      "''",
      "a b\tc",
      '$HOME `id` $(id) \\ "double"',
      "line one\nline two",
      "-flag",
      "",
    ];
    for (const word of words) {
      const { stdout } = await execFileAsync("sh", ["-c", `printf '%s' ${shellQuote(word)}`]);
      expect(stdout).toBe(word);
    }
  });
});
