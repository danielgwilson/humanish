import { describe, expect, it } from "vitest";

import { starterFiles, starterFilesFor } from "../../src/study/init-templates.js";

describe("humanish format stack", () => {
  it("scaffolds humanish-owned authored source as .yaml, not .yml", () => {
    const authoredSourcePrefixes = ["humanish/personas/", "humanish/scenarios/", "humanish/labs/"];

    const authoredSourcePaths = starterFiles
      .map((file) => file.path)
      .filter((filePath) => authoredSourcePrefixes.some((prefix) => filePath.startsWith(prefix)));

    expect(authoredSourcePaths.length).toBeGreaterThan(0);
    expect(authoredSourcePaths.every((filePath) => filePath.endsWith(".yaml"))).toBe(true);
    expect(starterFiles.some((file) => file.path.endsWith(".yml"))).toBe(false);
  });
});

describe("the README init writes", () => {
  it.each(["npx humanish", "npx humanish@1.2.3", "humanish"])(
    "starts every command with the install's invocation (%s)",
    (command) => {
      const readme = starterFilesFor("openai-computer-use", undefined, undefined, command).find(
        (file) => file.path === "humanish/README.md",
      )!;
      const commands = [
        ...readme.contents.matchAll(/`([^`]*humanish(?:@[^\s`]+)? [a-z][^`]*)`/g),
      ].map((match) => match[1] ?? "");
      expect(commands.length).toBeGreaterThan(0);
      for (const text of commands) expect(text.startsWith(`${command} `), text).toBe(true);
    },
  );
});
