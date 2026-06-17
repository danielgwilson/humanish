// Read-only checkpoint probe for the synthetic shared task board (#164). Prints an AGGREGATE/DIGEST
// of the shared state — the task COUNT and a sha256-16 hash of the task tuples — and NEVER the row
// contents. The harness digests this stdout (sha256-16 of the scrubbed output) into the shared-world
// `stateSeries`; as actors add tasks, `count` grows, the digest moves, and that delta under load IS
// the observed system-state evolution. Read-only: it mutates nothing.

import { stateDigest } from "./store.js";

const { count, hash } = stateDigest();
// eslint-disable-next-line no-console
console.log(`count=${count} hash=${hash}`);
