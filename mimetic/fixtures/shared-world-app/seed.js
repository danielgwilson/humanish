// Seed the synthetic shared task board with a few generic starter tasks (#164). Runs ONCE
// before the server starts (subject.state.seed, when: before-start). Public-safe: generic,
// synthetic content only — no real names, domains, or sensitive data.

import { writeStore } from "./store.js";

const starters = [
  { id: 1, text: "Draft the weekly update", by: "seed" },
  { id: 2, text: "Review the open tasks", by: "seed" },
  { id: 3, text: "Plan the next sprint", by: "seed" }
];

writeStore({ tasks: starters });
// eslint-disable-next-line no-console
console.log(`seeded ${starters.length} tasks`);
