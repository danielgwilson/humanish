import { expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";

// A catch token guards GET /deliveries on a host the run reaches over the network, and humanish
// scrubs it from run text. A short token is guessable and turns ordinary text into scrub matches.
it("refuses a catch token shorter than 16 characters before it starts", async () => {
  const stderr: string[] = [];
  let exitCode = 0;
  const program = createProgram({
    writeOut: () => {},
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  // The invalid port keeps an older build, which checks the port first, from starting a server.
  await program.parseAsync(
    ["node", "humanish", "comms", "catch", "--token", "abc", "--port", "0"],
    {
      from: "node",
    },
  );
  expect(exitCode).toBe(2);
  expect(stderr.join("")).toContain("it must be at least 16");
});
