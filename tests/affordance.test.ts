import { describe, expect, it } from "vitest";

// #369: the harness records WHICH KIND of route an actor took, and states no verdict about it.
// The field defect that motivated this: a computer-use actor in a human-persona study typed a
// `javascript:` URL into the address bar, routed around the friction the study measured, and the
// run came back green with nothing in the evidence saying so.
//
// The load-bearing distinction these tests pin: direct URL navigation is a HUMAN affordance
// (`load(url)` appears in 99.4% of 2,337 real human web demonstrations — WebLINX), so it must
// never be lumped with script execution. Getting that wrong would make a human-declared lane look
// unfaithful for behaving normally.
import {
  AFFORDANCE_CLASS_SCHEMA,
  classifyCuaAction,
  summarizeAffordanceUse,
  SHORTCUT_AFFORDANCE_CLASSES,
  NATURALISTIC_AFFORDANCE_CLASSES
} from "../src/affordance.js";
import type { CuaAction } from "../src/computer-use.js";

const classOf = (action: CuaAction) => classifyCuaAction(action).affordance;

describe("affordance classification (#369)", () => {
  it("classifies the naturalistic core: pointer, keyboard, observation", () => {
    expect(classOf({ kind: "click", x: 10, y: 20 })).toBe("pointer");
    expect(classOf({ kind: "double_click", x: 1, y: 2 })).toBe("pointer");
    expect(classOf({ kind: "scroll", x: 0, y: 0, dx: 0, dy: 120 })).toBe("pointer");
    expect(classOf({ kind: "drag", path: [{ x: 0, y: 0 }, { x: 5, y: 5 }] })).toBe("pointer");
    expect(classOf({ kind: "type", text: "hello@example.test" })).toBe("keyboard");
    expect(classOf({ kind: "keypress", keys: ["Enter"] })).toBe("keyboard");
    // Observing is not acting: a bare move, a wait, and a screenshot actuate nothing.
    expect(classOf({ kind: "move", x: 3, y: 4 })).toBe("observation");
    expect(classOf({ kind: "wait", ms: 500 })).toBe("observation");
    expect(classOf({ kind: "screenshot" })).toBe("observation");
  });

  it("treats direct URL navigation as HUMAN, separate from script execution", () => {
    // The empirical point: people type URLs. Classifying this as a shortcut would make an
    // ordinary human lane look unfaithful.
    expect(classOf({ kind: "type", text: "https://example.test/pricing" })).toBe("url-navigation");
    expect(classOf({ kind: "type", text: "http://127.0.0.1:3000/" })).toBe("url-navigation");
    expect(classOf({ kind: "type", text: "example.test/docs" })).toBe("url-navigation");
    expect(classOf({ kind: "type", text: "www.example.test" })).toBe("url-navigation");
    expect(NATURALISTIC_AFFORDANCE_CLASSES).toContain("url-navigation");
    expect(SHORTCUT_AFFORDANCE_CLASSES).not.toContain("url-navigation");
  });

  it("catches the field defect: a javascript: URL is script execution, whatever its casing or padding", () => {
    expect(classOf({ kind: "type", text: "javascript:document.querySelector('#next').click()" })).toBe("script-execution");
    expect(classOf({ kind: "type", text: "  JavaScript:void(0)" })).toBe("script-execution");
    // A data: URL can carry executable HTML, so it rides with javascript:.
    expect(classOf({ kind: "type", text: "data:text/html,<script>alert(1)</script>" })).toBe("script-execution");
  });

  it("classifies devtools chords and browser-internal surfaces as shortcuts, not as product use", () => {
    expect(classOf({ kind: "keypress", keys: ["F12"] })).toBe("devtools");
    expect(classOf({ kind: "keypress", keys: ["Control", "Shift", "J"] })).toBe("devtools");
    expect(classOf({ kind: "keypress", keys: ["cmd", "alt", "i"] })).toBe("devtools");
    expect(classOf({ kind: "type", text: "chrome://settings" })).toBe("browser-internal");
    expect(classOf({ kind: "type", text: "view-source:https://example.test" })).toBe("browser-internal");
    expect(classOf({ kind: "type", text: "about:blank" })).toBe("browser-internal");
    for (const klass of ["script-execution", "devtools", "browser-internal"] as const) {
      expect(SHORTCUT_AFFORDANCE_CLASSES).toContain(klass);
    }
  });

  it("never returns the typed text — only a scheme-shaped signal (the class must be public-safe)", () => {
    const secretish = "javascript:fetch('/api?token=SUPER-SECRET-VALUE')";
    const observation = classifyCuaAction({ kind: "type", text: secretish });
    expect(observation.affordance).toBe("script-execution");
    expect(observation.signal).toBe("javascript:");
    expect(JSON.stringify(observation)).not.toContain("SUPER-SECRET-VALUE");

    // Same for a URL carrying a session token in its path/query.
    const tokenUrl = classifyCuaAction({ kind: "type", text: "https://example.test/verify?token=abc123SECRET" });
    expect(tokenUrl.affordance).toBe("url-navigation");
    expect(JSON.stringify(tokenUrl)).not.toContain("abc123SECRET");

    // And plain typed text (a password into a form) never leaks through the keyboard class.
    const typed = classifyCuaAction({ kind: "type", text: "hunter2-not-a-url" });
    expect(typed.affordance).toBe("keyboard");
    expect(JSON.stringify(typed)).not.toContain("hunter2");
  });

  it("summarizes per-class counts with a shortcut roll-up, omitting classes that never happened", () => {
    const summary = summarizeAffordanceUse([
      { affordance: "pointer" },
      { affordance: "pointer" },
      { affordance: "keyboard" },
      { affordance: "url-navigation" },
      { affordance: "script-execution", signal: "javascript:" }
    ]);
    expect(summary.schema).toBe(AFFORDANCE_CLASS_SCHEMA);
    expect(summary.total).toBe(5);
    expect(summary.counts).toEqual({ pointer: 2, keyboard: 1, "url-navigation": 1, "script-execution": 1 });
    // Absent classes are omitted rather than written as 0 — the record stays small and says only
    // what happened.
    expect(summary.counts).not.toHaveProperty("devtools");
    expect(summary.shortcutTotal).toBe(1);
  });

  it("a clean run reports shortcutTotal 0 — a meaningful value, not an absence", () => {
    const summary = summarizeAffordanceUse([
      { affordance: "pointer" },
      { affordance: "url-navigation" },
      { affordance: "observation" }
    ]);
    expect(summary.shortcutTotal).toBe(0);
    expect(summary.total).toBe(3);
  });
});
