# Goal: register the scripted browser driver as a real actor (`scripted-browser`)

Status: shipped.

## What

The deterministic BrowserPersona driver that has always powered `homun run --app-url` is now
a registered actor and a lab route, instead of private code inside `src/run.ts`:

- **Move-only extraction** of the driver (journey parser, surface capture engines, helpers)
  into the leaf module `src/scripted-browser-actor.ts` — forced by import topology: `run.ts`
  imports `getActor` from the registry, so a registry entry living in `run.ts` is a module
  cycle. `run --app-url` re-imports the same code; its behavior is byte-identical (the
  pre-existing `run.test.ts` fixture-driver suite passes unchanged). The one structural change
  the move allows: the step executor's `page` is typed as the narrow structural
  `ScriptedPageLike` (playwright's `Page` satisfies it; tests inject fakes through the
  `ScriptedBrowserLike` DI seam and still run the REAL step executor at $0).
- **Registry entry** `scripted-browser` with capability-lane dispatch:
  `isScriptedBrowserActorDescriptor` (mirror of `isCuaActorDescriptor`) — lane
  `"scripted-browser"` ⇒ `runSession(ScriptedBrowserSessionOptions) →
  ScriptedBrowserSessionResult` with a fully-formed `homun.actor-trace.v1` at
  `result.trace`. Trace vocabulary additions (ratified): lane `"scripted-browser"`, protocol
  `"scripted-steps"`, completionReason `"step_failed"` (the subject failed the script's
  predicate — distinct from `actor_error`/`harness_error`, where the harness failed).
- **New backend** `src/scripted-browser-lab.ts` for the composition `subject.source: app-url`
  × `execution.target: local` (or absent) × a registered scripted-browser actor.
  `scenario.ref` is promoted from forward-declared to CONSUMED and REQUIRED on this route: it
  resolves a committed scenario (`homun/scenarios/<ref>.yaml` or a cwd-clamped path) whose
  `browser.steps` ARE the actor's behavior — there is deliberately NO built-in journey
  fallback on the lab route (the fallback stays a `run --app-url` affordance).
- Default surface roster is **1** (desktop; the defaults-table single-lane row governs);
  `count: 2` is the declared override that adds the mobile surface, where isMobile/DSF
  genuinely RENDER via playwright emulation (a fidelity win over the e2b route's
  prompt-signal-only device story).
- Lab `ok` means *credible evidence*, not *journey passed*: a `step_failed` session is
  successful evidence (review verdict `fail`), deliberately diverging from `run --app-url`
  (`ok = allPassed`). `tokenUsage` records zeros — an affirmative $0 declaration true by
  mechanism (no provider client is importable from this code path).

## Public-safety stance

- The scripted route is **loopback-ONLY, mechanically**: parse-time rejection, engine
  re-enforcement (`normalizeLocalAppUrl`), and the step driver re-normalizes every navigation
  (`resolveBrowserStepUrl`). `policies.allowPublicTargets: true` is REJECTED on this route
  (a later slice), never ignored.
- `policies.redactScreenshots: true` is REJECTED (blur is not implemented here; a silently
  ignored redaction policy would be a safety lie). Screenshots persist raw in gitignored
  `.homun/`; the bundle, verify warnings, and the lab warning all state the raw posture.
- Path-style `scenario.ref` is clamped inside the target cwd, fail-closed — no `../../`
  escape can be recorded as repo-relative provenance.
- Subject provenance: the lab does not provision the app, so the bundle DECLARES the absence
  (invariant 5) — `scripted-lab.subject.declared` records that build/commit provenance is
  UNPINNED and evidence binds to the scenario digest.
- Step URLs are sanitized to loopback origin+path (query/hash redacted); step text passes
  `redactText`; harness errors are redacted at the lab boundary before persisting.
- Spend gate as actuation gate: `scenario.mode: live` is still required even at $0 provider
  spend — a live run drives a real browser against a real running app (state-mutating
  effects), which deserves the same affirmative declaration as spend. Dry-run (default)
  parses and digest-pins the scenario contract without touching anything. This is a
  deliberate asymmetry with `run --app-url`, which actuates on invocation.

## Honest gaps (deliberate)

- Out of scope, fail-closed (rejected, never ignored): scripted actor on `e2b-desktop`,
  clone/this-repo subjects, `count > 2`, `allowPublicTargets`, `redactScreenshots: true`.
  Hybrid scripted+LLM stays out of reach (`parseActors` single-actor rule).
- `HOMUN_SCRIPTED_LAB_BROWSER_MISSING` (no Chrome/Chromium found before a live run) has no
  deterministic test: browser-binary resolution reads the real PATH, and CI images ship a
  Chrome, so the negative case cannot be pinned portably. The code path mirrors
  `run --app-url`'s existing `HOMUN_BROWSER_APP_CAPTURE_FAILED` resolution.
- `mission`/`laneFocus`/`model` are warned inert on this route (no model runs);
  `execution.desktop.*` stays forward-declared (device presets belong to the cua route —
  scripted surfaces are the driver's own desktop/mobile viewports).
- `run --app-url` still uses its own orchestration (`runBrowserAppProof`) over the shared
  driver; delegating it to this backend (deleting ~300 duplicated lines) is a roadmap note,
  not this slice.

## Proof

- Deterministic, $0 (merge gate): parse/routing matrix incl. the regression that
  app-url × e2b-desktop still requires a registered computer-use actor and the other three
  backends are untouched (`tests/lab-config.test.ts`, `tests/scripted-browser-lab.test.ts`);
  completion-semantics + projection unit tests with a fake `ScriptedBrowserLike` through the
  REAL step executor — goal_satisfied / step_failed (assertion false; selector missing;
  unreachable subject) / timed_out / harness_error, gave_up + blocked_approval unreachable
  (`tests/scripted-browser-actor.test.ts`); full `runLab` dispatch — dry-run contract bundle
  with pinned provenance, live-with-fakes filling `stream.actor` per surface, scenario.ref
  failure modes with zero artifacts, `verifyRun` green including the hollow-run engagement
  check and the raw-screenshot posture warning, no absolute paths or secret-shaped text in
  persisted artifacts (`tests/scripted-browser-lab.test.ts`); conformance vocabulary extended
  and a scripted fixture trace conforms (`tests/actor-conformance.test.ts`); the committed
  `scripted-demo` lab parses with zero warnings and its committed scenario is executable
  (`tests/lab-structural.test.ts`); CLI `lab run scripted-demo --dry-run` JSON + human output;
  the UNCHANGED `run --app-url` fixture suite proves the extraction was behavior-preserving.
- Live (actuation-gated `HOMUN_LIVE_SCRIPTED=1`, requires a local Chrome/Chromium; provider
  spend $0 BY MECHANISM): `tests/scripted-browser-lab.live.test.ts` serves a tiny loopback
  app in-test and dispatches the committed scenario through `runLab` to real playwright-core —
  verified bundle, goal_satisfied on both surfaces, non-empty raw step screenshots, sanitized
  loopback URLs, tokenUsage zeros.
