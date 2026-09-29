# Decisions

Short records of decisions that shape the codebase. Each states the context, the decision, what
it costs, and the code or test that enforces it. A new record is warranted when a choice would
otherwise be re-litigated or explained again in a long comment.

| #                                                     | Decision                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| [0001](0001-run-bundle-is-the-source-of-truth.md)     | The run bundle is the source of truth                                        |
| [0002](0002-observer-is-one-self-contained-file.md)   | The Observer is one self-contained HTML file                                 |
| [0003](0003-contained-paths-and-cleanup-authority.md) | Managed paths bind to physical identities; cleanup uses create-time receipts |

Safety rules and route defaults (per-lane worlds, all declared seats running at once, local
full-fidelity screenshots, dry run by default, loopback serving) are recorded with their
overrides in [invariants and defaults](../principles/invariants-and-defaults.md).
