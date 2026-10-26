import { describe, expect, it } from "vitest";

import type { CuaAction } from "../../../src/actors/computer-use/loop.js";
import { normalizeWire, wireDesktop, type SubstrateName } from "./desktop-wire.js";

// One table of actions run on every X11 desktop, asserting the exact native calls each sends. The
// expected lines were captured from the executors before they shared a translator, so any change
// here is a change in what a desktop receives.
//
// E2B and Modal send the same commands (Modal's desktop follows @e2b/desktop command for command),
// except for `wait`, which E2B runs as `sleep` in the sandbox and Modal as a timer on the host.

const KEY_OPTIONS = '{"requestTimeoutMs":15000,"timeoutMs":15000}';
const key = (command: string) => `xdotool ${command} ${KEY_OPTIONS}`;
const REFUSED = "refused before dispatch";

type Expected = readonly string[] | typeof REFUSED;

interface Row {
  readonly name: string;
  readonly action: CuaAction;
  /** Where the pointer reads before the action; elsewhere by default. */
  readonly pointer?: { x: number; y: number };
  readonly hosted: Expected;
  readonly guest: Expected;
  readonly e2b?: Expected;
  readonly modal?: Expected;
}

const TYPE_DIRECTORY =
  'umask 077 && d=$(mktemp -d /tmp/humanish-type-XXXXXXXX) && : > "$d/text" && printf \'%s\' "$d"';
const typeCommand = (timeoutMs: number) =>
  `DISPLAY="\${DISPLAY:-:0}" LC_ALL=C.UTF-8 xdotool type --delay 75 --file '/tmp/humanish-type-T1/text' {"requestTimeoutMs":${timeoutMs},"timeoutMs":${timeoutMs}}`;
const REMOVE_TYPE_DIRECTORY = `rm -rf -- '/tmp/humanish-type-T1' ${KEY_OPTIONS}`;

const ROWS: readonly Row[] = [
  {
    name: "a left click moves, then clicks",
    action: { kind: "click", x: 10, y: 20 },
    hosted: ["xdotool getmouselocation", "xdotool mousemove --sync 10 20", "xdotool click 1"],
    guest: ["input mousemove 10 20", "input click 1"],
  },
  {
    name: "a left click where the pointer already is skips the hosted move",
    action: { kind: "click", x: 10, y: 20 },
    pointer: { x: 10, y: 20 },
    hosted: ["xdotool getmouselocation", "xdotool click 1"],
    guest: ["input mousemove 10 20", "input click 1"],
  },
  {
    name: "a right click holding shift presses it around the click",
    action: { kind: "click", x: 10, y: 20, button: "right", heldKeys: ["shift"] },
    hosted: [
      key("keydown shift"),
      "xdotool mousemove --sync 10 20",
      "xdotool click 3",
      key("keyup shift"),
    ],
    guest: ["input keydown shift", "input mousemove 10 20", "input click 3", "input keyup shift"],
  },
  {
    name: "a middle click reads no pointer",
    action: { kind: "click", x: 10, y: 20, button: "middle" },
    hosted: ["xdotool mousemove --sync 10 20", "xdotool click 2"],
    guest: ["input mousemove 10 20", "input click 2"],
  },
  {
    name: "a fractional click reaches hosted xdotool as given and rounds on the guest",
    action: { kind: "click", x: 10.6, y: 20.4 },
    hosted: ["xdotool mousemove --sync 10.6 20.4", "xdotool click 1"],
    guest: ["input mousemove 11 20", "input click 1"],
  },
  {
    name: "a click at x 0 clicks in place on hosted desktops",
    action: { kind: "click", x: 0, y: 20 },
    hosted: ["xdotool getmouselocation", "xdotool click 1"],
    guest: ["input mousemove 0 20", "input click 1"],
  },
  {
    name: "a click outside the frame is refused on the guest only",
    action: { kind: "click", x: 1440, y: 20 },
    hosted: ["xdotool getmouselocation", "xdotool mousemove --sync 1440 20", "xdotool click 1"],
    guest: REFUSED,
  },
  {
    name: "a double click repeats the left button",
    action: { kind: "double_click", x: 30, y: 40 },
    hosted: [
      "xdotool getmouselocation",
      "xdotool mousemove --sync 30 40",
      "xdotool click --repeat 2 1",
    ],
    guest: ["input mousemove 30 40", "input click --repeat 2 --delay 100 1"],
  },
  {
    name: "a move moves",
    action: { kind: "move", x: 50, y: 60 },
    hosted: ["xdotool mousemove --sync 50 60"],
    guest: ["input mousemove 50 60"],
  },
  {
    name: "a move holding two modifiers presses them as one chord",
    action: { kind: "move", x: 50, y: 60, heldKeys: ["ctrl", "alt"] },
    hosted: [key("keydown ctrl+alt"), "xdotool mousemove --sync 50 60", key("keyup ctrl+alt")],
    guest: ["input keydown ctrl+alt", "input mousemove 50 60", "input keyup ctrl+alt"],
  },
  {
    name: "a scroll down turns pixels into wheel steps",
    action: { kind: "scroll", x: 100, y: 200, dx: 0, dy: 250 },
    hosted: ["xdotool mousemove --sync 100 200", "xdotool click --repeat 3 5"],
    guest: ["input mousemove 100 200", "input click 5", "input click 5", "input click 5"],
  },
  {
    name: "a small scroll up still sends one wheel step",
    action: { kind: "scroll", x: 100, y: 200, dx: 0, dy: -30 },
    hosted: ["xdotool mousemove --sync 100 200", "xdotool click --repeat 1 4"],
    guest: ["input mousemove 100 200", "input click 4"],
  },
  {
    name: "a horizontal scroll reaches only the guest",
    action: { kind: "scroll", x: 100, y: 200, dx: 240, dy: 0 },
    hosted: [],
    guest: ["input mousemove 100 200", "input click 7", "input click 7"],
  },
  {
    name: "a diagonal scroll sends its horizontal steps first on the guest",
    action: { kind: "scroll", x: 100, y: 200, dx: -120, dy: 120 },
    hosted: ["xdotool mousemove --sync 100 200", "xdotool click --repeat 1 5"],
    guest: ["input mousemove 100 200", "input click 6", "input click 5"],
  },
  {
    name: "a zero scroll holding shift presses nothing",
    action: { kind: "scroll", x: 1, y: 2, dx: 0, dy: 0, heldKeys: ["shift"] },
    hosted: [],
    guest: [],
  },
  {
    name: "a drag follows the whole path on the guest and its endpoints on hosted desktops",
    action: {
      kind: "drag",
      path: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    },
    hosted: [
      "xdotool mousemove --sync 1 2",
      "xdotool mousedown 1",
      "xdotool mousemove --sync 5 6",
      "xdotool mouseup 1",
    ],
    guest: [
      "input mousemove 1 2",
      "input mousedown 1",
      "input mousemove 3 4",
      "input mousemove 5 6",
      "input mouseup 1",
    ],
  },
  {
    name: "a one-point drag does nothing on hosted desktops and is refused on the guest",
    action: { kind: "drag", path: [{ x: 1, y: 2 }] },
    hosted: [],
    guest: REFUSED,
  },
  {
    name: "a drag holding shift presses it around the whole drag",
    action: {
      kind: "drag",
      path: [
        { x: 1, y: 2 },
        { x: 5, y: 6 },
      ],
      heldKeys: ["shift"],
    },
    hosted: [
      key("keydown shift"),
      "xdotool mousemove --sync 1 2",
      "xdotool mousedown 1",
      "xdotool mousemove --sync 5 6",
      "xdotool mouseup 1",
      key("keyup shift"),
    ],
    guest: [
      "input keydown shift",
      "input mousemove 1 2",
      "input mousedown 1",
      "input mousemove 5 6",
      "input mouseup 1",
      "input keyup shift",
    ],
  },
  {
    name: "text is typed from a private file on hosted desktops and pasted on the guest",
    action: { kind: "type", text: "héllo" },
    hosted: [
      `${TYPE_DIRECTORY} ${KEY_OPTIONS}`,
      "files.write /tmp/humanish-type-T1/text héllo",
      typeCommand(15_375),
      REMOVE_TYPE_DIRECTORY,
    ],
    guest: ["prepareText héllo", "paste", "close"],
  },
  {
    name: "empty text still runs the hosted typing commands and sends nothing on the guest",
    action: { kind: "type", text: "" },
    hosted: [
      `${TYPE_DIRECTORY} ${KEY_OPTIONS}`,
      "files.write /tmp/humanish-type-T1/text ",
      typeCommand(15_000),
      REMOVE_TYPE_DIRECTORY,
    ],
    guest: [],
  },
  {
    name: "a keypress sends one chord with modifiers cleared",
    action: { kind: "keypress", keys: ["ctrl", "l"] },
    hosted: [key("key --clearmodifiers ctrl+l")],
    guest: ["input key --clearmodifiers ctrl+l"],
  },
  {
    name: "a key name that is itself a chord is split",
    action: { kind: "keypress", keys: ["Control+Shift+t"] },
    hosted: [key("key --clearmodifiers ctrl+shift+t")],
    guest: ["input key --clearmodifiers ctrl+shift+t"],
  },
  {
    name: "an unknown key name is refused",
    action: { kind: "keypress", keys: ["nonsense"] },
    hosted: REFUSED,
    guest: REFUSED,
  },
  {
    name: "a held key that is not a modifier is refused",
    action: { kind: "click", x: 10, y: 20, heldKeys: ["a"] },
    hosted: REFUSED,
    guest: REFUSED,
  },
  {
    name: "a wait sleeps in the E2B sandbox and on the host elsewhere",
    action: { kind: "wait", ms: 250 },
    hosted: [],
    e2b: ["sleep 0.25"],
    modal: [],
    guest: [],
  },
  {
    name: "a screenshot action sends nothing, since observe captures",
    action: { kind: "screenshot" },
    hosted: [],
    guest: [],
  },
  {
    name: "speech is refused",
    action: { kind: "speak", text: "hello" },
    hosted: REFUSED,
    guest: REFUSED,
  },
];

const SUBSTRATES: readonly SubstrateName[] = ["e2b", "modal", "guest"];

function expectedFor(row: Row, substrate: SubstrateName): Expected {
  if (substrate === "guest") return row.guest;
  return row[substrate] ?? row.hosted;
}

describe("every X11 desktop sends the native calls it sent before the shared translator", () => {
  const cases = ROWS.flatMap((row) =>
    SUBSTRATES.map((substrate) => ({ ...row, substrate, expected: expectedFor(row, substrate) })),
  );
  it.each(cases)("$substrate: $name", async ({ substrate, action, pointer, expected }) => {
    const desktop = wireDesktop(substrate);
    if (pointer) Object.assign(desktop.pointer, pointer);
    const execution = desktop.executor.execute(action);
    if (expected === REFUSED) {
      await expect(execution).rejects.toMatchObject({
        code: "action_rejected",
        disposition: "not_dispatched",
      });
      expect(desktop.wire).toEqual([]);
    } else {
      await execution;
      expect(desktop.wire).toEqual(expected);
    }
  });

  it.each([
    ["e2b", ["scrot --pointer <shot>", "files.read <shot>", "files.remove <shot>"]],
    ["modal", ["scrot --pointer <shot>", "readBytes <shot>", "rm -f <shot>"]],
    ["guest", ["capture"]],
  ] as const)("%s: observe captures one frame", async (substrate, expected) => {
    const desktop = wireDesktop(substrate);
    await desktop.executor.observe();
    // The hosted desktops remove the frame file without waiting for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(normalizeWire(desktop.wire)).toEqual(expected);
  });
});

describe("a failed native call ends each desktop's action as it did before", () => {
  const heldClick: CuaAction = {
    kind: "click",
    x: 10,
    y: 20,
    button: "right",
    heldKeys: ["shift"],
  };

  it.each(["e2b", "modal"] as const)(
    "%s: a failed click still releases the held key and reports the click's exit",
    async (substrate) => {
      const desktop = wireDesktop(substrate);
      desktop.failNext(/^xdotool click/, { throws: 1 });
      await expect(desktop.executor.execute(heldClick)).rejects.toMatchObject({ exitCode: 1 });
      expect(desktop.wire).toEqual([
        key("keydown shift"),
        "xdotool mousemove --sync 10 20",
        "xdotool click 3",
        key("keyup shift"),
      ]);
    },
  );

  it("guest: a failed click releases the held key and ends the session", async () => {
    const desktop = wireDesktop("guest");
    desktop.failNext(/^click/, { throws: 1 });
    await expect(desktop.executor.execute(heldClick)).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(desktop.wire).toEqual([
      "input keydown shift",
      "input mousemove 10 20",
      "input click 3",
      "input keyup shift",
      "terminal",
    ]);
  });

  it.each(["e2b", "modal"] as const)(
    "%s: a failed keydown is still released and reports the keydown's exit",
    async (substrate) => {
      const desktop = wireDesktop(substrate);
      desktop.failNext(/^xdotool keydown/, { throws: 2 });
      await expect(desktop.executor.execute(heldClick)).rejects.toMatchObject({ exitCode: 2 });
      expect(desktop.wire).toEqual([key("keydown shift"), key("keyup shift")]);
    },
  );

  it.each(["e2b", "modal"] as const)(
    "%s: a failed release ends the action with an uncertain outcome",
    async (substrate) => {
      const desktop = wireDesktop(substrate);
      desktop.failNext(/^xdotool keyup/, { throws: 1 });
      await expect(desktop.executor.execute(heldClick)).rejects.toMatchObject({
        code: "execution_failed",
        disposition: "outcome_uncertain",
      });
    },
  );

  it("guest: a failed release is not retried and ends the session", async () => {
    const desktop = wireDesktop("guest");
    desktop.failNext(/^keyup/, { throws: 1 });
    await expect(desktop.executor.execute(heldClick)).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(desktop.wire.filter((line) => line.includes("keyup"))).toHaveLength(1);
    expect(desktop.wire.at(-1)).toBe("terminal");
  });

  it.each(["e2b", "modal"] as const)(
    "%s: a key name xdotool skipped with exit 0 fails the keypress",
    async (substrate) => {
      const desktop = wireDesktop(substrate);
      desktop.failNext(/^xdotool key /, { returns: 0, stderr: "(symbol) No such key name 'x'" });
      await expect(
        desktop.executor.execute({ kind: "keypress", keys: ["Return"] }),
      ).rejects.toMatchObject({ name: "ComputerUseKeyError", exitCode: 0 });
    },
  );

  it.each(["e2b", "modal"] as const)(
    "%s: a failed type command names its phase and still removes the text file",
    async (substrate) => {
      const desktop = wireDesktop(substrate);
      desktop.failNext(/xdotool type/, { throws: 1 });
      await expect(desktop.executor.execute({ kind: "type", text: "hi" })).rejects.toMatchObject({
        name: "ComputerUseTypeError",
        phase: "text-command",
        exitCode: 1,
      });
      expect(desktop.wire.at(-1)).toBe(REMOVE_TYPE_DIRECTORY);
    },
  );
});
