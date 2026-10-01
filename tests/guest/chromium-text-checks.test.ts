import { describe, expect, it } from "vitest";
import {
  evaluateParams,
  isAdmissibleText,
  isExecutionContextId,
  ownedFrameId,
  probeAccepted,
} from "../../src/guest/chromium-text.js";

describe("guest Chromium text checks", () => {
  it("admits non-empty NUL-free text up to 64 KiB of UTF-8 that round-trips", () => {
    for (const text of ["a", "a".repeat(65536), "é".repeat(32768), "line\nbreak", "👍"])
      expect(isAdmissibleText(text), JSON.stringify(text.slice(0, 8))).toBe(true);
    for (const text of [
      "",
      "a\0b",
      "a".repeat(65537),
      `${"é".repeat(32768)}a`,
      "\uD800",
      "a\uDC00",
      undefined,
      7,
      new String("a"),
    ])
      expect(isAdmissibleText(text), String(text).slice(0, 8)).toBe(false);
  });

  it("returns the top frame's id and refuses anything else", () => {
    expect(ownedFrameId({ frameTree: { frame: { id: "owned" } } })).toBe("owned");
    expect(ownedFrameId({ frameTree: { frame: { id: "owned", parentId: "" } } })).toBe("owned");
    for (const tree of [
      {},
      { frameTree: {} },
      { frameTree: { frame: {} } },
      { frameTree: { frame: { id: "" } } },
      { frameTree: { frame: { id: 1 } } },
      { frameTree: { frame: { id: "child", parentId: "owned" } } },
    ])
      expect(ownedFrameId(tree), JSON.stringify(tree)).toBeUndefined();
  });

  it("admits only a positive safe integer context id", () => {
    for (const id of [1, 7, Number.MAX_SAFE_INTEGER]) expect(isExecutionContextId(id)).toBe(true);
    for (const id of [
      0,
      -1,
      1.5,
      "7",
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
    ])
      expect(isExecutionContextId(id), String(id)).toBe(false);
  });

  it("evaluates by value, synchronously, silently and without a user gesture", () => {
    const params = evaluateParams("true", 7);
    expect(params).toEqual({
      expression: "true",
      contextId: 7,
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
      includeCommandLineAPI: false,
      silent: true,
    });
    expect(Object.keys(params)).toEqual([
      "expression",
      "contextId",
      "returnByValue",
      "awaitPromise",
      "userGesture",
      "includeCommandLineAPI",
      "silent",
    ]);
  });

  it("accepts only a boolean true probe result without an exception", () => {
    expect(probeAccepted({ result: { type: "boolean", value: true } })).toBe(true);
    expect(
      probeAccepted({ exceptionDetails: null, result: { type: "boolean", value: true } }),
    ).toBe(true);
    for (const reply of [
      { exceptionDetails: {}, result: { type: "boolean", value: true } },
      { result: { type: "boolean", value: false } },
      { result: { type: "boolean" } },
      { result: { type: "string", value: true } },
      { result: { type: "boolean", value: "true" } },
      { result: { type: "number", value: 1 } },
    ])
      expect(probeAccepted(reply), JSON.stringify(reply)).toBe(false);
  });
});
