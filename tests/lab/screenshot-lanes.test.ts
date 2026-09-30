// The computer-use and scripted-browser lanes record the participant's screenshots as evidence.
// An actor that declares `producesScreenshots: false` must not resolve to either lane: it would
// report a GUI flow it only reached through a shell.
import { afterEach, describe, expect, it } from "vitest";

import { actorRegistry, type ActorDescriptor } from "../../src/actors/registry.js";
import {
  actorResolvesToComputerUse,
  actorResolvesToScriptedBrowser,
  registeredComputerUseActors,
  registeredScriptedBrowserActors,
} from "../../src/lab/routing.js";

const registry = actorRegistry as Record<string, ActorDescriptor>;
const TEST_ID = "test-screenless-actor";

function register(base: ActorDescriptor, producesScreenshots: boolean): void {
  registry[TEST_ID] = {
    ...base,
    id: TEST_ID,
    capabilities: { ...base.capabilities, producesScreenshots },
  } as unknown as ActorDescriptor;
}

afterEach(() => {
  delete registry[TEST_ID];
});

describe("screenshot lanes take only actors that produce screenshots", () => {
  it("every registered actor on a screenshot lane declares producesScreenshots", () => {
    const onScreenshotLanes = Object.values(actorRegistry).filter(
      (descriptor) =>
        descriptor.capabilities.lanes.includes("computer-use") ||
        descriptor.capabilities.lanes.includes("scripted-browser"),
    );
    expect(onScreenshotLanes.length).toBeGreaterThan(0);
    expect(
      onScreenshotLanes
        .filter((descriptor) => !descriptor.capabilities.producesScreenshots)
        .map((descriptor) => descriptor.id),
    ).toEqual([]);
  });

  it("does not route a computer-use descriptor that declares no screenshots", () => {
    register(actorRegistry["openai-computer-use"], false);
    expect(actorResolvesToComputerUse(TEST_ID)).toBe(false);
    expect(registeredComputerUseActors()).not.toContain(TEST_ID);
    register(actorRegistry["openai-computer-use"], true);
    expect(actorResolvesToComputerUse(TEST_ID)).toBe(true);
    expect(registeredComputerUseActors()).toContain(TEST_ID);
  });

  it("does not route a scripted-browser descriptor that declares no screenshots", () => {
    register(actorRegistry["scripted-browser"], false);
    expect(actorResolvesToScriptedBrowser(TEST_ID)).toBe(false);
    expect(registeredScriptedBrowserActors()).not.toContain(TEST_ID);
  });
});
