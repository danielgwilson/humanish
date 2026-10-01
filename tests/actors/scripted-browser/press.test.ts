// The scripted actor's `press` step sends its key. The 0.106.1 live pass ran a TodoMVC scenario
// whose step 3 pressed Enter in the new-todo input; the actor clicked the input instead, and the
// run ended at "step-03-add: Visible page state did not change". This replays that scenario on an
// in-memory TodoMVC where only Enter adds the typed todo.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorPersonaRef } from "../../../src/actors/contract.js";
import { runScriptedBrowserSession } from "../../../src/actors/scripted-browser/actor.js";
import { parseBrowserPersonaJourneyFromScenario } from "../../../src/actors/scripted-browser/journey.js";
import {
  browserSurfaces,
  type ScriptedBrowserLike,
  type ScriptedLocatorLike,
  type ScriptedPageLike,
} from "../../../src/actors/scripted-browser/types.js";
import { syntheticPng1x1 } from "../../image-fixtures.js";
import { evaluatePagePredicate } from "../../helpers/scripted-page-predicate.js";

const PNG_1X1 = syntheticPng1x1();
const NEW_TODO = "input.new-todo";
const TODO = "Buy synthetic milk";

/** The live pass's first scripted-clone scenario, step for step. */
function todoScenario(step3: Record<string, unknown>) {
  return {
    schema: "humanish.scenario.v1",
    id: "todomvc-add",
    title: "Add one todo",
    goal: "Load TodoMVC, add a todo, and see it listed.",
    browser: {
      startPath: "/",
      steps: [
        {
          id: "step-01-load",
          label: "Load TodoMVC",
          action: "goto",
          path: "/",
          expect: { selectorVisible: NEW_TODO },
        },
        {
          id: "step-02-type",
          label: "Type a todo",
          action: "type",
          selector: NEW_TODO,
          value: TODO,
        },
        { id: "step-03-add", label: "Add it", ...step3 },
        {
          id: "step-04-listed",
          label: "See it listed",
          action: "waitForText",
          expect: { text: TODO },
        },
      ],
    },
  };
}

const parse = (raw: unknown) =>
  parseBrowserPersonaJourneyFromScenario({
    raw,
    relativePath: "humanish/scenarios/todomvc-add.yaml",
    sourceDigest: "synthetic-digest",
  });

/** TodoMVC in memory: Enter in the new-todo input lists what was typed; a click changes nothing. */
function todoMvc(): { browser: ScriptedBrowserLike; pressed: string[] } {
  const state = { url: "about:blank", body: "todos", input: "", focused: "" };
  const pressed: string[] = [];
  const pressKey = (selector: string, key: string) => {
    pressed.push(`${selector} ${key}`);
    if (selector === NEW_TODO && key === "Enter" && state.input) {
      state.body = `${state.body} ${state.input}`;
      state.input = "";
    }
  };
  const locatorFor = (selector: string): ScriptedLocatorLike => {
    const locator: ScriptedLocatorLike = {
      first: () => locator,
      fill: async (value) => {
        if (selector === NEW_TODO) state.input = value;
        state.focused = selector;
      },
      click: async () => {
        state.focused = selector;
      },
      press: async (key) => {
        state.focused = selector;
        pressKey(selector, key);
      },
      count: async () => 1,
      waitFor: async () => undefined,
      isVisible: async () => true,
    };
    return locator;
  };
  const page: ScriptedPageLike = {
    goto: async (url) => {
      state.url = url;
      return undefined;
    },
    locator: locatorFor,
    keyboard: {
      press: async (key) => {
        pressKey(state.focused, key);
      },
    },
    waitForTimeout: async () => undefined,
    waitForFunction: async (expression) => {
      if (evaluatePagePredicate(expression, state.body)) return undefined;
      throw new Error(`Timeout waiting for ${expression}`);
    },
    screenshot: async ({ path: screenshotPath }) => {
      if (screenshotPath) await writeFile(screenshotPath, PNG_1X1);
      return PNG_1X1;
    },
    url: () => state.url,
    evaluate: async <T>() => state.body as unknown as T,
  };
  return {
    browser: { newContext: async () => ({ newPage: async () => page }), close: async () => {} },
    pressed,
  };
}

const persona: ActorPersonaRef = {
  id: "scripted-journey",
  traitsApplied: [],
  promptDigest: "abcd1234abcd1234",
};

let artifactRoot: string;
beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "humanish-scripted-press-"));
});
afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

async function runTodoScenario(step3: Record<string, unknown>) {
  const parsed = parse(todoScenario(step3));
  if (!parsed.journey) throw new Error(parsed.failure ?? "no journey");
  const app = todoMvc();
  const result = await runScriptedBrowserSession({
    appUrl: "http://127.0.0.1:3000/",
    journey: parsed.journey,
    surface: browserSurfaces[0]!,
    persona,
    timeoutMs: 10_000,
    artifactRoot,
    launchBrowser: async () => app.browser,
  });
  return { parsed, result, pressed: app.pressed };
}

describe("scripted press step", () => {
  it("keeps a press step's key when the scenario is parsed", () => {
    const parsed = parse(
      todoScenario({
        action: "press",
        selector: NEW_TODO,
        key: "Enter",
        expect: { stateChanged: true },
      }),
    );
    expect(parsed.failure).toBeUndefined();
    expect(parsed.journey?.steps[2]).toEqual({
      action: "press",
      expectation: { stateChanged: true },
      id: "step-03-add",
      key: "Enter",
      label: "Add it",
      selector: NEW_TODO,
    });
  });

  it("presses Enter in the new-todo input, and the todo is listed", async () => {
    const { result, pressed } = await runTodoScenario({
      action: "press",
      selector: NEW_TODO,
      key: "Enter",
      expect: { stateChanged: true },
    });
    expect(
      result.capture.steps.map((step) => [step.id, step.action, step.status, step.reason]),
    ).toEqual([
      ["step-01-load", "goto", "passed", "goto completed for Load TodoMVC."],
      ["step-02-type", "fill", "passed", "fill completed for Type a todo."],
      ["step-03-add", "press", "passed", "press completed for Add it."],
      ["step-04-listed", "waitForText", "passed", "waitForText completed for See it listed."],
    ]);
    expect(pressed).toEqual([`${NEW_TODO} Enter`]);
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("presses the key on the focused element when the step names no selector", async () => {
    const { result, pressed } = await runTodoScenario({
      action: "press",
      key: "Enter",
      expect: { stateChanged: true },
    });
    expect(pressed).toEqual([`${NEW_TODO} Enter`]);
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("refuses a press step without a key, and a key on any other step", () => {
    expect(parse(todoScenario({ action: "press", selector: NEW_TODO })).failure).toBe(
      "humanish/scenarios/todomvc-add.yaml: step-03-add press action requires key (for example Enter).",
    );
    expect(parse(todoScenario({ action: "click", selector: NEW_TODO, key: "Enter" })).failure).toBe(
      "humanish/scenarios/todomvc-add.yaml: step-03-add sets key, which only a press step sends. Supported actions: goto, fill, click, press, assertText, waitForText, waitForSelector.",
    );
  });
});
