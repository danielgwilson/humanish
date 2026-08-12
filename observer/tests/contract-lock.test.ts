import { expect, it } from "vitest";

// Value import of the producer is fine here (tests run in Node); the APP must never
// do this — lib/observer-data.ts is type-only so no CLI code reaches the artifact.
import { OBSERVER_DATA_SCHEMA as PRODUCER_SCHEMA } from "../../src/observer-data";
import { OBSERVER_DATA_PLACEHOLDER, OBSERVER_DATA_SCHEMA } from "../lib/data";
import { OBSERVER_DATA_PLACEHOLDER as INJECTOR_PLACEHOLDER } from "../scripts/inject";

it("the app's schema id matches the producer's frozen contract", () => {
  expect(OBSERVER_DATA_SCHEMA).toBe(PRODUCER_SCHEMA);
});

it("the app's slot marker matches the injector's", () => {
  expect(OBSERVER_DATA_PLACEHOLDER).toBe(INJECTOR_PLACEHOLDER);
});
