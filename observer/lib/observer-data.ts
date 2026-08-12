// Type-only bridge to the frozen humanish.observer-data.v1 contract (#426, frozen by
// #429). The producer is src/observer-data.ts at the repo root; importing the TYPES
// from it keeps one source of truth with zero runtime coupling — no CLI code is ever
// bundled into the artifact (tests/contract-lock.test.ts proves the schema id matches,
// and the artifact smoke test proves the bundle stays self-contained).
export type {
  ObserverArtifactLink,
  ObserverData,
  ObserverLaneGroup,
  ObserverStream
} from "../../src/observer-data.js";
