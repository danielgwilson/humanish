# Seed the synthetic shared task board with a few generic starter tasks (#164). Runs ONCE before
# the server starts (subject.state.seed, when: before-start). Public-safe: generic, synthetic
# content only — no real names, domains, or sensitive data. Python stdlib only.

from store import write_store

STARTERS = [
    {"id": 1, "text": "Draft the weekly update", "by": "seed"},
    {"id": 2, "text": "Review the open tasks", "by": "seed"},
    {"id": 3, "text": "Plan the next sprint", "by": "seed"},
]

if __name__ == "__main__":
    write_store({"tasks": STARTERS})
    print(f"seeded {len(STARTERS)} tasks", flush=True)
