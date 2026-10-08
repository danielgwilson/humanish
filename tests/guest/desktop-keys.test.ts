// The key table both xdotool desktops (the local guest and the hosted E2B desktop) translate
// through. Expected names are X11 keysym names; `question` and `shift+slash` are the forms an E2B
// desktop was seen to deliver as `?` on 2026-10-08.

import { describe, expect, it } from "vitest";
import { ComputerUseExecutorError } from "../../src/actors/computer-use/executor-error.js";
import { xdotoolChord } from "../../src/guest/desktop-keys.js";

function refusal(keys: readonly string[]): unknown {
  try {
    xdotoolChord(keys);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("xdotoolChord", () => {
  it.each([
    [["ARROWDOWN"], "Down"],
    [["ARROWUP"], "Up"],
    [["ARROWLEFT"], "Left"],
    [["ARROWRIGHT"], "Right"],
    [["PAGEDOWN"], "Next"],
    [["PAGEUP"], "Prior"],
    [["HOME"], "Home"],
    [["END"], "End"],
    [["TAB"], "Tab"],
    [["ESC"], "Escape"],
    [["ENTER"], "Return"],
    [["BACKSPACE"], "BackSpace"],
    [["DELETE"], "Delete"],
    [["DEL"], "Delete"],
    [["SPACE"], "space"],
    [["J"], "j"],
    [["CTRL", "A"], "ctrl+a"],
    [["SHIFT", "TAB"], "shift+Tab"],
    [["?"], "question"],
    [["SHIFT", "/"], "shift+slash"],
    [["!"], "exclam"],
    [["ALT", "LEFT"], "alt+Left"],
    [["ALT", "ArrowLeft"], "alt+Left"],
    [["CONTROL", "SHIFT", "l"], "ctrl+shift+l"],
    [["OPTION", "COMMAND", "q"], "alt+super+q"],
  ])("maps %j to %s", (keys, chord) => {
    expect(xdotoolChord(keys)).toBe(chord);
  });

  it("maps F1 to F12 in either case", () => {
    expect(
      ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "f12"].map((key) =>
        xdotoolChord([key]),
      ),
    ).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);
  });

  it("maps every printable ASCII punctuation character to its keysym", () => {
    const characters = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    expect([...characters].map((character) => xdotoolChord([character]))).toEqual([
      "exclam",
      "quotedbl",
      "numbersign",
      "dollar",
      "percent",
      "ampersand",
      "apostrophe",
      "parenleft",
      "parenright",
      "asterisk",
      "plus",
      "comma",
      "minus",
      "period",
      "slash",
      "colon",
      "semicolon",
      "less",
      "equal",
      "greater",
      "question",
      "at",
      "bracketleft",
      "backslash",
      "bracketright",
      "asciicircum",
      "underscore",
      "grave",
      "braceleft",
      "bar",
      "braceright",
      "asciitilde",
    ]);
  });

  it.each([
    [["page_down"], "Next"],
    [["caps_lock"], "Caps_Lock"],
    [["control_left", "shift_right", "x"], "Control_L+Shift_R+x"],
    [["win"], "super"],
    [["menu"], "Menu"],
  ])("keeps the @e2b/desktop press() name %j working as %s", (keys, chord) => {
    expect(xdotoolChord(keys)).toBe(chord);
  });

  it.each([
    [["Control+a"], "ctrl+a"],
    [["SHIFT+/"], "shift+slash"],
    [["ctrl++"], "ctrl+plus"],
    [["+"], "plus"],
  ])("splits the single name %j at its plus signs", (keys, chord) => {
    expect(xdotoolChord(keys)).toBe(chord);
  });

  it.each([
    ["an unknown name", ["ARROW_DOWN"]],
    ["an X11 name outside the table", ["Hyper_L"]],
    ["a non-ASCII character", ["é"]],
    ["an empty name", [""]],
    ["a name with a trailing plus", ["ctrl+"]],
    ["a name with a leading plus", ["+a"]],
    ["a repeated key", ["CTRL", "Control", "a"]],
    ["a repeated key inside a joined name", ["ctrl", "ctrl+a"]],
  ])("refuses %s before dispatch", (_label, keys) => {
    const error = refusal(keys);
    expect(error).toBeInstanceOf(ComputerUseExecutorError);
    expect(error).toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
  });
});
