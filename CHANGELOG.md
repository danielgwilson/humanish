# Changelog

Newest first. Each entry is the opening paragraph of that version's release notes; the link holds
the full notes. Versions not listed here (0.1.1 through 0.65.0 except 0.20.0, and 0.81.0) are
tagged without notes.

The Unreleased section holds the full notes for the next version until it is tagged.

## Unreleased

### Breaking (each with its migration)

Node and dependencies:

- humanish requires Node 22.19.0 or later (`engines.node: >=22.19.0`, #896). 0.105.0 declared
  `>=20`. The runtime dependencies `undici` and `commander` move to ^8 and ^15, from ^6 and ^14
  (#896). Migration: run humanish on Node 22.19.0 or later.

Lab files and the CLI:

- A shared-world lab whose spend cap names a model with no price is refused with
  `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_UNPRICED_CAP` (#1306), as computer use and terminal already
  refuse it with their `_UNPRICED_CAP` codes. 0.105.0 refused it with
  `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID`. Migration: match the new code.
- A live terminal lab whose `scenario.caps.maxMinutes` would take its sandbox past E2B's one-hour
  limit (above 49 minutes, or 44 with a product install) is refused with
  `HUMANISH_TERMINAL_LAB_CAPS_INVALID` before any sandbox is created (#1200). The sandbox now
  lives long enough for its Node bootstrap, version check and product setup on top of
  `maxMinutes`; before, a slow setup plus a full-length agent command could have it reclaimed
  mid-run. Migration: lower `maxMinutes`.
- Unknown lab fields and quoted policy booleans are refused (#932). A mistyped key (`executon:`,
  `execution.timeoutMS`) or `policies.redactScreenshots: "true"` now fails before anything runs,
  naming the key and the nearest known field. Before, the lab ran without the setting. Migration:
  fix the key the error names; write policy booleans unquoted.
- Sequential shared-world studies are removed (#945). A shared-world lab with
  `execution.concurrency: 1` now fails at parse. Migration: omit `execution.concurrency` to run every
  participant at once, or set it to 2 or more. `humanish verify` still reads sequential bundles.
- Clone labs must set `execution.target: e2b-desktop` (#964). A clone lab with `local` or no target
  used to run on a hosted desktop anyway. Migration: add `execution.target: e2b-desktop`.
- Clone labs must declare a computer-use actor or `scripted-browser`; other actor types (e.g.
  `codex-app-server`) are refused at parse instead of at run start (#978, after #897).
- The OSS meta-lab and OSS smoke labs are removed (#897): the hidden `lab oss`, `lab oss-smoke` and
  `lab cleanup` commands, and the `--repo`, `--repos`, `--limit`, `--keep`, `--redact-repos` and
  `--codex-app-server` flags on `watch` and `lab run`. Library: `runOssLab` and `DEFAULT_OSS_REPOS`
  are gone. Migration: a clone lab with a computer-use actor.
- `humanish run --actor` is removed (#903), with its `codex-tui`, `codex-exec` and
  `codex-app-server` modes and six error codes (`HUMANISH_LOCAL_CODEX_EXEC_FAILED`,
  `HUMANISH_LOCAL_CODEX_TUI_FAILED`, `HUMANISH_ACTOR_FANOUT_UNIMPLEMENTED`,
  `HUMANISH_INVALID_ACTOR_CONCURRENCY`, `HUMANISH_UNSUPPORTED_ACTOR`,
  `HUMANISH_CODEX_APP_SERVER_FAILED`). Migration: a lab with `type: local-agent` for a signed-in Codex
  or Claude Code, or a terminal lab running `codex-exec` in E2B.
- `humanish run --app-url` and `--timeout-ms` are removed (#957). In 0.106.x, `run --app-url` exits 2
  with `HUMANISH_APP_URL_REMOVED` and a docs link. Migration: a scripted-browser lab (subject.source
  app-url, a scripted-browser actor, scenario.ref with browser.steps, scenario.mode live). Library:
  RunOptions drops appUrl/timeoutMs; RunResult drops four codes and adds HUMANISH_APP_URL_REMOVED.
- The `pi-agent-core` and `claude-agent-sdk` actor types are removed (#955); no route ran them. A lab
  naming one fails to parse. Migration: `type: local-agent` with `localAgent: claude`. The optional
  peer dependency `@anthropic-ai/claude-agent-sdk` is dropped; ActorId/ActorLane/ActorProtocol lose
  the matching members.
- A positive `scenario.caps.maxUsd` or `scenario.caps.maxTotalUsd` on a computer-use lab is refused
  with `HUMANISH_LAB_INVALID` (#1030). Before, the route ignored it with a warning and ran uncapped.
  Migration: move the value to `execution.caps.maxUsd` or `execution.caps.maxTotalUsd`.
- A live terminal lab with `maxUsd` above 0 and nothing that measures its spend is refused with
  `HUMANISH_TERMINAL_LAB_UNPRICED_CAP` before the E2B module loads (#1025). Codex tokens have no
  price, so the cap could never trip. Migration: `maxUsd: 0` plus `scenario.caps.maxMinutes`.
- A run id can be used once (#960): `--run-id` (or library `runId`) naming an existing run directory
  is refused with `HUMANISH_RUN_ID_IN_USE` instead of overwriting that run's evidence.
- `humanish watch --safe` is refused with `HUMANISH_WATCH_SAFE_NOT_APPLICABLE` (exit 2) on every
  path (#1148). Before, it was refused only together with `--expose`; otherwise the flag was accepted
  and ignored. Migration: drop `--safe` from `watch`; restrict viewers with edge auth
  (`--allow-email`/`--allow-domain`). `--safe` filters a `serve` library.
- Custom E2B desktop templates need `mktemp` and the `C.UTF-8` locale (#1111). Typing now goes
  through one `LC_ALL=C.UTF-8 xdotool type --file` command, and the `xclip`/`xsel` clipboard
  fallback is removed. On a template without `C.UTF-8`, non-ASCII typing fails with
  `type failed at text-command`. The stock desktop needs nothing. Migration: add the locale.
- Local browser studies (app-url + execution.target local) now run with a scorer or library hooks on
  the local Firecracker desktop instead of being refused; E2B-only hooks on them are now an error
  (#954).

Results and evidence:

- A screenshot counts as redacted only when it claims `blurred` (or carries no claim under a
  blurred trace) and its bytes have the redactor's shape: IHDR, IDAT and IEND chunks only, at most
  128 px wide (#1207). verify fails a screenshot with metadata chunks, a payload in IHDR or IEND,
  or interlacing. A PNG that a trace references outside `screenshots/` counts as unscanned, and
  `ocr_scrubbed` no longer counts as redacted. No retained real run changed grade. Migration:
  blur frames with `policies.redactScreenshots: true` or `humanish export --redact-screenshots`.
- `humanish verify` matches secret and path patterns after undoing JSON and JS escapes,
  percent-encoding, quoted-printable, HTML character references, hex and base64 (standard,
  URL-safe and line-wrapped) (#1210). A file holding a secret in one of those forms blocks the run;
  base64 of an archive, or a long base64 run of other binary, keeps it `local_only`
  (`UNSCANNED_ARTIFACT`). Before, these graded `share_ready`, and `serve --safe` served them.
  `observer/index.html` is exempt from the base64 binary rule. Known limits: base64 split across
  separate strings, nesting deeper than three levels, and encryption.
- `humanish verify` grades a run `local_only`, with the new reason `UNSCANNED_ARTIFACT` naming the
  files, when its folder holds an image or archive other than the stream screenshots an actor
  trace references and the registered recordings (#1192). Before, such a file left the run `share_ready`, and
  `serve --safe` served it. Bundle export now drops a PNG that nothing in `run.json` cites, where it
  blurred it before. A run whose feedback, adapter or stream-artifact evidence cites a PNG that is
  not a stream screenshot can no longer be drafted (`HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED`) or
  exported (`HUMANISH_EXPORT_BUNDLE_REFUSED`; HTML export without `--local-only`,
  `HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED`). Migration (adapter authors): keep images out of the
  run folder unless a participant's trace references them, or share with `--local-only`.
- `humanish verify` decides which run files it can scan from their bytes, not their names (#1202).
  A file that is not strict UTF-8 text without control bytes, or that verify cannot read, adds
  `UNSCANNED_ARTIFACT` and keeps the run `local_only`, whatever its extension. A file or directory
  whose name contains `\` blocks the run. Before, such files could leave a run `share_ready`.
- Scripted-browser text checks (`waitForText`, `assertText`, `expect.text`) now check the page
  (#1171). Before, they passed whatever the page showed, so a scripted run that passed only on such a
  check now fails. The one committed text step is in `humanish/scenarios/scripted-first-run.yaml`
  (`waitForText` "Welcome"), run by `humanish/labs/scripted-demo.yaml`; no bench, fixture or release-gate lab
  has one. Migration: a run that now fails was checking for text the app does not show; fix the expected text
  or the app.
- A shared-world run whose seats all passed but never overlapped in time now fails, and the
  lab exits non-zero (#1162). On the provisioned plane, so does a run whose shared state never
  changed under overlap. Before, these read pass, and `humanish verify` rejected the pass. Migration:
  none in the lab file; such a run never showed its participants acting at once.
- `automaticAnalysis.reason` uses the uppercase `AUTOMATIC_ANALYSIS_*` codes (#1082), in CLI JSON,
  the human line `analysis: <state> (<reason>)` and library results. It used to mix four lowercase
  codes with the uppercase ones. Migration: match the uppercase codes.
- A feedback candidate must carry a non-blank `idempotency_key` (#1150). `humanish verify` fails a
  run that holds a blank-keyed candidate, `feedback draft` and `feedback verify` refuse it, and an
  adapter's `deriveFeedback` candidate without a key is dropped with a warning. No first-party
  producer writes a blank key. Migration (adapter authors): give each candidate a stable key.

Library:

- The package entry point exports 83 names (34 values, 49 types), down from 0.105.0's 377 (156
  values, 221 types) (#1060 and the PRs below): the library surface (run a lab, read a run, bring a
  participant, score a run), the routing names, and deprecated runner wrappers. 300 names are
  removed, listed in full below, among them `Shell`, `ShellResult`, `e2bShell`, the detached-process helpers
  (`runDetachedStep`, `startDetachedProcess`, `readDetachedLog`, `probeUrl`; #975 had given
  them a `Shell` parameter) and the actor descriptor types (`CuaActorDescriptor`,
  `ActorDescriptor`, `LocalAgentActorDescriptor`; #966). New exports: `LabEvent`, `LabResult<R>`,
  `LabRoute`, `ProviderContext`, `defaultRedactionHooks` and `routeOf`. Migration: `runLab` and the surface names; the site's
  Library page has an example per group.
- Removed exports (#945): `runSharedWorldLab`, `buildSharedWorldBundle`, `SHARED_WORLD_LAB_SCHEMA`,
  `SHARED_WORLD_LAB_PROVIDER_METADATA`, `RunSharedWorldLabOptions`, `SharedWorldLabErrorCode`,
  `SharedWorldLabResult`, `SharedWorldRoleResult`. Migration: call `runLab`.
- Library callers get configuration refusals that the CLI parser already produced
  (#1071, #1108, #1147). Each carries its route's code, not a generic gap result:
  - `runCuaActorLab` refuses a `subject.topology: shared-world` config, an in-process executor with a
    clone, local-tree or desktop-cli subject, and a desktop-cli subject without `subject.product.name`
    (`HUMANISH_CUA_LAB_SUBJECT_INVALID`);
  - the shared-world route refuses a provisioned clone whose `repos[0]` is not an owner/repo slug,
    an external-public plane without a public-safe `subject.publicTarget.owner`
    (`HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID`), and `subject.env` on an external-public plane.
- An in-process computer-use run (`runLab(config, { inProcess: { executor }, createProvider })`)
  runs on the same participant runner as hosted lanes (#1165), so a declared `execution.caps.maxUsd`
  or `maxTotalUsd` now applies. With a provider that reports no usage, the run stops at its first
  request with `stopCause: "usage_unreported"`; before, the cap was ignored. The trace carries a cost
  estimate, the run records a cost block, and a failed provider close adds a warning beside the
  error. Migration: report usage from the provider `createProvider` returns.
- An app-url lab with `execution.target: local` and no desktop lane gets its own code,
  `HUMANISH_CUA_LAB_LOCAL_DESKTOP_MISSING` (#1117); `HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR` now
  recommends `runLab(config, { inProcess: { executor }, createProvider })`.

<details>
<summary>The 300 names 0.105.0 exported that this release does not</summary>

Generated by parsing the published 0.105.0 `dist/index.d.ts` against
`tests/golden/public-api.json`.

Values (124):

`ACTOR_TRACE_SCHEMA`, `ANALYZE_RESULT_SCHEMA`, `CLEANUP_SCHEMA`, `CLI_RESPONSE_SCHEMA`,
`CODEX_APP_SERVER_CAPABILITIES`, `CODEX_APP_SERVER_TRACE_SCHEMA`, `CODEX_APP_SERVER_UI_SCHEMA`,
`COMMS_RECEIVING_SCHEMA`, `COMMS_THREAD_SCHEMA`, `CONCURRENT_ATTRIBUTION_LIMITS`,
`CONCURRENT_SHARED_WORLD_LAB_SCHEMA`, `CONCURRENT_SHARED_WORLD_PROVIDER_METADATA`,
`CUA_ACTOR_LAB_PROVIDER_METADATA`, `CUA_ACTOR_LAB_SCHEMA`, `CUA_FANOUT_STRATEGY`,
`DEFAULT_DEVICE_PRESET`, `DEFAULT_OPENAI_CU_MODEL`, `DEFAULT_OSS_REPOS`, `DESKTOP_RATE`,
`DESKTOP_RESOURCE_RATE`, `DEVICE_PRESETS`, `DEVICE_PRESET_NAMES`, `DOCTOR_SCHEMA`,
`EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS`, `FEEDBACK_RESULT_SCHEMA`, `FEEDBACK_SCHEMA`, `FakeInbox`,
`INIT_RESPONSE_SCHEMA`, `LAB_PREFLIGHT_SCHEMA`, `LOBBY_CODE_PATTERN`, `MODEL_RATES`,
`OBSERVER_DATA_SCHEMA`, `OBSERVER_SCHEMA`, `OBSERVER_STATIC_HOST`,
`OPENAI_RESPONSES_CU_CAPABILITIES`, `OSS_LAB_SCHEMA`, `PRICING_SCHEMA`, `REVIEW_SCHEMA`,
`RUNS_SCHEMA`, `RUN_BUNDLE_SCHEMA`, `SCRIPTED_BROWSER_CAPABILITIES`, `SCRIPTED_BROWSER_LAB_SCHEMA`,
`SCRIPTED_BROWSER_PROVIDER`, `SHARED_WORLD_LAB_PROVIDER_METADATA`, `SHARED_WORLD_LAB_SCHEMA`,
`SHARED_WORLD_SCHEMA`, `STUDY_ANALYSIS_CORRECTION_SCHEMA`, `STUDY_ANALYSIS_SCHEMA`,
`TERMINAL_AGENT_CAPABILITIES`, `TERMINAL_AGENT_NOT_IMPLEMENTED_CODE`, `TERMINAL_PRODUCT_LAB_SCHEMA`,
`VERIFY_SCHEMA`, `actorRegistry`, `adapterScoreFailureMessage`, `analyzeStudy`,
`applyAdapterScoreFailureToReview`, `applyBrowserAdapterHooks`, `automaticAnalysisBudget`,
`buildConcurrentSharedWorldBundle`, `buildCuaBundle`, `buildCuaFanoutBundle`, `buildObserverData`,
`buildScriptedLabBundle`, `buildSharedWorldBundle`, `buildTerminalProductBundle`, `cleanupRun`,
`codexResultToActorTrace`, `codexStatusToCompletionReason`, `correctStudyAnalysis`,
`createE2BDesktopExecutor`, `createObserverStaticHandler`, `createProgram`, `describeCuaAction`,
`doctor`, `draftFeedback`, `estimateActorCost`, `estimateAllocatedDesktopCost`,
`estimateDesktopCost`, `extractLobbyCode`, `extractLocalActorVerdict`, `getActor`,
`isCuaActorDescriptor`, `isDevicePresetName`, `isHttpUrl`, `isLoopbackUrl`,
`isScriptedBrowserActorDescriptor`, `isTerminalActorDescriptor`, `listFeedback`, `listRuns`,
`loadE2BDesktopModule`, `normalizeCliArgv`, `normalizeLocalActorTranscript`,
`normalizeOssRepoSlugs`, `observerStaticContentType`, `openTarget`, `probeUrl`,
`readAutomaticStudyAnalysis`, `readDetachedLog`, `readReview`, `renderIssueMarkdown`,
`renderIssueUrl`, `requestAutomaticStudyAnalysisCancellation`, `resolveAutomaticAnalysis`,
`resolveCuaLanePlan`, `resolveDevicePreset`, `respondToObserverStaticRequest`,
`runAutomaticStudyAnalysis`, `runCodexAppServerSession`, `runDetachedStep`, `runInit`,
`runLabPreflight`, `runOssLab`, `runScriptedBrowserSession`, `runSharedWorldLab`,
`runTerminalAgentSession`, `serveObserver`, `serveObserverStatic`, `showStudyAnalysis`,
`startCodexAppServerUi`, `startDetachedProcess`, `stripAnsi`, `subjectStateInvalidReason`,
`validateOssRepoSlug`, `verifyFeedback`.

Types (176):

`ActorCompletionReason`, `ActorDescriptor`, `ActorEstimatedCost`, `ActorId`, `ActorLane`,
`ActorPersonaRef`, `ActorProtocol`, `ActorRuntimeProvenance`, `ActorStatus`, `ActorStopCause`,
`ActorTokenUsage`, `ActorTraceItem`, `ActorTraceItemKind`, `AnalysisConcernReview`, `AnalyzeDeps`,
`AnalyzeOptions`, `AnalyzeResult`, `AutomaticAnalysisBudget`, `AutomaticAnalysisResult`,
`AutomaticStudyAnalysisCancellation`, `AutomaticStudyAnalysisDeps`, `AutomaticStudyAnalysisOutcome`,
`AutomaticStudyAnalysisView`, `BrowserAdapterBackend`, `BrowserPersonaJourney`, `BrowserSurface`,
`CleanupAdapterResult`, `CleanupResourceResult`, `CleanupResult`, `CliIo`, `CodexAnalysisIdentity`,
`CodexAppServerRunOptions`, `CodexAppServerRunResult`, `CodexAppServerTrace`,
`CodexAppServerUiController`, `CodexAppServerUiOptions`, `CodexAppServerUiState`,
`CodexStudyAnalysisConfig`, `CommandLogRecord`, `CommsAddress`, `CommsChannel`, `CommsChannelKind`,
`CommsMessage`, `CommsReceivingEvidence`, `CommsThreadArtifact`, `CommsThreadEntry`,
`ConcurrentSharedWorldLabErrorCode`, `ConcurrentSharedWorldPlaneClass`,
`ConcurrentSharedWorldRoleResult`, `CostCategory`, `CostLine`, `CuaActorDescriptor`,
`CuaActorLabErrorCode`, `CuaActorSessionOptions`, `CuaLanePlan`, `CuaLanePlanEntry`,
`CuaLaneResult`, `CuaLaneSummary`, `CuaSubjectProjection`, `DesktopCostEstimate`, `DesktopRate`,
`DesktopResourceRate`, `DesktopResources`, `DetachedStepOptions`, `DetachedStepResult`,
`DetachedTimers`, `DevicePreset`, `DevicePresetName`, `DoctorResult`, `E2BDesktopExecutorOptions`,
`E2BDesktopLike`, `E2BDesktopModule`, `FakeInboxOptions`, `FeedbackDraft`, `FeedbackResult`,
`FetchLike`, `InboundRaw`, `InitChange`, `InitMode`, `InitOptions`, `InitResult`,
`InterventionRecord`, `LabActor`, `LabActorLane`, `LabAnalysis`, `LabConfigParseResult`,
`LabExecutionTerminal`, `LabPreflightCheck`, `LabPreflightReachabilityMode`, `LabPreflightResult`,
`LabPreflightSandbox`, `LabPreflightSpend`, `LabPreflightTarget`, `LabRuntimeAuth`,
`LabScenarioCaps`, `LabStateStepWhen`, `LabSubject`, `LabSubjectProduct`, `LabSubjectServe`,
`LabSubjectSource`, `LabSubjectState`, `LabSubjectStateCheckpoint`, `LabSubjectStateStep`,
`LabSubjectTopology`, `LabTerminalStdin`, `LabTerminalTransport`, `LifecycleRecord`,
`LoadedStudyAnalysis`, `ModelRate`, `NoSpendProof`, `ObserverData`, `ObserverOptions`,
`ObserverServeOptions`, `ObserverServer`, `ObserverStaticHandlerOptions`,
`ObserverStaticServeOptions`, `ObserverStaticServer`, `ObserverStream`, `OpenAIStudyAnalysisConfig`,
`OssLabOptions`, `OssLabRepoResult`, `OssLabResult`, `OssLabStep`, `OutboundMessage`,
`ParticipantClosingReport`, `ReceivingParticipantEvidence`, `ReviewSummary`, `RunAttributionClass`,
`RunCleanupHooks`, `RunCostLine`, `RunCostSummary`, `RunDesktopGeometry`, `RunEvent`,
`RunLabPreflightOptions`, `RunMeaningfulUseComponentId`, `RunMeaningfulUseScore`,
`RunParticipantAssignment`, `RunProviderResource`, `RunScorerProvenance`,
`RunSharedWorldLabOptions`, `RunSimulation`, `RunStream`, `RunStreamKind`, `RunSubjectProvenance`,
`RunSubjectStateStepRecord`, `RunsResult`, `ScriptedBrowserActorDescriptor`,
`ScriptedBrowserLabSession`, `ScriptedBrowserLaunchArgs`, `ScriptedBrowserLike`,
`ScriptedBrowserSessionOptions`, `ScriptedBrowserSessionResult`, `ScriptedLocatorLike`,
`ScriptedPageLike`, `SharedWorldCheckpoint`, `SharedWorldEvidence`, `SharedWorldLabErrorCode`,
`SharedWorldLabResult`, `SharedWorldLaneWindow`, `SharedWorldOutcome`, `SharedWorldPlane`,
`SharedWorldRoleResult`, `SharedWorldSkippedTail`, `SharedWorldStateSnapshot`,
`SharedWorldTimelineEntry`, `SharedWorldTurn`, `StudyAnalysisArtifact`, `StudyAnalysisConfig`,
`StudyAnalysisCorrection`, `StudyAnalysisResult`, `TerminalActorDescriptor`,
`TerminalAgentSessionOptions`, `TerminalAgentSessionResult`, `TerminalCostLedger`,
`TerminalLedgers`, `UnexpectedErrorEnvelope`.

</details>

Removed environment variables (34) and error codes (19), each with its replacement. These
are the `HUMANISH_*` names `src/` read or returned at 0.105.0 and no longer does.

- Environment variables of the OSS meta-lab and smoke labs, removed with them (#897):
  `HUMANISH_CODEX_ACCESS_TOKEN`, `HUMANISH_CODEX_API_KEY`, `HUMANISH_CODEX_APP_SERVER_URL`,
  `HUMANISH_E2B_TIMEOUT_MS`, `HUMANISH_GITHUB_TOKEN`, `HUMANISH_GITHUB_TOKEN_RUNTIME`,
  `HUMANISH_OSS_META_ACTOR_FIRST`, `HUMANISH_OSS_META_ACTOR_MODEL`,
  `HUMANISH_OSS_META_ACTOR_PREFLIGHT_MODEL`, `HUMANISH_OSS_META_ACTOR_TIMEOUT_MS`,
  `HUMANISH_OSS_META_CODEX_APP_SERVER`, `HUMANISH_OSS_META_CODEX_APP_SERVER_PORT`,
  `HUMANISH_OSS_META_COMPLETION_INTERVAL_MS`, `HUMANISH_OSS_META_COMPLETION_TIMEOUT_MS`,
  `HUMANISH_OSS_META_HOST_CODEX_ACTOR`, `HUMANISH_OSS_META_REPO_PREFLIGHT_TIMEOUT_MS`,
  `HUMANISH_OSS_META_REQUIRE_ACTOR`, `HUMANISH_OSS_META_SCREENSHOT_REFRESH_MS`,
  `HUMANISH_OSS_META_SCREENSHOT_SETTLE_MS`, `HUMANISH_OSS_META_SKIP_ACTOR_PREFLIGHT`,
  `HUMANISH_OSS_META_SKIP_REPO_ACCESS_PREFLIGHT`, `HUMANISH_OSS_META_WATCH_REFRESH_MS`.
  `HUMANISH_OSS_META_ALLOW_PROVIDER_LIST` went with the hidden `lab cleanup` command;
  `humanish reclaim` kills sandboxes by their journaled ids.
- Environment variables of `humanish run --actor`'s local Codex modes, removed with them (#903).
  Use a lab with `actors[0].type: local-agent`, or a terminal `codex-exec` lab:
  - `HUMANISH_ENABLE_LOCAL_CODEX_APP_SERVER`, `HUMANISH_ENABLE_LOCAL_CODEX_EXEC` and
    `HUMANISH_ENABLE_LOCAL_CODEX_TUI`: the lab's actor type;
  - `HUMANISH_CODEX_ACTOR_COMMAND`: `localAgent: codex` or `claude`;
  - `HUMANISH_CODEX_ACTOR_TIMEOUT_MS`: `execution.timeoutMs`;
  - `HUMANISH_CODEX_APP_SERVER_MODEL`: `actors[0].model`;
  - `HUMANISH_LOCAL_CODEX_EXEC_MAX_CONCURRENCY`: `execution.concurrency`;
  - `HUMANISH_CODEX_APP_SERVER_EXPERIMENTAL`, `HUMANISH_CODEX_APP_SERVER_SANDBOX` and
    `HUMANISH_SKIP_CODEX_TRUST_PREFLIGHT`: removed.
- `HUMANISH_BROWSER_PERSONA_DRIVER` is removed with `run --app-url`'s capture engine (#957); a live
  scripted-browser lab does that job.
- Sandbox scripts no longer export `HUMANISH_PUBLIC_SAFE` (#910), and no child process gets
  `HUMANISH_ACTOR_VERDICT_NONCE` (#903).
- Error codes:
  - `HUMANISH_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED`, `HUMANISH_SHARED_WORLD_LAB_FAILED`,
    `HUMANISH_SHARED_WORLD_LAB_INVALID`, `HUMANISH_SHARED_WORLD_LAB_KEYS_MISSING` and
    `HUMANISH_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING` (#945): the
    `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_*` code with the same suffix.
  - `HUMANISH_APP_URL_OPTION_CONFLICT`, `HUMANISH_INVALID_APP_URL` and
    `HUMANISH_BROWSER_APP_CAPTURE_FAILED` (#957): `run --app-url` is refused with
    `HUMANISH_APP_URL_REMOVED`.
  - `HUMANISH_OSS_META_LIVE_ISOLATION_REQUIRED` (#897): a clone lab with an actor that is not a
    computer-use participant fails with `HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED`.
  - `HUMANISH_UNSUPPORTED_ACTOR` (#903): `--actor` is an unknown option.
  - Removed: `HUMANISH_META_RUN_FAILED`, `HUMANISH_INVALID_OSS_COUNT`, `HUMANISH_INVALID_OSS_LIMIT`
    and `HUMANISH_INVALID_OSS_REPO` (#897); `HUMANISH_ACTOR_FANOUT_UNIMPLEMENTED`,
    `HUMANISH_CODEX_APP_SERVER_FAILED`, `HUMANISH_INVALID_ACTOR_CONCURRENCY`,
    `HUMANISH_LOCAL_CODEX_EXEC_FAILED` and `HUMANISH_LOCAL_CODEX_TUI_FAILED` (#903).

### Deprecated (removed in 0.107.0)

- `LabOutcome.backend` (#1213); narrow on `outcome.route`.
- The route runners `runCuaActorLab`, `runScriptedBrowserLab`, `runTerminalProductLab`,
  `runConcurrentSharedWorld` and `runDryRun`, and `runCuaActorSession` (#1060). Each prints one
  `DeprecationWarning` per process (`HUMANISH_DEPRECATED_EXPORT`) naming its replacement. Their
  option, result and hook bag types are `@deprecated` aliases. Migration: `runLab`; for a strict
  capped session, the composition documented in #1076.
- `RunLabOptions` fields that moved to typed homes (#1036, #1053): the scorer hooks,
  `buildProvider`, `buildExecutor`, `prepareDesktop`, `onPreflight`, `onPhase`, the stream hooks,
  `automaticAnalysis.onStart`, `deps.signal`, each bag's `env` and `rerun.laneIds`. Each prints one
  `DeprecationWarning` (`HUMANISH_RUN_LAB_OPTION_DEPRECATED`) naming its home. Setting a new field
  together with the old one it replaces is refused with `HUMANISH_LAB_OPTION_CONFLICT`.
- The `routesTo*` predicates (#1160): `routesToComputerUse`, `routesToSharedWorld`,
  `routesToProvisionedSharedWorld`, `routesToExternalPublicSharedWorld`,
  `routesToConcurrentSharedWorld` (deprecated since #945), `routesToScriptedBrowser` and
  `routesToTerminalProduct`. They are `@deprecated` in the types only and print no warning.
  Migration: `routeOf(config)`, which returns `"computer-use"`, `"shared-world"`, `"scripted"`,
  `"terminal"` or `"preview"`. For an actor type that is not registered, `routeOf` names the route
  that refuses it, where the predicate returned false.
- The `TerminalProductLabResult.error.code` value `HUMANISH_TERMINAL_AGENT_NOT_IMPLEMENTED` is no
  longer produced (#1266) and leaves the type in the next minor.
- Ten more exports removed in the next minor carry `@deprecated` (#1251). The eight functions
  among them, `actorResolvesToTerminal`, `cuaLaneCount`, `resolveSeatUrl`,
  `cuaLaneValidationReason`, `sharedWorldValidationReason`,
  `concurrentSharedWorldValidationReason`, `externalPublicSharedWorldValidationReason` and
  `resolveLabDryRun`, print one `DeprecationWarning` per process naming the replacement.
  `RunLabOptions.cuaHooks.createDesktopLane` also warns and is removed with no replacement.

### New

- `LabOutcome` carries `route` (`preview`, `computer-use`, `scripted`, `terminal` or
  `shared-world`) beside `backend` (#1213), and `humanish lab preflight --json` reports `route`
  too.
- Codex participants and Codex-account analysis admit a per-host set of Codex CLI releases (#1074):
  Linux x64 0.154.0, 0.157.1, 0.159.2 and 0.159.3; macOS arm64 0.154.0. Linux arm64 and Intel macOS keep
  0.154.0 as a pre-existing admission. Each launch is bound to the release it detected, and a
  release outside the host's list is refused with a message listing the admitted ones.
  Maintainers qualify a new release with `pnpm codex:qualify` (#982).
- Codex CLI 0.159.3, npm's `latest` since 2026-09-30, is admitted on Linux x64 (#1325). It
  passed `pnpm codex:qualify` against 0.159.2 and a hosted local-agent study; its only change is
  in Codex's interactive TUI. Before, a current `npm install -g @openai/codex` was refused by
  Codex participants and Codex-account analysis on Linux x64.
- `humanish verify` adds a `RUN_NOT_FINISHED` warning when the run did not finish, for example a
  run killed mid-way (#1063). `ok`, `checks` and `shareSafety` do not change.
- `humanish lab preflight` journals its probe desktop, and `humanish reclaim --preflight` kills
  probe desktops a killed preflight left running (#989). `reclaim --run` on an unreadable receipts
  file now fails with `HUMANISH_RECLAIM_RECEIPTS_UNREADABLE` and keeps the file.
- `RunLabOptions` has typed homes for what callers passed through the four route hook bags (#1036):
  `env`, `scorer`, `analysisSignal`, `prepareDesktop`, `onEvent`, `onStream`, `createProvider`,
  `inProcess` and `rerun.participantIds`. An option the route cannot honor is refused with
  `HUMANISH_LAB_OPTION_UNSUPPORTED`. `inProcess` on more than one participant is refused by the
  planner with `HUMANISH_CUA_LAB_FANOUT_INVALID`, and the message names `RunLabOptions.inProcess`
  (#1268).
- `status.json`'s `outcome` gains `ok` and `execution: { succeeded, failures: [{ kind, message }] }`
  once the Observer has rendered (#1205). `verdict` stays what the participants experienced;
  `execution` says whether the run worked, and `ok` reads both under the route's policy.
- Run cost now covers every route. Scripted runs price a provisioned clone's subject desktop and
  record an explicit $0 for spend-free runs (#1039). Terminal runs price their sandbox time and keep
  Codex tokens unpriced (#1041). Concurrent shared-world runs price each seat and the shared app's
  desktop (#1045). `humanish stats` shows these instead of an unknown.
- Machine-local personas in `.humanish/local/personas/` are read; a committed persona with the same
  id wins (#1117).

### Changed

- A computer-use run whose local-agent CLI is not on PATH is refused as
  `HUMANISH_CUA_LAB_AGENT_MISSING`, and one whose agent is signed out or cannot report its sign-in
  status as `HUMANISH_CUA_LAB_AGENT_SIGNIN_REQUIRED` (new codes, #1275, #1306). Before, both were
  refused as `HUMANISH_CUA_LAB_KEYS_MISSING`, which a missing API key keeps.
- `lab run` checks this machine before it loads a declared scorer (#1269, #1280): the keys and
  runtime auth, subject env, the local agent's sign-in and spend caps on computer-use,
  shared-world and terminal labs. A refusal from those checks no longer runs the scorer's module
  code, and the CLI no longer prints the scorer warning or the analysis-budget line for it. On a
  run that passes them, the local-tree "packed" line and the fan-out preflight table print before
  the scorer warning. The refusal JSON is unchanged.
- Dry runs no longer look up provider keys (#1286): no `gh auth token`, no key-store reads and no
  `humanish keys:` lines. A scorer that reads keys from `process.env` during a dry run sees only
  the environment and `--env-file`.
- Refusal, warning, help and run text says "participant" where it said "lane" or "seat" (#1283,
  #1289, #1290, #1292, #1312), and "lab" where it meant the lab file (#1276), without em dashes.
  Help no longer cites issue numbers (#1005). Codes, flags, keys, strategy values and ids keep their
  spelling (`actors[0].lanes`, `per-lane-worlds`, `lane-01`), and `--lanes` shows its argument as
  `<participant-ids>`. Synthetic dry-run bundles, `humanish verify` findings and Observer text say
  "participant" too, and the synthetic route says "simulated participant" (#1298); recorded bundles
  keep their old wording. The README, the site docs, the bundled skill and the contract docs follow
  (#1293, #1294, #1295, #1297). The hosted-browser geometry warnings say "for participant <id>", and
  `HUMANISH_CUA_LAB_DEVICE_GEOMETRY` says "the participant's device geometry" (#1301). The TUI lab
  screen shows the per-participant cap as `$N per participant` (#1312). Code that matches on message
  text needs the new wording.
- The Observer labels each computer-use participant card with its persona, single and fan-out
  runs alike (#1300). Fan-out cards recorded after #1290 showed `CUA participant <id>: <lab>`, and
  single-participant cards showed `CUA browser — <lab>`. The card now reads the participant id
  and persona from the stream, so older bundles render the same way.
- A library `runLab` call on a preview lab (subject `this-repo`) is refused by the planner when
  `count` is not a positive integer or the run would be live, with the same codes (#1279). The live
  refusal reads "this-repo labs are dry-run only; use a clone or app-url subject for a live run."
  Both come before the project-directory check, as on the other routes.
- When a local Codex release is not admitted, `humanish doctor` and its post-run analysis row name
  the release they found, the releases this host accepts, and the install command for the newest,
  for example `npm install -g @openai/codex@0.159.3` (#1305).
- `humanish init`'s next-step hints say `npx humanish …` (#1305). A dev-dependency install puts no
  `humanish` on PATH, so a bare `humanish` could run a stale global copy.
- Three computer-use stop reasons are reworded: the account-billing reason, the non-finite estimate
  reason and the gave-up rule (#1002).
- The Codex app-server UI's `promptDigest` in `state.json` and `/state` is the 12-hex SHA-256
  evidence digest, matching `summary.json` (#1075). It was an 8-character FNV hash.
- `humanish verify` caches its encoded-text scan per process, by the scanned text's hash, so a
  repeated check of an unchanged file is fast (#1245). Results are unchanged: 173 retained real runs
  and 102,000 equivalence inputs graded identically.
- Refusal and check messages name a lab's route instead of its older backend name, for example
  "this lab resolved to the terminal route" (#1216). Error codes and JSON fields are unchanged.
- A computer-use or shared-world participant whose session passed but whose model provider's
  cleanup could not be confirmed reads pass, with `ok: false` and a provider-cleanup execution
  failure in `status.json` (#1215). Before, it read pass on a single lane but fail inside a
  fan-out.
- A live terminal run that exceeds its spend cap keeps the agent's own verdict, for example pass
  when it reported a passing marker (#1215). The run still fails (`ok: false`,
  `HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED`), and the review and `status.json` name the cap. Before,
  the cap rewrote the agent's status to failed.
- The first request of an OpenAI computer-use session shows the model the opening screen and caps
  its output at 1024 tokens (#1049). It sometimes spent its whole output allowance and produced no
  action (2 of 38 live sessions on 2026-09-30).
- A capped computer-use session stops before its next request when a reply reports no usage (stop
  cause `usage_unreported`), and books a lost request at its worst case before resending (#1018).
  In a test without usage, a $1-capped session used to send 16,895 requests and never stop.
- A reply cut off by the output limit is resent once instead of ending the lane (#1035).
- `humanish init` writes nine fewer files (#901): `humanish/config.ts`, `policies/*`,
  `review/vocabulary.yaml`, `milestones.yaml`, `adapters/app.ts`, a login fixture and two
  directories. No code read them.
- `lab run --count N` above an undeclared `execution.concurrency` runs every lane at once (#1071).
  The parser no longer fills concurrency for independent computer-use lanes; shared-world labs still
  get the fill.
- Single-lane computer-use bundles name the lane's runner (hosted desktop, local VM or in-process)
  instead of always saying "hosted desktop browser" (#1081). The Observer shows the new text.
- The product name is lowercase in output values (#1046): the Observer page title, the Library and
  app-server UI titles, the `review.md` heading, the dry-run summary, the `[humanish] ` feedback issue
  prefix, and CLI help and error text.
- `humanish cleanup` never reports a `killed` resource (#1155). It inspects recorded evidence;
  killing is `humanish reclaim`'s job. The human summary no longer shows a killed count, and in
  `--json` `summary.killed` is always 0.
- `humanish stats` no longer counts a run under `analysisHistoryUncertainRuns` because its run cost
  contradicts account billing (`RUN_ACCOUNT_COST_CONTRADICTION`) (#1153). The warning still nulls the
  run estimate.
- `humanish verify`'s shared-world check text describes concurrent evidence, the lab parser's
  `lanes`/`roster` errors list every key it accepts, and the terminal-agent error points to `runLab`
  (#1156).
- The latest pointer's `updatedAt` is the write time, and live flushes no longer rewrite
  `latest.json` (#965, #994, #1001).
- Sandbox receipts gain `provider` (#962); reclaim reports `unsupported-provider` for providers it
  cannot handle.
- `execution.desktop.codexAppServer` now warns wherever it is set; no route reads it (#968).

### Fixes

- `humanish analyze` uses an OpenAI key saved with `humanish keys set` or in
  `.humanish/local/provider.env` (#1314). It read only the environment, so it failed with
  `ANALYSIS_API_KEY_MISSING` for a key that `lab run` found. A dry run and the Codex analyst still
  read no key.
- Key discovery runs `gh auth token` without any provider key in its environment (#1315). It
  used to inherit the process environment, including keys exported by the user and keys
  discovery had just read from `.humanish/local/provider.env` and `~/.e2b/config.json`.
- `humanish lab run --rerun-failed-from <run> --lanes <ids>`, the example in `lab run --help`,
  no longer prints a `DeprecationWarning` for `RunLabOptions.rerun.laneIds` (#1309). The CLI
  passes the selection as `rerun.participantIds`.
- A live terminal lab without `E2B_API_KEY` fails with `HUMANISH_TERMINAL_LAB_KEYS_MISSING` before
  it creates a run directory (#1261). Before, it created the run and failed at sandbox create.
- A local-tree run whose `tar` step or archive read fails no longer leaves a `humanish-local-tree-*`
  directory, which could hold a partial archive of the working tree, in the system temp dir
  (#1265).
- Shared-world labs with a `local-agent` actor run each participant on the signed-in agent
  (#1278). They ran on the OpenAI API whatever the lab declared, so an existing local-agent
  shared-world lab now bills the agent's account, not `OPENAI_API_KEY`. External-public labs still
  need `OPENAI_API_KEY` for the lobby-code reader. An agent CLI that is not on PATH is refused as
  `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_AGENT_MISSING`, a signed-out one as
  `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_AGENT_SIGNIN_REQUIRED`, and a ChatGPT-account Codex with a
  dollar cap as `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_UNPRICED_CAP` (new codes, #1278, #1306).
- `humanish doctor --lab` and the TUI treat a shared-world lab with a `local-agent` actor as
  supported (#1316, after #1278). Doctor reported it as unsupported and listed no keys, so the TUI
  could show its keys as ready. It now asks for `E2B_API_KEY`, plus `OPENAI_API_KEY` on an
  external-public plane, and shows the agent's sign-in row as it does for computer use.
- A provisioned shared-world run whose desktop module fails to load names that failure (#1274),
  and adds "The run bundle it left failed verification." when the Observer also failed. It used to
  say only "Run bundle failed verification." The code stays
  `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED`.
- The desktop media worker's output reader stops at the first terminal message in a chunk, and
  stops the worker as soon as an unterminated tail passes 8 KiB instead of one chunk later (#1291).
- The preview and concurrent shared-world routes (#1012) and the analysis entry points (#1059)
  bind a symlinked project to its physical path, as the other routes do. A run or analysis whose
  project alias is retargeted midway completes in the original project, and `result.cwd` is the
  physical path.
- The in-sandbox comms catch exits when its inbox port is busy (#909). It used to pass its health
  check and serve no inbox.
- On a Linux host with no display (`DISPLAY` and `WAYLAND_DISPLAY` unset) or no `xdg-open`, opening
  the Observer reports `opened: no` with a warning that names the Observer's path (#1305). It used
  to report `opened: yes`.
- `humanish serve --safe` no longer serves a file that changed after the run was verified (#1206).
  It used to keep a run's `share_ready` verdict for 30 seconds while only `run.json` was
  unchanged, so a file added to or rewritten in that run was served in that window. Any change to
  a run's files, or to a served file's bytes, now re-verifies the run first.
- Scripted-browser `waitForText`, `assertText` and `expect.text` steps check the page text
  (#1171). They passed on every page before: the page evaluated the predicate as an expression and
  got back the function itself, which is truthy. See Breaking.
- When `Sandbox.kill(id)` answers `false` (the SDK's answer for an id it no longer knows) or throws
  a `SandboxNotFoundError`, every route and `humanish reclaim` record the sandbox as already gone
  (#1014, #1164, #1302). Before, the terminal route, the scripted and shared-world subjects, and the
  `lab preflight` probe recorded a failed kill: a terminal run failed with
  `HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN`, and preflight returned
  `HUMANISH_LAB_PREFLIGHT_TEARDOWN_FAILED` and kept its receipt journal. The computer-use lane read
  `false` as gone but recorded a thrown `SandboxNotFoundError` as a failed release.
- Any other error thrown by `Sandbox.kill(id)` leaves the release unconfirmed on every route and in
  `humanish reclaim`, whatever its message says (#1302). Against v0.105.0, `humanish reclaim` now
  reads only a `false` return or a `SandboxNotFoundError` as already gone. It used to also count a
  thrown error whose message contained "not found", "does not exist" or "404", text that also
  appears in unrelated failures such as a 404 inside a trace id.
- When `Sandbox.kill(id)` answers with neither true nor false, every route and `humanish reclaim`
  record the release as unconfirmed (#1014, #1164). Before, the terminal route, the scripted and
  shared-world subjects and the `lab preflight` probe counted it as killed, and `humanish reclaim`
  recorded it as already gone. The computer-use lane already read it as unconfirmed.
- A live computer-use or scripted run whose session failed with an empty error message reads fail
  (#1188). Its verdict and `status.json` used to read `contract_proof_only` while the result had
  already failed.
- Local browser studies wait for a paint after the guest's first navigation before the first
  capture (#1177). The wait resolved at once, for the same reason as the scripted text checks.
- The try-live lab and the AGENTS.md section that `humanish init` writes describe the $2 cap as a
  cap on estimated model spend: the run stops before its next model request once the estimate
  passes $2, and hosted desktop time is billed separately (#1182). They used to call it a
  fail-closed ceiling.
- `humanish lab run` and `lab watch` refuse a lab the planner rejects before loading its declared
  review scorer (#1190). A refused run no longer executes the scorer's host code, and no longer
  prints the scorer warning or the analysis-budget notice.
- A Chromium desktop lane waits up to 30 s for Chrome's DevTools port after launch and records the
  wait as a timed `cua-lab.browser.devtools.completed` phase (#1194). A device-emulated lane whose
  Chrome exits or never answers fails with the reason and the browser log's last line; other
  lanes continue with a warning.
- `humanish lab run` and `humanish watch <lab>` refuse a bad `--count`, `--sims`, `--port` or
  `--lanes` before loading a declared review scorer (#1158). A refused run no longer executes the
  scorer's host code, and no longer prints the scorer warning or the analysis-budget notice.
- `humanish init` on a machine where only Claude Code is signed in writes a `try-live` lab that runs
  on Claude Code (#1143). Before, the lab named no agent and fell back to Codex.
- First run works again for Codex-signed-in machines: `humanish init` no longer writes a dollar cap
  into the account-billed `try-live` lab, which preflight had refused since 0.101.0 (#973).
- `humanish init` finds an OpenAI key saved with `humanish keys set` when it picks the try-live
  participant; it used to read only the environment (#991).
- Non-ASCII text (accents, em dashes, emoji, CJK) types on stock E2B desktops (#1111). It failed
  with "no xclip/xsel clipboard utility available for paste fallback".
- Shared-world seats without their own persona now take `actors[0].persona`, as independent lanes
  already did (#953). Behavior change for labs that relied on seats running persona-less.
- Shared-world seats without an `id` now get their inbox instruction: the parser fills email
  recipients with the route's seat ids (`role-NN`); before, it filled `lane-NN` and no unnamed seat
  matched (#969).
- A one-seat or count-only external-public shared-world roster gets the two-seat roster refusal
  instead of the concurrency advice that led to it (#1139).
- A failing Observer gate on a provisioned shared-world plane stops the run before any participant
  starts, and a watch whose live Observer cannot start returns
  `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED` (exit 2) instead of `HUMANISH_UNEXPECTED` (#1007).
- Concurrent shared-world runs write their in-progress bundle without an attached Observer, so a
  killed headless run leaves a `run.json` (#1016).
- The first status record is written before any sandbox is acquired, so `humanish runs` can classify
  a run killed in that window (#984).
- A run id stays free when run directory preparation fails; retries used to get
  `HUMANISH_RUN_ID_IN_USE` (#1024).
- An invalid `--port` is refused before the run starts, and every CLI path shows the Observer the
  run rendered instead of re-rendering by id (#1026).
- `humanish analyze` on a preview run returns `ANALYSIS_REQUIRES_LIVE_RUN` before asking for a cost
  limit (#1011).
- The analysis admission estimate prices each capture by its size (#1037). It charged every image
  3,000 tokens, which refused a $1.53 analysis at an estimated $3.42.
- E2B desktop command failures surface: the "Browser-state observer unavailable" warning fires when
  its probe fails, and the timeout, geometry and camera probes report their errors (#1014).
- The serve pipeline installs Node from the pinned archive with a 5-minute bound and one retry on
  curl exit 28, instead of apt, which once stalled a lane for 10 minutes (#1058).
- Claude Code participants pair each result with its turn and interrupt a stalled turn before the
  retry; a late result can no longer answer the next request (#983).
- Claude Code participants now count cached prompt tokens in `input`; it used to record only the
  uncached tail (e.g. 2 of 32,748 tokens) (#959).
- Run detail reads go through the contained-file reader, an Observer path outside the project stays
  absolute, and gpt-6-astra estimates carry their own rate label (#1065).
- Linux ARM64 hosts are refused by the local browser runtime up front; they passed setup and then
  failed at the first request (#1117).
- The TUI offers Open in Observer on a running run once its bundle exists (#1117).
- Computer-use traces note app state seen inside a dwell window and in the closing observation
  (#988).
- Loop fixes (#971): post-dwell observations get the frame check; dwell and backstop hints are
  combined; the mid-run account-billing check counts output limits; a study-budget crossing during an
  interrupted response is recorded; a stalled request is aborted before its resend.
- Terminal studies retry the sandbox create once after a transient E2B error, like desktop studies
  (#946).
- A default post-run analysis whose estimate is over the default $3 limit no longer fails the run;
  the CLI prints the `humanish analyze` command that runs it (#947).
- OpenAI 400s now name their error code and rejected parameter in the participant's reason (#948).
- Live scripted-browser labs with a clone subject journal their subject sandbox, so
  `humanish reclaim` can kill it after an interrupted run (#950).
- OpenAI `wheel` clicks run as middle clicks and `back`/`forward` as history shortcuts; all three
  used to run as left clicks (#951).
- Computer-use participants can hold modifier keys during pointer actions (shift-click, ctrl-click);
  they used to be dropped silently (#967).
- An OpenAI usage-policy refusal (400 invalid_prompt) ends the participant with its own stop cause,
  `provider_refused_prompt`; study analysis no longer rejects participants that stopped with
  `usage_unreported` (#970).

### Package

- The package ships `CONTEXT.md`, `TELEMETRY.md` and `docs/decisions/`, which the shipped README,
  ARCHITECTURE.md and AGENTS.md link (#1189). Links from shipped docs to files the package leaves
  out are GitHub URLs, so they resolve from `node_modules`.
- The package ships `ARCHITECTURE.md` (#961), which the README links, and the library `examples/`
  (#976).
- The tarball ships no source maps (#906). The maps pointed at `src/` files the package does not
  ship. `npm pack --dry-run` on main 0f11d0eb gives 2.71 MB packed, 7.38 MB unpacked and 834 files,
  including the docs and examples above. 0.105.0 published 2.99 MB, 9.57 MB and 661 files, 188 of
  them source maps.
- The `zod` dependency is a range npm can install (#924). #896 had written pnpm's `catalog:`
  protocol into the published manifest; 0.105.0 was not affected.
- `CHANGELOG.md` ships in the package (#916), and the per-version release notes folder is gone.
- Dependencies move to their latest releases (#896); the Observer moves to `@base-ui/react` 1.8.0
  (#908).

## 0.105.0: Rich participant backgrounds (2026-09-28)

Personas now support a multiline `background` for relevant history, habits, motivations and constraints. It preserves paragraphs up to 32 KiB and rejects oversized context instead of silently truncating it. Missing files, unsupported fields and shortened legacy fields now produce diagnostics.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.105.0)

## 0.104.3: SMTP capture for local app studies (2026-09-28)

`humanish comms catch --smtp-port 1025` now supports SMTP verification mail for apps hosted by the study operator. The command previously rejected its documented SMTP option. It now validates the port and fails startup if SMTP cannot bind, instead of leaving misleading healthy HTTP status.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.3)

## 0.104.2: Preserve desktop capture timestamps (2026-09-28)

Desktop recordings now preserve the capture input’s microsecond timestamps and explicitly use variable-frame-rate output across local and E2B FFmpeg versions. This avoids dropping closely spaced captured frames or filling genuine gaps with duplicates. Existing recordings are unchanged.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.2)

## 0.104.1: Recording startup (2026-09-28)

Mixed desktop recording no longer waits behind the recording mix's default
two-second PulseAudio buffer. Its null sink now uses the supported no-rewind mode,
which bounds that buffer to 50 ms. FFmpeg settings, timestamps, startup ordering
and resource ownership are unchanged; screen-only recording uses the same path
as before.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.1)

## 0.104.0: Local captured inboxes (2026-09-28)

Local browser participants can now create an account, open their assigned inbox
and follow a verification link without mailbox-provider credentials. Start
`humanish comms catch`, configure the app to send email to that catch, and declare
`comms.email.external.catchBaseUrl` in the local lab. Doctor checks the catch's
recipient routes and explains setup failures before a participant starts.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.104.0)

## 0.103.2: Adjacent ending evidence for analysis (2026-09-28)

A participant can inspect a result and then scroll or navigate before ending.
Analysis now prioritizes the preceding screenshot alongside the final view,
after beginning and explicit failure context. Previously, session sampling
could omit that nearby result while retaining a final heading or navigation page.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.103.2)

## 0.103.1: Fairer analysis capture allocation (2026-09-27)

Analysis now gives reclaimed screenshot slots to eligible participants with
fewer admitted images. Previously, a participant whose images exceeded its
initial byte reservation could receive only its ending capture while other
participants received extra captures, even with enough image bytes remaining.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.103.1)

## 0.103.0: Optional desktop video and audio recording (2026-09-27)

Computer-use studies can retain an MP4 alongside screenshots, actions,
participant feedback and analysis:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.103.0)

## 0.102.0: Optional participant camera and speech (2026-09-26)

Codex participants can listen and speak while using a conferencing app. The same
continuing conversation handles browser actions and spoken replies on local
Firecracker and hosted E2B desktops. No separate conversational agent or speech
API key is required. Codex inference still uses the selected remote account.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.102.0)

## 0.101.0: Shared Codex UI tools (2026-09-25)

Codex participants now interact through a native Humanish UI tool. One continuing
Codex conversation can call the tool repeatedly, inspect each new screenshot,
and give its final feedback. Humanish executes and records the inputs, including
rejected or skipped actions, before returning their actual status to Codex.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.101.0)

## 0.100.1: Participant conversation continuity (2026-09-25)

Local Codex participants now keep one conversation for their entire study,
including closing feedback. Previously, each screenshot started a new thread
with only eight turns of summarized history. Earlier observations, actions and
participant context now remain in the Codex conversation, with Codex managing
context compaction.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.100.1)

## 0.100.0: Local study setup and startup reliability (2026-09-25)

Configure a local browser study during setup:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.100.0)

## 0.99.1: Recover from rejected browser input (2026-09-24)

A participant can now recover when the desktop explicitly rejects an action
before sending any input. For example, typing without an editable field focused
previously ended a local browser study with a harness error, even though the
browser remained usable.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.99.1)

## 0.99.0: Local browser studies on Apple Silicon Macs (2026-09-24)

Local browser studies now run on supported Apple Silicon Macs using Lima and ARM64 Firecracker desktops, with the same participants, Observer recordings and automatic analysis as Linux.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.99.0)

## 0.98.0: Local browser studies on Linux (2026-09-24)

Explicit local browser labs now run from the installed CLI and TUI. On Linux
x64 with Docker/KVM and a supported Codex ChatGPT login, isolated Firecracker
participants use the normal scheduler, recordings, Observer and automatic
analysis without E2B or OpenAI API keys. Codex inference remains remote and
consumes account quota; dollar cost is unknown.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.98.0)

## 0.97.0: Codex account reports on Linux (2026-09-23)

Saved studies can use an existing Codex ChatGPT login for their separate
findings report. Select it explicitly:

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.97.0/docs/release/0.97.0-codex-account-analysis.md)

## 0.96.1: Preserve browser navigation (2026-09-20)

Hosted browser studies now measure physical client bounds with `xwininfo`.
The older `xdotool` build on hosted desktops can count window decorations twice,
incorrectly reporting that a visible browser extends beyond the captured screen.
That false reading could trigger fullscreen, hiding the tabs and address bar
participants use to move between an application and their study inbox.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.96.1/docs/release/0.96.1-browser-navigation.md)

## 0.96.0: Real email receiving (2026-09-21)

Browser studies can now receive real email through AgentMail, with a fresh inbox for each participant.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.96.0)

## 0.95.0: Connections setup (2026-09-20)

Open `humanish tui` and press **c** to configure AgentMail. **Add API key**
opens a hidden terminal prompt, then returns to Connections. Ctrl+C cancels
without changing the existing key or profile. Existing keys can be reused or
replaced. Entry uses the host's key store, outside the TUI rendering contract.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.95.0)

## 0.94.0: Reliability (2026-09-18)

Long analysis requests now honor Humanish's configured deadline instead of
ending early at the HTTP client's header timeout. The default deadline is ten
minutes. Omitted output settings use up to 32,768 tokens when the existing
declared budget admits that allowance, otherwise retaining 16,384. Explicit
output settings remain exact. This adds no retries or automatic budget increase.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.94.0/docs/release/0.94.0-reliability.md)

## 0.93.1: Observer review controls (2026-09-17)

Findings now starts with a compact overview: finding count, participants
included, analyzed outcomes, and sampled captures. The original narrative
remains under **Study summary**. Coverage notes, methodology and separate
automatic-attempt status are available under **Coverage & analysis details**.
A failed automatic attempt no longer replaces the status of a usable report.
Running or unknown execution, changed evidence, and exceeded admission limits
remain visible. Outcome counts are analysis judgments, not verified success
rates; stale reports do not use current recordings as their denominators.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.93.1/docs/release/0.93.1-observer-review-controls.md)

## 0.93.0: Global playback (2026-09-16)

The Observer uses one study clock across the participant grid and individual
recordings. Seek halfway through a study, open a participant, then scrub back:
returning to the grid shows every participant at that same time. Playback also
continues through ordinary participant navigation and browser Back/Forward.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.93.0/docs/release/0.93.0-global-playback.md)

## 0.92.0: Grid playback (2026-09-16)

Play and scrub all recorded participants together in the Observer grid.
The transport includes pause, playback speed and a shared recording timeline.
Opening a displayed capture lands on its exact frame; returning restores the
grid's time and participant page, paused.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.92.0/docs/release/0.92.0-grid-playback.md)

## 0.91.1: Study review polish (2026-09-15)

Study cost summaries include retained analysis attempts alongside participant
and desktop estimates. Reusing a saved analysis does not add another charge;
separate retries do. Missing prices and incomplete histories remain explicit.
The existing stats JSON fields keep their original participant-and-desktop
meaning; additive cost fields provide the combined retained estimate.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.91.1/docs/release/0.91.1-study-review-polish.md)

## 0.91.0: Analysis quality and defaults (2026-09-15)

Supported live studies now request analysis when the recording finishes, using
`gpt-6-astra` with high reasoning and a separate $3 admission estimate limit.
The CLI, preflight and TUI disclose that budget. Set `review.analysis: false` to
disable the extra request, or supply an analysis mapping with `maxCostUsd` to
customize it. The estimate is additional to participant and desktop costs and
is not a provider billing cap. Missing default credentials record a skip while
preserving a successful recording; explicit analysis failures remain failures.
Startup failures with no retained participant activity skip default analysis.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.91.0/docs/release/0.91.0-analysis-quality-and-defaults.md)

## 0.90.0: Findings after live studies (2026-09-14)

Labs can opt into independent analysis after their recording finishes with
`review.analysis.maxCostUsd`. The command waits for the result; the TUI and
Observer show analysis separately from participant execution and task outcomes.
Without the setting, run behavior stays unchanged.

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.90.0/docs/release/0.90.0-automatic-analysis.md)

## 0.89.1: Finished analysis notice (2026-09-15)

Observer now labels a partial analysis result **“Analysis finished with
limitations.”** The previous notice described findings as covering evidence
“included so far,” which could make a finished analysis appear to be running.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.89.1)

## 0.89.0: Evidence-linked study findings (2026-09-14)

Completed studies can now produce ranked findings with links to the participant
events and captures that support them. Observer keeps Participants and Findings
inside the same study shell, with the recording grid, original participant
feedback and playback controls available throughout the review.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.89.0)

## 0.88.2: Sequential study model thresholds (2026-09-14)

Sequential shared-world studies now apply the model-spend thresholds they previously accepted without enforcing. The fix covers computer-use participants sharing a clone or local-tree subject with concurrency 1.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.88.2)

## 0.88.1: Completion evidence and a runnable local-app example (2026-09-12)

When a computer-use participant says it finished, Humanish now labels that completion as **participant-reported**. A recorded `stopWhen` match or completed dwell window identifies a **recorded completion condition**. Missing, malformed or conflicting detail is labeled unavailable; zero completions use **0/N recorded completions**.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.88.1)

## 0.88.0: See what ended a study (2026-09-11)

Computer-use studies now show a diagnostic category and recorded stop cause in CLI output. Fan-out results preserve each participant's ending, and newly generated review summaries use the same recorded causes. Successful dry-runs are identified as contract previews.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.88.0)

## 0.87.0: Participant endings and phone review (2026-09-10)

Humanish 0.87.0 makes participant endings easier to interpret and saved recordings easier to review on a phone.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.87.0)

## 0.86.1: Task preflight and saved recordings (2026-09-09)

Humanish now refuses a task protocol when the chosen execution path cannot run
it. Previously, a shared-world, terminal, scripted or synthetic lab could accept
`actors[0].tasks` and then omit those tasks during execution. Preflight now names
the unsupported field before creating a run or starting hooks, processes,
desktops or model requests. Remove `tasks` only when you intend a mission-only
study, or choose a supported per-lane computer-use route.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.86.1)

## 0.86.0: Participant assignments and exact action review (2026-09-09)

The Observer now shows each participant's assigned mission and lane focus.
Expand **Assigned task** in the player or participant details to read the
instructions. Computer-use runs also include their participant-facing task
goals. Hidden success checks and runtime access details stay outside this
assignment. Older recordings explicitly say when an assignment was not recorded.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.86.0)

## 0.85.1: Observer review continuity (2026-09-09)

The Observer review flow now carries the selected evidence between views:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.85.1)

## 0.85.0: Watch and review complete screens (2026-09-09)

Observer now shows portrait and desktop captures at their original proportions,
with equal-height grid previews and a compact caption below each screen. Live
labels and controls leave the captured pixels clear. A stable Info button opens
participant details, labeled Pin/Compare actions and recorded notices.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.85.0)

## 0.84.1: Run feedback checks from exported evidence (2026-09-07)

Generated feedback commands now work from a standalone exported evidence workspace:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.84.1)

## 0.84.0: Share evidence and keep readable originals (2026-09-07)

Keep readable local evidence and export a separate shareable workspace:

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.84.0)

## 0.83.2 (2026-09-07)

Concurrent computer-use studies now preserve declared reasoning effort, output-token limits and the shared actor-model budget. Host startup failures report their actual cause instead of a misleading handoff timeout. Linux browser profiles use system window decorations, with a measured fullscreen fallback for narrow desktops.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.83.2)

## 0.83.1 (2026-09-06)

Desktop CLI studies that leave product installation to the participant now prepare Node/npm before the terminal opens. Two fresh hosted desktops verified the runtime becomes available while the subject product remains uninstalled.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.83.1)

## 0.83.0 (2026-09-06)

Humanish 0.83.0 adds a per-response output limit and fixes three ways harness behavior could distort a computer-use study.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.83.0)

## 0.82.1 (2026-09-05)

Humanish 0.82.1 corrects computer-use sessions that were cut short by provider output limits. A response with no remaining actions no longer counts as successful completion when the provider explicitly says it is incomplete. Usage and partial text are preserved; actions and debrief are skipped.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.82.1)

## 0.82.0 (2026-09-05)

Humanish 0.82.0 makes repeated studies easier to reproduce and their evidence easier to interpret.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.82.0)

## 0.80.0 (2026-09-04)

v0.80.0 — the observation window on every desktop route, and a sandbox request that cannot exceed the cap

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.80.0)

## 0.79.0 (2026-09-04)

v0.79.0 — a study can hold and watch, and a participant can have a camera

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.79.0)

## 0.78.0 (2026-09-04)

v0.78.0 — the CLI no longer lingers after a run: @e2b/desktop 2.3.3, and doctor says which SDK you have

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.78.0)

## 0.77.0 (2026-09-04)

v0.77.0 — a phone participant's later tab is a phone tab too; a transient sandbox error is retried once

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.77.0)

## 0.76.0: A phone participant at a real 414 px viewport, with touch and a mobile user agent (2026-09-03)

v0.76.0 — a phone participant at a real 414 px viewport, with touch and a mobile user agent

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.76.0)

## 0.75.0: The task funnel measures every desktop, installs retry once, Sol priced at the live sheet (2026-09-03)

v0.75.0 — the task funnel measures every desktop, installs retry once, Sol priced at the live sheet

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.75.0)

## 0.74.0: Run and watch write the same bundle (2026-09-01)

`humanish run` renders observer/index.html after a successful run, the way
`watch` does, so the same lab produces the same bundle whichever command
ran it. A render failure is a warning on the result, never a failed run.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.74.0)

## 0.73.0: A run bundle exports (2026-09-01)

humanish export renders the Observer for a bundle that has none, which is
every bundle `run` writes, so the everyday command's bundles can be sent.
Found by the 0.72.0 release:dogfood participant on its first export.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.73.0)

## 0.72.0: The cold-start Claude path works again, and is measured (2026-09-01)

The one-shot Claude participant had been failing on turn one since its
prompt sat after --allowedTools; fixed with --, kept reachable as
HUMANISH_LOCAL_AGENT_ONE_SHOT=1 for measurement, session stays the default.
Receipt: no difference on the two-table starter lab, 3 of 3 each; on a
harder mission, session 4 of 4 against one-shot 0 of 4 in 300 s and 1 of 4
in 600 s.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.72.0)

## 0.71.0: A taken port is named, and a lingering process can be too (2026-09-01)

A port somebody already holds reports HUMANISH_PORT_IN_USE (serve:
HUMANISH_SERVE_PORT_IN_USE) with the port and whether another humanish
process holds it, instead of HUMANISH_UNEXPECTED. HUMANISH_DEBUG_HANDLES=1
prints Node's active resources after a command settles, for the run whose
CLI lingered sixteen minutes past its result.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.71.0)

## 0.70.0: An export says what verify said (2026-09-01)

humanish export writes verify's share status into the file it produces
(publicSafety.share, additive and optional on the frozen observer-data
schema), and the Observer's chip renders it, so a share_ready export no
longer reads local_only.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.70.0)

## 0.69.0: Export, the closing line, and reports that count as friction (2026-09-01)

`humanish export --run <id>` writes one self-contained Observer with
screenshots inlined, after verify and the share gate; --local-only
watermarks. Free-text computer-use participants label their own ending
(REACHED THE GOAL. / DID NOT REACH THE GOAL. / BLOCKED.) and the trace
records it; adherence 6 of 6 on the benchmark rerun, with recall and
precision unchanged (14 of 15, 0 invented). A finished participant's report
of defects or confusion now counts as friction and becomes a feedback
candidate. drawDB precision arm: 11 of 12 claims confirmed in source.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.69.0)

## 0.68.0: Stats, the participant's own word, and no person profile (2026-09-01)

`humanish stats` rolls up cost, outcomes, and durations across run history
with estimates labelled and unknown costs counted as unknown. A
schema-constrained participant declares reached / not_reached / blocked on
its final turn and the lane reads that before the closing paragraph
(verified live). "blocked" no longer reads as "blocked on an approval".
Every telemetry event asks for no person profile.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.68.0)

## 0.67.0: The scan stops refusing finished runs, and a hung turn is named (2026-09-01)

Five of five completed live runs were refused as "not a credible pass" on
sentences like "I could not read the full description"; the verdict scan
now strips perception verbs after "can't" and reads "encountered no ..." as
a negation. A hung provider turn is retried once and then ends the lane as
harness_error with its name on it; a hung wait is skipped with a notice.
Claude Code participants keep one session per run. The study-participant
telemetry marker is actually set.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.67.0)

## 0.66.0: The funnel tells us what a study was, and a refused lane stays refused (2026-09-01)

Telemetry now reports what a study was: mode, outcome, starter lab, brain
route, and our own error code, with ok meaning exit 0. Every event asks the
receiver not to derive a location, and the project discards client IPs.
1,359 study events before this release carried none of that.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.66.0)

## 0.20.0: External-public shared-world plane + CDP lobby-code handoff (2026-08-02)

Additive minor release. No breaking change to the provisioned-getHost path, its schema, or its verify
asserts (byte-stable; a snapshot regression pins it).

[Release notes](https://github.com/danielgwilson/humanish/blob/v0.20.0/docs/release/0.20.0-external-public-shared-world.md)
