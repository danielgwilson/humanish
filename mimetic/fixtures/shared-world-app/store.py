# File-backed SHARED store for the synthetic shared-world task board (#164).
#
# The store is a JSON file (not in-memory) ON PURPOSE: the concurrent shared-world route mutates it
# from the long-lived server process AND reads an aggregate from a SEPARATE checkpoint probe process
# (run detached by the harness). A file is the smallest thing visible to both. Python stdlib only
# (no dependencies). Public-safe: generic synthetic content only.
#
# CONTENTION NOTE: read-modify-write on a JSON file races under concurrent POSTs (lost updates are
# possible). That is acceptable and even illustrative for this topology — the shared-world doctrine
# OBSERVES contention (the `contention-observed-not-proven-safe` attribution limit) rather than
# proving the store race-free. The checkpoint count growing across the run is the delta signal.

import hashlib
import json
import os
import tempfile

# One stable path shared by the server, the seed script, and the checkpoint probe.
DB_PATH = os.environ.get("SHARED_WORLD_DB") or os.path.join(
    tempfile.gettempdir(), "shared-world-app", "tasks.json"
)


def db_path() -> str:
    return DB_PATH


def read_store() -> dict:
    try:
        with open(DB_PATH, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
        return parsed if isinstance(parsed.get("tasks"), list) else {"tasks": []}
    except (OSError, ValueError, AttributeError):
        return {"tasks": []}


def write_store(store: dict) -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with open(DB_PATH, "w", encoding="utf-8") as fh:
        json.dump(store, fh)


def add_task(text: str, by: str) -> int:
    store = read_store()
    task_id = len(store["tasks"]) + 1
    store["tasks"].append({"id": task_id, "text": text, "by": by})
    write_store(store)
    return task_id


# An AGGREGATE/DIGEST of the shared state — never the row contents. `count` grows as actors add
# tasks (the observed stateSeries delta); `hash` is a sha256-16 over the task tuples so a content
# change with the same count still moves the digest. Neither reveals what any task says.
def state_digest() -> dict:
    tasks = read_store()["tasks"]
    tuples = json.dumps(
        [[t["id"], t["text"], t["by"]] for t in tasks], separators=(",", ":")
    )
    digest = hashlib.sha256(tuples.encode("utf-8")).hexdigest()[:16]
    return {"count": len(tasks), "hash": digest}
