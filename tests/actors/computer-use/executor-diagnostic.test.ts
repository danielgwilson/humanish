import { describe, expect, it } from "vitest";

import {
  classifyExecutorFailure,
  describeExecutorDiagnostic,
  type CuaDiagnosticCategory,
} from "../../../src/actors/computer-use/executor-diagnostic.js";

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function coded(code: string): Error {
  return Object.assign(new Error("write failed"), { code });
}

describe("executor failure diagnostics", () => {
  it.each<[Error | string, CuaDiagnosticCategory]>([
    [
      named("TargetClosedError", "Target page, context or browser has been closed"),
      "target_closed",
    ],
    [
      new Error("cDPSession.send: Protocol error (Input.insertText): Target closed."),
      "target_closed",
    ],
    [new Error("Session closed. Most likely the page has been closed."), "target_closed"],
    [new Error("Protocol error (Runtime.evaluate): Frame was detached"), "detached"],
    [new Error("Protocol error (Page.getFrameTree): No session with given id"), "detached"],
    [
      new Error("Execution context was destroyed, most likely because of a navigation"),
      "navigation",
    ],
    [named("TimeoutError", "Timeout 5000ms exceeded."), "timeout"],
    [
      new Error("Protocol error (Page.createIsolatedWorld): No frame for given id found"),
      "protocol_error",
    ],
    [coded("EPIPE"), "channel_closed"],
    [coded("ECONNRESET"), "channel_closed"],
    [new Error("something else went wrong"), "unknown"],
    ["a thrown string", "unknown"],
  ])("classifies %s as %s", (error, category) => {
    expect(classifyExecutorFailure("insert_text", error)).toEqual({
      step: "insert_text",
      category,
    });
  });

  it.each([
    [
      "a form value",
      'Protocol error (Input.insertText): Target closed while value "Alice Jones, 1984-02-11" was pending',
      "Alice Jones",
    ],
    [
      "a cookie pair",
      "Protocol error (Input.insertText): session_cookie=abc123PrivateValue rejected",
      "abc123PrivateValue",
    ],
    [
      "a file path",
      "ENOENT: no such file or directory, open '/mnt/records/Alice-Jones.txt'",
      "/mnt/records",
    ],
  ])("keeps only the step and category when the message holds %s", (_kind, message, secret) => {
    const diagnostic = classifyExecutorFailure("insert_text", new Error(message));
    expect(Object.keys(diagnostic).sort()).toEqual(["category", "step"]);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(describeExecutorDiagnostic(diagnostic)).not.toContain(secret);
  });

  it("renders a fixed sentence from the two words", () => {
    expect(describeExecutorDiagnostic({ step: "insert_text", category: "target_closed" })).toBe(
      "insert_text, target_closed: the page, its browser context or the browser closed while inserting text (Input.insertText)",
    );
    expect(describeExecutorDiagnostic({ step: "channel", category: "channel_closed" })).toBe(
      "channel, channel_closed: the channel to the guest closed while reading the browser-control channel",
    );
  });
});
