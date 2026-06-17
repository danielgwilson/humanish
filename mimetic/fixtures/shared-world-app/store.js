// File-backed SHARED store for the synthetic shared-world task board (#164).
//
// The store is a JSON file (not in-memory) ON PURPOSE: the concurrent shared-world route mutates
// it from the long-lived server process AND reads an aggregate from a SEPARATE checkpoint probe
// process (run detached by the harness). A file is the smallest thing visible to both. Pure Node
// built-ins (no dependencies). Public-safe: generic synthetic content only.
//
// CONTENTION NOTE: read-modify-write on a JSON file races under concurrent POSTs (lost updates are
// possible). That is acceptable and even illustrative for this topology — the shared-world doctrine
// OBSERVES contention (the `contention-observed-not-proven-safe` attribution limit) rather than
// proving the store race-free. The checkpoint count growing across the run is the delta signal.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// One stable path shared by the server, the seed script, and the checkpoint probe.
const DB_PATH = process.env.SHARED_WORLD_DB || path.join(os.tmpdir(), "shared-world-app", "tasks.json");

export function dbPath() {
  return DB_PATH;
}

export function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, "utf8"));
    return Array.isArray(parsed?.tasks) ? parsed : { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

export function writeStore(store) {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(store));
}

export function addTask({ text, by }) {
  const store = readStore();
  const id = store.tasks.length + 1;
  store.tasks.push({ id, text, by });
  writeStore(store);
  return id;
}

// An AGGREGATE/DIGEST of the shared state — never the row contents. `count` grows as actors add
// tasks (the observed stateSeries delta); `hash` is a sha256-16 over the task tuples so a content
// change with the same count still moves the digest. Neither reveals what any task says.
export function stateDigest() {
  const { tasks } = readStore();
  const hash = createHash("sha256")
    .update(JSON.stringify(tasks.map((task) => [task.id, task.text, task.by])))
    .digest("hex")
    .slice(0, 16);
  return { count: tasks.length, hash };
}
