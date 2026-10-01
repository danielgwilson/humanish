// The guest desktop executor's pure parts, tested directly: the frame-size check, input planning,
// and the decisions a failed action makes about the session and the error it throws.

import { describe, expect, it } from "vitest";

import { CuaExecutorError } from "../../src/actors/computer-use/executor-error.js";
import type { CuaAction } from "../../src/actors/computer-use/loop.js";
import { BROWSER_CONTROL_LIMITS } from "../../src/browser-control/protocol.js";
import {
  failureEndsSession,
  failureError,
  isValidFrameSize,
  planActionInput,
} from "../../src/guest/desktop-executor.js";

const { dimension, pixels } = BROWSER_CONTROL_LIMITS;

describe("isValidFrameSize", () => {
  it.each([
    [960, 720, true],
    [1, 1, true],
    [dimension, Math.floor(pixels / dimension), true],
    [0, 720, false],
    [960, -1, false],
    [960.5, 720, false],
    [Number.NaN, 720, false],
    [dimension + 1, 1, false],
    [dimension, Math.floor(pixels / dimension) + 1, false],
  ])("%j by %j is %j", (width, height, valid) => {
    expect(isValidFrameSize(width, height)).toBe(valid);
  });
});

describe("planActionInput", () => {
  const frame = { width: 100, height: 80 };
  it.each([
    [{ kind: "move", x: 0, y: 0 }, [["mousemove", "0", "0"]]],
    [{ kind: "move", x: 99.4, y: 79.9 }, [["mousemove", "99", "79"]]],
    [
      { kind: "click", x: 1, y: 2, button: "right", heldKeys: ["SHIFT"] },
      [
        ["keydown", "shift"],
        ["mousemove", "1", "2"],
        ["click", "3"],
        ["keyup", "shift"],
      ],
    ],
    [{ kind: "scroll", x: 1, y: 1, dx: 0, dy: 0, heldKeys: ["SHIFT"] }, []],
    [
      { kind: "scroll", x: 1, y: 1, dx: -120, dy: 0 },
      [
        ["mousemove", "1", "1"],
        ["click", "6"],
      ],
    ],
    [{ kind: "type", text: "plain" }, []],
    [{ kind: "wait" }, []],
  ] as [CuaAction, string[][]][])("plans %j", (action, expected) => {
    expect(planActionInput(frame, action)).toEqual(expected);
  });

  it.each([
    [{ kind: "move", x: 100, y: 0 }],
    [{ kind: "move", x: 0, y: -0.1 }],
    [{ kind: "drag", path: [{ x: 1, y: 1 }] }],
    [{ kind: "scroll", x: 1, y: 1, dx: 12_001, dy: 0 }],
    [{ kind: "type", text: "a\0b" }],
    [{ kind: "speak", text: "hello" }],
    [{ kind: "click", x: 1, y: 1, heldKeys: ["HYPER"] }],
  ] as [CuaAction][])("refuses %j as not dispatched", (action) => {
    expect(() => planActionInput(frame, action)).toThrow(
      expect.objectContaining({ disposition: "not_dispatched" }),
    );
  });
});

describe("failureEndsSession", () => {
  const rejected = new CuaExecutorError("action_rejected", "not_dispatched");
  const failed = new CuaExecutorError("execution_failed", "not_dispatched");
  it.each([
    [
      "a refusal before anything ran",
      { preparing: false, dispatched: false },
      rejected,
      false,
      false,
    ],
    [
      "an executor error before anything ran",
      { preparing: false, dispatched: false },
      failed,
      false,
      false,
    ],
    ["a foreign error", { preparing: false, dispatched: false }, new Error("x"), false, true],
    ["an aborted signal", { preparing: false, dispatched: false }, rejected, true, true],
    ["anything dispatched", { preparing: false, dispatched: true }, rejected, false, true],
    [
      "a preparation refused before dispatch",
      { preparing: true, dispatched: false },
      rejected,
      false,
      false,
    ],
    [
      "a preparation that failed otherwise",
      { preparing: true, dispatched: false },
      failed,
      false,
      true,
    ],
  ])("%s: %j", (_name, progress, error, aborted, ends) => {
    expect(failureEndsSession(progress, error, { aborted })).toBe(ends);
  });
});

describe("failureError", () => {
  const rejected = new CuaExecutorError("action_rejected", "not_dispatched");
  it("keeps the code and makes the outcome uncertain once anything was dispatched", () => {
    expect(failureError(true, rejected, { aborted: true })).toMatchObject({
      code: "action_rejected",
      disposition: "outcome_uncertain",
    });
    expect(failureError(true, new Error("x"), { aborted: false })).toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
  });
  it("revokes an undispatched action whose signal aborted", () => {
    expect(failureError(false, rejected, { aborted: true })).toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
  });
  it("rethrows the executor's own error, and hides any other", () => {
    expect(failureError(false, rejected, { aborted: false })).toBe(rejected);
    expect(failureError(false, new Error("private"), { aborted: false })).toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
      message: "Desktop executor could not complete the request.",
    });
  });
});
