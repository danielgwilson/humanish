# Initial Readiness Receipt: 2026-06-05

## What This Proves

The private-repo dogfood path is ready for a formal goal run, with one known
Mimetic-owned bootstrap blocker already ticketed.

## Public-Safe Evidence

- Env file loading found `GH_TOKEN`, `E2B_API_KEY`, and `OPENAI_API_KEY` names
  without printing values.
- Credential-isolated private-repo access preflight passed `4/4` assigned
  repos through anonymous-first, token-second auth.
- One redacted headed E2B lane completed fully:
  - run: `oss-meta-2026-06-05T06-06-30-955Z-1914b164`
  - app status: `running`
  - visual status: `visible`
  - nested verify: passed
  - nested Observer: present
- One redacted four-lane headed E2B trial produced:
  - run: `oss-meta-2026-06-05T06-07-41-618Z-5b4d1727`
  - preflight: `4/4` assigned repos passed
  - lane verdicts: `3 passed`, `1 failed`
  - passed lanes reached running target app surfaces, nested Mimetic proof,
    nested Observers, and visible desktop layouts
  - failed lane cloned successfully through token auth, then failed during
    package-manager install before nested Mimetic proof
- Disposable sandbox cleanup killed `5/5` sandboxes with no cleanup errors.

## Known Blocker

GitHub issue #86 tracks the current bootstrap blocker:

- title: `Handle pnpm workspace-root installs in OSS meta-lab bootstrap`
- symptom: `ERR_PNPM_ADDING_TO_ROOT` after successful private clone
- classification: Mimetic-owned bootstrap ergonomics bug

## Public-Safety Notes

- Repo labels were redacted as `repo-01` through `repo-04` in durable artifacts.
- No private repo names, private screenshots, private source snippets, raw
  private transcripts, stream auth URLs, or token values are recorded here.

## Next Goal Slice

Run the formal private-repo agent dogfood study with actor-required mode, then
evaluate each lane for setup correctness, generated Mimetic file quality,
meaningful-use rating, agent feedback quality, and Mimetic-owned blockers.
