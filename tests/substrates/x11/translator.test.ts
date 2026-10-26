// The translator's plans for the edges of each dialect: frame checks and rounding on the guest, the
// pointer guard and wheel-step rounding on hosted desktops. The contract test
// (desktop-contract.test.ts) covers what each substrate sends for the common actions.

import { describe, expect, it } from "vitest";

import type { CuaAction } from "../../../src/actors/computer-use/loop.js";
import {
  HOSTED_X11_DIALECT,
  guestX11Dialect,
  planX11Action,
  type X11Plan,
} from "../../../src/substrates/x11/translator.js";

const commands = (...lines: string[][]): X11Plan => ({
  held: undefined,
  steps: lines.map((args) => ({ kind: "xdotool", args })),
});

describe("the guest dialect", () => {
  const guest = guestX11Dialect({ width: 100, height: 80 });

  it.each([
    [{ kind: "move", x: 0, y: 0 }, commands(["mousemove", "0", "0"])],
    [{ kind: "move", x: 99.4, y: 79.9 }, commands(["mousemove", "99", "79"])],
    [
      { kind: "click", x: 1, y: 2, button: "right", heldKeys: ["SHIFT"] },
      { ...commands(["mousemove", "1", "2"], ["click", "3"]), held: "shift" },
    ],
    [{ kind: "scroll", x: 1, y: 1, dx: 0, dy: 0, heldKeys: ["SHIFT"] }, commands()],
    [
      { kind: "scroll", x: 1, y: 1, dx: -120, dy: 0 },
      commands(["mousemove", "1", "1"], ["click", "6"]),
    ],
    [
      { kind: "type", text: "plain" },
      { held: undefined, steps: [{ kind: "text", text: "plain" }] },
    ],
    [{ kind: "wait" }, { held: undefined, steps: [{ kind: "wait", ms: 500 }] }],
    [
      { kind: "hold_keys", keys: ["Control+a"], ms: 30_000 },
      { held: "ctrl+a", steps: [{ kind: "wait", ms: 30_000 }] },
    ],
    [{ kind: "read_pointer" }, { held: undefined, steps: [{ kind: "report-pointer" }] }],
    [
      { kind: "zoom", region: { x: 90, y: 70, width: 10, height: 10 } },
      {
        held: undefined,
        steps: [{ kind: "report-region", region: { x: 90, y: 70, width: 10, height: 10 } }],
      },
    ],
  ] as [CuaAction, X11Plan][])("plans %j", (action, expected) => {
    expect(planX11Action(action, guest)).toEqual(expected);
  });

  it.each([
    [{ kind: "move", x: 100, y: 0 }],
    [{ kind: "move", x: 0, y: -0.1 }],
    [{ kind: "drag", path: [{ x: 1, y: 1 }] }],
    [
      {
        kind: "drag",
        path: [
          { x: 1, y: 1 },
          { x: 1, y: 80 },
        ],
      },
    ],
    [{ kind: "scroll", x: 1, y: 1, dx: 12_001, dy: 0 }],
    [{ kind: "scroll", x: 100, y: 1, dx: 0, dy: 0 }],
    [{ kind: "type", text: "a\0b" }],
    [{ kind: "type", text: "\ud800" }],
    [{ kind: "speak", text: "hello" }],
    [{ kind: "click", x: 1, y: 1, heldKeys: ["HYPER"] }],
    [{ kind: "triple_click", x: 1, y: 80 }],
    [{ kind: "mouse_up", y: 1 }],
    [{ kind: "hold_keys", keys: ["shift"], ms: Number.NaN }],
    [{ kind: "hold_keys", keys: ["shift"], ms: -1 }],
    [{ kind: "hold_keys", keys: ["shift", "shift"], ms: 10 }],
    [{ kind: "zoom", region: { x: -1, y: 0, width: 10, height: 10 } }],
    [{ kind: "zoom", region: { x: 0, y: 0, width: 101, height: 10 } }],
    [{ kind: "zoom", region: { x: 0, y: 0, width: 10, height: 0 } }],
  ] as [CuaAction][])("refuses %j as not dispatched", (action) => {
    expect(() => planX11Action(action, guest)).toThrow(
      expect.objectContaining({ code: "action_rejected", disposition: "not_dispatched" }),
    );
  });
});

describe("the hosted dialect", () => {
  it("guards a left click's move with a pointer read", () => {
    expect(planX11Action({ kind: "click", x: 5, y: 6 }, HOSTED_X11_DIALECT).steps).toEqual([
      { kind: "read-pointer", at: { x: 5, y: 6 } },
      { kind: "xdotool", args: ["mousemove", "--sync", "5", "6"], unlessPointerThere: true },
      { kind: "xdotool", args: ["click", "1"] },
    ]);
  });

  it("reads the pointer but never moves for a click at y 0", () => {
    expect(planX11Action({ kind: "double_click", x: 5, y: 0 }, HOSTED_X11_DIALECT).steps).toEqual([
      { kind: "read-pointer", at: { x: 5, y: 0 } },
      { kind: "xdotool", args: ["click", "--repeat", "2", "1"] },
    ]);
  });

  it.each([
    [49, "1"],
    [50, "1"],
    [149, "1"],
    [150, "2"],
  ])("rounds %j pixels of scroll to %j steps, sending at least one", (dy, steps) => {
    const plan = planX11Action({ kind: "scroll", x: 1, y: 1, dx: 0, dy }, HOSTED_X11_DIALECT);
    expect(plan.steps.at(-1)).toEqual({
      kind: "xdotool",
      args: ["click", "--repeat", steps, "5"],
    });
  });

  it("passes out-of-frame and fractional points to xdotool as given", () => {
    expect(planX11Action({ kind: "move", x: -3, y: 1e21 }, HOSTED_X11_DIALECT)).toEqual(
      commands(["mousemove", "--sync", "-3", "1e+21"]),
    );
  });
});
