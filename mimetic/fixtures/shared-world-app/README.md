# Synthetic shared-world fixture: a shared task board

A minimal, public-safe, **synthetic** multi-user web app for the CONCURRENT shared-world
topology (#164). It is the *shared mutable service plane* that N concurrent actor personas drive
at once: a tiny "shared task board" where every visitor sees the same task list and any of them
can add a task that everyone then sees.

Python **stdlib only** — **no dependencies, no build, no install step**. It is Python (not Node)
on purpose: the E2B desktop image the subject sandbox runs ships `python3` but no `node`. Generic
synthetic content only (no real names, domains, or sensitive data).

## Files

| File | Role |
| --- | --- |
| `server.py` | The HTTP server (`http.server`, threaded). `GET /` renders the shared task list + an add-task form (a text input `#task-text` + an `#add-task` button a computer-use browser can click/type into). `POST /add` appends a task to the shared store and redirects back. Binds `0.0.0.0` (FIX-4 — `getHost` only routes to a port bound on all interfaces). |
| `store.py` | The file-backed **shared store** (`store.db_path()`). A JSON file so the store is visible BOTH to the long-lived server (mutated by every actor) AND to the separate `checkpoint.py` probe process. |
| `seed.py` | Inserts a few generic synthetic starter tasks. Runs once before the server starts. |
| `checkpoint.py` | Read-only probe. Prints an **aggregate/digest** of the shared state (`count=<n> hash=<sha256-16>`) — never row contents. The harness digests this stdout into the shared-world `stateSeries`; as actors add tasks the count grows and the digest moves, and that delta under load is the observed system-state evolution. |

## How the shared state persists

`store.py` reads/writes a single JSON file at `$SHARED_WORLD_DB`
(default `<tmpdir>/shared-world-app/tasks.json`). Because it is a file (not in-memory), the
state the server mutates on `POST /add` is the same state the separate `checkpoint.py` probe
reads — that is what lets the harness observe the shared world changing under concurrent load.

**Contention is observed, not prevented.** Read-modify-write on a JSON file races under
concurrent POSTs (lost updates are possible). That is acceptable and illustrative: the
shared-world doctrine OBSERVES contention (the `contention-observed-not-proven-safe` attribution
limit) rather than proving the store race-free. The checkpoint count growing across the run is
the delta signal regardless of exact races.

## Run it locally

```sh
python3 mimetic/fixtures/shared-world-app/seed.py          # seed starter tasks
python3 mimetic/fixtures/shared-world-app/checkpoint.py    # -> count=3 hash=...
HOST=0.0.0.0 PORT=3000 python3 mimetic/fixtures/shared-world-app/server.py
# open http://127.0.0.1:3000/, add a task, then re-run checkpoint.py -> count grows
```

## How the lab uses it

`mimetic/labs/shared-world-concurrent-live.yaml` clones this repo into the subject sandbox,
serves this fixture on `0.0.0.0` (`subject.serve.start`), seeds it (`subject.state.seed`), and
probes it on a cadence (`subject.state.checkpoint`). The cloned commit is recorded as the
plane's provenance. `subject.exposure: synthetic` attests (author-trust + a `state.provenance ==
seeded` gate) that the plane behind the internet-reachable `getHost` URL is synthetic seeded
data. The live rung (`tests/concurrent-shared-world-lab.live.test.ts`,
`MIMETIC_LIVE_SHARED_WORLD=1`) drives 3 concurrent personas against it.
