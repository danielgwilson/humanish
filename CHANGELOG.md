# Changelog

Newest first. Each entry is the opening paragraph of that version's release notes; the link holds
the full notes. Versions not listed here (0.1.1 through 0.65.0 except 0.20.0, and 0.81.0) are
tagged without notes.

The Unreleased section holds the full notes for the next version until it is tagged.

## Unreleased

### Added

- `humanish verify` warns when a live participant's context did not grow: its prompt stayed about
  the same size from turn 2 on, so it likely answered each turn without the earlier ones. The
  warning names the participant and the token count it stayed near. It needs six turns with
  recorded usage, and fires when the last three turns' median prompt is under 1.1 times that of
  turns 2 to 4. Across 113 distinct live participant traces the lowest was 1.21; a zero-data-retention
  computer-use participant that kept about 3,100 tokens for 527 turns is near 1.0. The warning does
  not change share safety.
- `humanish study list`, `humanish study show <study>` and `humanish study check <study>` list the
  studies in a project, show one study's parsed file and warnings, and check its file and named
  endpoints. `--study <study>` selects a study on `doctor`, `stats`, `watch`, `comms check` and
  `comms configure`.
- `humanish migrate [--dry-run] [--json] [path…]` converts `humanish.lab.v2` study files to
  `humanish.study.v3`.
  - Without paths it converts every v2 file in the six study directories. A file under a `labs/`
    directory moves to the matching `studies/` directory; any other file is rewritten in place. A v3
    file is skipped.
  - It prints every source, destination, moved key and dropped key before it writes, and
    `--dry-run` writes nothing. A dropped key is one the study's route never reads, such as a
    terminal study's `execution.timeoutMs`; the report gives its value and comment.
  - Comments move with their keys. A file that uses YAML anchors is refused with the line.
  - It refuses a file whose v3 form would parse or plan differently, and a name another file
    already uses, naming both. A second run changes nothing.
  - An in-place rewrite deletes the original once the new file is in place and the original is
    checked. If a failure leaves the original out of place, it is kept as `<name>.v2.bak` and listed.
    On a filesystem without hard links, each new file is written and read back.
  - It never writes over a file it did not create. Every source stays where it was if any file
    fails before the last step. A source or backup that changes during the run is kept, and the
    output lists its path.
- Study files can live in `humanish/studies/`, `.humanish/studies/` and `.humanish/local/studies/`.
  - `run <name>` and `lab list` read those three directories first, then the three `labs/`
    directories.
  - A name with a file in both a `studies/` and a `labs/` directory fails with
    `HUMANISH_STUDY_AMBIGUOUS`, naming both files. `lab list --json` marks both entries with `error`.
    Pass the path of one to run it.
  - `init` skips a starter whose name another study directory already uses. `comms configure`
    refuses to write when its destination name is in use.
- Library names for studies: `runStudy`, `parseStudy`, `STUDY_SCHEMA`, `StudyConfig`,
  `StudyEvent`, `StudyOutcome`, `StudyResult`, `StudyRoute`, `RunStudyOptions` and
  `BrowserScoringContext`. The computer-use loop's nine `Cua*` types and `CuaAdmissionLimitError`
  are also exported as `ComputerUse*`, such as `ComputerUseProvider` and
  `ComputerUseAdmissionLimitError`. `parseStudy` reads v3 and v2 documents.
- Study files can use the format `schema: humanish.study.v3`.
  - The file declares `route:` (`preview`, `computer-use`, `shared-world`, `terminal` or
    `scripted`) and `mode:` (`dry-run` or `live`).
  - It has one `actor:` object and one top-level `caps:` block.
  - `participants:` is a count, `{ count, instruction }`, or a list of participants. A list entry
    with `count: n` and an `id` stands for n participants `<id>-01` to `<id>-NN`.
  - The scripted route takes `surfaces: [desktop]` or `surfaces: [desktop, mobile]`.
  - A field the declared route does not read is an error that names the route. So is a route the
    subject and actor do not take.
  - A v3 file can live in a `studies/` or a `labs/` directory. `humanish.lab.v2` files parse as
    before, with the same warnings.
  - `LabConfig.schema` holds the file's schema, so its type is now
    `"humanish.lab.v2" | "humanish.study.v3"`.

### Removed

- `docs/assets/humanish-drawdb-hero.png` and `docs/assets/humanish-observer-hero.png` from the
  npm package. The README no longer shows either: it opens with the tagline, the demo poster and
  the keyless quick start. An earlier version's README loads its image from that version on
  unpkg, which keeps it.
- `AGENTS.md`, `CONTRIBUTING.md`, `docs/status.md`, `docs/ramp/`, `docs/release/` and
  `docs/history/roadmap/` from the npm package. These are contributor and maintainer pages; read
  them on GitHub. The package now ships `docs/README.md`, the index of the docs it ships, and a
  shipped doc that linked one of the removed pages links it on GitHub.
- `--sims` on `run`, `lab run` and `watch`, and `--lanes` on `lab run`, deprecated in 0.107.0. Use
  `--count` and `--participants`. Commander now reports an unknown option.
- `watch --follow`, hidden and deprecated since 2026-06-01. Human output follows without it.
- The hidden `run --app-url` refusal. 0.106.0 removed the option; it now gets commander's unknown
  option error.

### Deprecated

- `humanish.lab.v2` study files and the three `labs/` directories (`humanish/labs/`,
  `.humanish/labs/`, `.humanish/local/labs/`). 0.109 reads neither.
  - Resolving such a file, as `run <name>`, `lab inspect` and `lab preflight` do, prints a warning
    with its path and the fix: `humanish migrate` for a v2 file, or a move to the matching
    `studies/` directory for a v3 file under `labs/`.
  - `lab list` prints one warning with the number of such files.
- The library's lab and `Cua` names: `runLab`, `parseLabConfig`, `LAB_CONFIG_SCHEMA`, `LabConfig`,
  `LabEvent`, `LabOutcome`, `LabResult`, `LabRoute`, `RunLabOptions`, `BrowserLabScoringContext`,
  the nine `Cua*` loop types and `CuaAdmissionLimitError`. Each is the same function, class or type
  as its new name, so existing code keeps working and `instanceof` matches either class name.
  `LAB_CONFIG_SCHEMA` keeps the v2 id, `"humanish.lab.v2"`, and the error's `name` stays
  `CuaAdmissionLimitError`. The next minor removes them.
- `labId` on a study's result. It holds the same value as `studyId`, which replaces it. The next
  minor removes it.
- `humanish lab run` is a hidden alias of `humanish run` and is removed in the next minor. It takes
  the same flags and prints "warning: humanish lab run is deprecated and is removed in the next
  minor. Use humanish run <study>." on stderr. `humanish lab --help` no longer lists it.
- `humanish serve` is a hidden alias of `humanish observe --all` and is removed in the next minor.
  It prints "warning: humanish serve is deprecated and is removed in the next minor. Use humanish
  observe --all." on stderr.
- `humanish watch --run <id>` is hidden and is removed in the next minor. It prints "warning:
  humanish watch --run is deprecated and is removed in the next minor. Use humanish observe --run
  <id>." on stderr and still shows the saved run.
- `humanish lab list`, `lab inspect` and `lab preflight` are hidden aliases of `study list`,
  `study show` and `study check`, and are removed in the next minor. Each prints a warning such as
  "warning: humanish lab list is deprecated and is removed in the next minor. Use humanish study
  list." on stderr. The `lab` group no longer shows in `humanish --help`.
- `--lab` on `doctor`, `stats`, `watch`, `comms check` and `comms configure` is a hidden spelling
  of `--study`, and is removed in the next minor. It prints a warning such as "warning: humanish
  doctor --lab is deprecated and is removed in the next minor. Use humanish doctor --study
  <study>." on stderr. Passing both `--lab` and `--study` is an error.
- Each deprecation warning above is also the first entry of the JSON result's `warnings` under
  `--json`. A result without a `warnings` array gains one.

- `simId` on the events `RunLabOptions.onStream` receives. Read `recordId`, which each event now
  carries: the id of the participant's entry in `run.json` `simulations[]`, such as `sim-001`.
  `simId` holds the same value, and the first read prints one `DeprecationWarning` with code
  `HUMANISH_STREAM_EVENT_FIELD_DEPRECATED`. The next minor removes it. A spread or
  `JSON.stringify` of an event no longer includes `simId` (#1422).

### Changed

- The README, the shipped docs and the agent skill teach 0.108's study files
  (`humanish.study.v3`), `humanish study` commands, `--study`, `observe --all` and the
  `humanish/studies/` paths. `docs/contracts/schemas.md` documents the v3 study file, the
  participants and caps each route accepts, and the v2-to-v3 key map.
- The `--json` results that list, show, check and count studies say study where they said lab.
  - `study list`: `humanish.lab-list.v1` is `humanish.study-list.v1`, and `labs` is `studies`.
  - `study show`: `humanish.lab-inspect.v1` is `humanish.study-show.v1`, and `lab` is `study`.
  - `study check`: `humanish.lab-preflight-result.v1` is `humanish.study-check.v1`, and `lab`
    and `labId` are `study` and `studyId`.
  - `stats`: `humanish.stats.v1` is `humanish.stats.v2`. `lab` is `study`, `labs` is `studies`,
    and each row's `lab` is `study`.
  - A study that cannot be found or parsed reports `study` where it reported `lab`.
  - The summary the TUI reads is `humanish.study-summary.v1`, with `studyId`.

- `run --json` and `watch --json` list a study file's warnings in the result's `warnings`, as well
  as on stderr: a `humanish.lab.v2` file, a file under `labs/`, a field the route does not read,
  and a `.yml` name.
- The terminal UI says study: its breadcrumbs read `‹ studies / <id>`, its email actions read "Use
  real email in a study" and "Save study copy", and it starts a run with `humanish run`.
- Messages that named `humanish lab list`, `lab inspect`, `lab preflight` or `doctor --lab` name
  `humanish study list`, `study show`, `study check` and `doctor --study`.
- `humanish init` writes its starter studies as `humanish.study.v3` files under
  `humanish/studies/`, and creates `.humanish/studies/` and `.humanish/local/studies/` where it
  created the `labs/` ones. A starter whose name is already a file under `humanish/labs/` is
  skipped, with a pointer to `humanish migrate`. The `cua-browser` starter's title is "Computer-use
  browser study".
- `humanish comms configure` writes its receiving copy as a v3 study to `.humanish/local/studies/`,
  converting a v2 source first, and keeps the source's comments.
- A study's result names its route and its study the same way on every route.
  - Computer-use, scripted, terminal and shared-world results carry
    `schema: "humanish.study-result.v1"`, `route` and `studyId`. So does a study's preview result.
  - Before, each route had its own schema: `humanish.cua-lab-result.v2`,
    `humanish.scripted-lab-result.v1`, `humanish.terminal-lab-result.v1`,
    `humanish.concurrent-shared-world-lab-result.v1`, and `humanish.run-result.v1` for the preview.
    A consumer that tells results apart by `schema` reads `route` instead.
  - `humanish run` with no study, `observe`, and a refusal a command makes before it picks a route
    keep `humanish.run-result.v1`.

- Human-mode errors print on stderr in one shape: `<command> failed: <message>`, `code: <CODE>`,
  and `next: humanish lab list` for `HUMANISH_STUDY_NOT_FOUND`. `keys` and the `comms` connection
  commands, whose results carry no code, print the first line only. Before, most commands printed
  `CODE: message` on stdout. A script that greps stdout for `HUMANISH_` codes has to read stderr or
  switch to `--json`. `--json` output and exit codes do not change; tests/golden/cli-errors/ pins
  16 failing commands' JSON byte for byte. A failed run still prints its run id, route and
  participants on stdout, and a failed `verify` its failing checks. docs/contracts/errors.md lists
  the code families and where each appears.
- Error codes name the study or the route where they said lab, and the participant where they said
  sim. For the lab codes only the prefix changes.
  - `HUMANISH_LAB_*` is `HUMANISH_STUDY_*`, so `HUMANISH_LAB_INVALID` is `HUMANISH_STUDY_INVALID`.
  - `HUMANISH_CUA_LAB_*` is `HUMANISH_COMPUTER_USE_*`.
  - `HUMANISH_CONCURRENT_SHARED_WORLD_LAB_*` is `HUMANISH_SHARED_WORLD_*`.
  - `HUMANISH_TERMINAL_LAB_*` is `HUMANISH_TERMINAL_*`, and `HUMANISH_SCRIPTED_LAB_*` is
    `HUMANISH_SCRIPTED_*`.
  - `HUMANISH_LAUNCH_INVALID_LAB` is `HUMANISH_LAUNCH_INVALID_STUDY`.
  - `HUMANISH_INVALID_SIM_COUNT` is `HUMANISH_INVALID_PARTICIPANT_COUNT`, the code for a `--count`
    that is not a positive integer.

  A script or library caller that matches a code by its old name needs the new one. Runs saved
  before the change keep the codes they were written with, and nothing reads a code back from a
  saved run.

- Computer-use streams in `run.json` are labelled `<participant id> · browser`, such as
  `lane-01 · browser`, in place of `CUA browser — <study>` and `CUA participant <id>: <study>`, and
  their screenshot embed title is `Desktop (raw)` or `Desktop (blurred)` in place of
  `CUA desktop …`. Bundles written earlier keep their labels. The Observer says participant where it
  said lane (`Participant`, `Est. participant cost`, `Assigned focus`, `Declared UI route`), calls
  its library the study library, and uses `·` in labels and a colon in sentences where it showed an
  em dash.

- `humanish --help`, bare `humanish`, the package description and the humanish skill describe
  humanish in one sentence: "Synthetic user research for apps, CLIs, and agent-facing product
  flows." Before, they said "Open-source-safe persona simulation CLI and proof harness." and three
  other variants. The package keywords are user-research, usability-testing, synthetic-users,
  computer-use and cli.
- `humanish observe` is the one viewer. `observe --all` serves the run library, with `serve`'s
  flags: `--safe`, `--expose`, `--tunnel`, `--tunnel-domain`, `--oauth`, `--allow-email`,
  `--allow-domain` and `--public-url`. Without `--all` they are refused with
  `HUMANISH_OBSERVE_OPTION_CONFLICT`. `observe --all --run <id>` opens the library on that run. Its
  human output starts with "humanish observe --all" in place of "humanish serve"; the JSON keeps
  `humanish.serve-result.v1`.
- `humanish run <lab>` takes `--rerun-failed-from`, `--participants` and `--scorer`, which only
  `lab run` took (and `watch`, for `--scorer`). `run` and `watch` register a run's flags through
  one helper, so they take the same ones. Without a lab, `run` refuses these three with
  `HUMANISH_RUN_OPTION_CONFLICT` and `watch` with `HUMANISH_WATCH_OPTION_CONFLICT`. Before,
  `watch` ignored `--scorer` without a lab.
- The first commands a newcomer runs say the right thing.
  - `humanish doctor` before `init` reports "no readable humanish/ source directory; run humanish
    init --yes" and ".gitignore does not list .humanish/; run humanish init --yes". Before, these
    failed rows printed the sentence for a pass, such as "committed humanish/ source directory is
    present and safe to read".
  - A mistyped command prints one line, for example "error: unknown command 'verfy'. Did you mean
    'verify'?", and exits 1. Before, it printed "too many arguments" and the whole help.
  - `humanish --help` lists examples that pass on a freshly initialized project: `init --yes`,
    `run first-run`, `observe --run latest --open`, `doctor --lab try-live`, `run try-live` and
    `verify --json`. The `watch --lab .humanish/labs/local.yaml` example, which failed with
    `HUMANISH_LAB_NOT_FOUND`, is gone from the root, `watch` and `lab run` help.
  - Bare `humanish` suggests `init --yes` in a new project, then `run first-run` and
    `doctor --lab local-browser` (or `try-live` where local browsers do not run) until there is a
    run. Before, it suggested watching the first lab alphabetically, a template whose subject is a
    placeholder.
- The starter files `humanish init` writes use plain language. Each starter lab's description says
  what the lab does, what it needs and what it costs, with no issue numbers, all-caps emphasis or
  em dashes, and the try-live title reads "Your first live study: one participant on a demo app".
  The `cua-browser` starter names `synthetic-new-user`, a persona init writes, so its first run no
  longer warns that `first-time-visitor` has no file. The generated `AGENTS.md` section loses its
  em dash and its all-caps word. A test now runs init and holds these files to zero of each
  (#1440).
- A keyless run is called a dry run everywhere a person reads it. Before, the same run was "contract
  proof", "contract evidence", "harness contracts", "artifact plumbing" or "preview".
  - `run`, `watch` and `lab run` share one `--dry-run` help line: "Do a dry run: a synthetic run
    with no browser, keys or provider spend." in place of "Generate contract proof without browser,
    keys, or provider spend.".
  - `humanish review` prints "no verdict; no product behavior was tested" in place of "preview
    only; no product behavior was tested". `contract_proof_only` also marks a live run with no
    participant result, and review's result does not carry the mode. `humanish stats` prints "2 dry runs ($0); no live runs yet"
    and "dry runs: 2" in place of "previews".
  - review.md's verdict line reads "dry run" in place of `contract_proof_only` on a dry run, and
    "no verdict" on a live run with no participant result, on every route.
  - The review summary in a dry-run bundle reads "Dry run: humanish wrote a synthetic run bundle.
    No product behavior was tested.", and the redaction note "Dry-run bundle: synthetic data only,
    nothing from a product.".
  - The Observer labels a dry-run participant "Dry run" in place of "Contract proof" ("No verdict"
    for a live participant with no result), and its
    warning reads "This is a dry run: its participants are synthetic and no product behavior was
    tested.".
  - `humanish analyze` refuses a dry run with "A dry run has no participant behavior to analyze.
    Select a completed live run." (`ANALYSIS_REQUIRES_LIVE_RUN`, unchanged).
  - Bare `humanish`, `init`'s next step and the AGENTS.md section call `humanish run first-run` "a
    dry run" in place of "an evidence preview".
  - `contract_proof_only` stays the value of `streams[].status` and `review.verdict` in `run.json`.
    CONTEXT.md maps it to dry run. "preview" now names only the route.
- Dry-run bundles on every route stop calling the run a contract. Review summaries, gaps, events,
  redaction notes and participant summaries say dry run, for example "Dry-run bundle ready; switch
  scenario.mode to live for a real desktop session." in place of "Dry-run contract bundle ready;
  ...", and "it checks the evidence shape only" in place of "it proves contract shape only".
  - A participant that has no session and no error reads "...; no session ran." in place of
    "Contract participant ...". A live participant can end that way too, so the line does not say
    dry run.
  - The first-run dry run's sample streams say "recorded" in place of "contract captured".
  - Event types such as `cua-lab.contract.ready`, event ids, the `contract-only` state marker and
    `contract_proof_only` keep their spelling.
- `humanish verify` prints one line for a passing run, "verified <runId> · share_ready · 16 checks
  passed", with `latest` resolved to the run id. A failing run lists only its failing checks, each
  as what verify found, such as "redaction did not pass (status: pending)" or "review.md is
  missing", then names `verify --verbose`, which prints every check as before. A missing run prints
  only that. `--json` keeps its fields.
  - A check that reads bundle content says "not checked, because run.json failed the shape check"
    when run.json fails its shape check. Before, it printed its pass sentence.
  - Each check has a pass message and a different fail message, in JSON and human output. Before,
    `run schema`, `run bundle shape`, `redaction passed` and `review artifacts exist` printed the
    rule they enforce on both sides, such as "redaction status must be passed".
- `humanish stats` on a project with only previews prints one line, "2 previews ($0); no live
  runs yet". Otherwise previews get their own `previews:` line, followed by spend, outcomes and the
  per-lab and per-day lines. Counts read "3 runs" and "1 preview" in place of "run(s)", zero counts
  are left out, and the closing note is one sentence. docs/contracts/study-costs.md holds the
  accounting rules.
  - A dry run that records no cost counts as $0 in `stats --json`. It no longer adds to
    `unpricedRuns` or `incompleteRunEstimates`, and its `runEstimatedUsd` is 0. Before, each
    preview counted as unpriced, with incomplete accounting. A dry run that records an unknown
    (null) figure stays unpriced.
- Run output names real commands and says what happened in words.
  - A lab run starts with `humanish run <lab>: dry run finished` (or `live run finished`, or
    `failed`) and a `route:` line (`computer-use`, `terminal`, `scripted` or `shared-world`). Before,
    it named commands that do not exist, such as `humanish lab cua dry-run`, and repeated the lab on
    a `lab:` line, which is gone. A dry-run participant reads "dry run, nothing ran live" in place of
    `contract_proof_only`, and a failed one reads "not ok" in place of `not-ok`.
  - The analysis line prints a sentence, for example "analysis: skipped for dry runs" in place of
    "analysis: skipped (AUTOMATIC_ANALYSIS_DRY_RUN)". `--json` output keeps the reason code.
  - `humanish review` prints the verdict, the summary, the gaps as a list and the `review.json` path.
    Before, it printed the review as raw JSON without `--json`. A dry run's verdict reads "preview
    only; no product behavior was tested".
  - Bare `humanish run` says "humanish run needs a lab. List labs with humanish lab list, or run
    humanish run --dry-run for a sample bundle." (`HUMANISH_LIVE_RUN_UNIMPLEMENTED`, unchanged).
  - A missing run reads "No runs in <dir> yet; start one with humanish run first-run" in a project
    with no runs, and "No run <id>; humanish runs lists them" otherwise, in `verify`, `cleanup`,
    `feedback`, `observe`, `export` and `serve`. Before, each said "Run not found: <id>".

- `humanish doctor` without `--lab` passes on a project with no keys. Its key rows report presence
  and name the project's labs that need each key, for example "missing; used by try-live; run
  `e2b auth login`, or `humanish keys set e2b`". Before, bare doctor after `init --yes` failed on a
  missing `E2B_API_KEY`, and on `OPENAI_API_KEY` when no local agent was signed in, although
  init's next step, `run first-run`, needs neither. `doctor --lab <lab>` still fails on a key the
  selected lab requires, so a script that gates a live run on doctor's exit code should pass
  `--lab`.
  - Each row in `doctor --json` has a `status`: `ok`, `missing`, `not_checked` or `note`. A note is
    advisory and keeps `ok: true`. Notes are: a missing key a project lab needs (without `--lab`),
    `humanish tui` unbuilt or unsupported on this Node, a post-run analysis that will be skipped,
    an installed agent that is not signed in, and an absent `@e2b/desktop` without `--lab`. Human
    output prints the status where it printed "ok" or "missing".
  - Each installed local agent has its own row, `local agent codex` and `local agent claude`.
    Before, one `local agents` row joined both into one line. With no agent installed, the
    `local agents` row stays.
- `humanish feedback draft`, `verify`, `issue` and `issue-url` refuse a dry run with
  `HUMANISH_FEEDBACK_REQUIRES_LIVE_RUN`, as `analyze` refuses one with `ANALYSIS_REQUIRES_LIVE_RUN`.
  Before, a dry run produced a "Dry-run contract proof needs product-evidence follow-up" draft.
  - The issue body drops the "public-safe simulation harness coverage" paragraph and the "GitHub
    mutation", "Substrate" and "Production data" lines. Its evidence list names each file by its
    path inside the run, such as "screenshot screenshots/step-003.png", without the
    `.humanish/runs/<id>/` prefix; the YAML block keeps the full paths.
- `humanish cleanup` ends with "To stop leftover sandboxes, run humanish reclaim --run <id>." when
  an E2B sandbox in the run is not recorded as stopped. It adds `--cwd` when cleanup was given one.
- A spend cap on a model humanish cannot price is refused with a message that lists the priced
  models and says to remove `maxUsd` and `maxTotalUsd`. Before, the computer-use route said to add
  a rate to `src/run/pricing.ts`, which the npm package does not ship, and the shared-world route
  named no fix. The run cost note and the terminal ledger note no longer name that file; the cost
  note says each line's reason names what is missing.
- Option help reads the same across commands and drops internal words.
  - `--cwd`, `--run`, `--env-file`, `--port` and `--json` have one description each on every
    command. `--run` says "Run id, or latest." in place of six wordings; `--env-file` says "Load
    unset variables from this env file. Values are never printed or saved." in place of six.
  - `--port` shows "(default: a free port)" and `export --max-bytes` "(default: 25 MB)".
  - Option help says computer-use in place of CUA, and drops "adopter scorer module", "admission
    estimate" and "exposure intent". `--open` names the Observer with a capital O.
  - `watch --safe` is hidden from help. It is still refused, with a message that names the
    library filter and edge auth.
  - The npm package keywords add ui-testing and ux-research back, beside the five from the
    product-sentence change.
- Codex CLI releases are admitted by rule. Every stable release from 0.154.0 on launches, except
  those in `REFUSED_CODEX_CLI_VERSIONS` in `src/actors/codex/codex-admission.ts` (empty). Before,
  each host had a fixed list: Linux x64 took 0.154.0, 0.157.1, 0.159.2, 0.159.3 and 0.160.0;
  macOS arm64 took 0.154.0; hosted participants on Linux arm64 and macOS x64 took 0.154.0. The
  per-launch schema check from #1401 still refuses a release that changed a field humanish uses.
  - Prereleases (`0.162.0-alpha.4`) and releases below 0.154.0 are refused as
    `codex_unsupported_version`. doctor says which and why: "it is a prerelease, and humanish runs
    stable releases", "it is older than 0.154.0, the oldest release humanish supports", "it is not
    a plain MAJOR.MINOR.PATCH release", or the refused entry's reason and issue.
  - A hosted participant (operator mode) on a release outside `TESTED_CODEX_CLI_VERSIONS` records
    the run warning "Codex CLI <release> has not been tested with humanish; this hosted
    participant's evidence rests on the checks each launch makes."
  - The default release a declaration names before detection, and the release doctor's install
    command pins, is the newest tested one, 0.160.0, on every host. On macOS arm64 both move from
    0.154.0 to 0.160.0.
  - Isolated launches, the Codex-account analyst and local-browser participants, still run only
    on Linux x64 and macOS arm64. On Linux arm64 and macOS x64, analysis is still refused as
    `codex_unsupported_platform`.
  - Messages that said "qualified" Codex CLI describe the rule and name the last tested release.
    `src/actors/codex/qualified-versions.ts` is now `codex-admission.ts`.
- Saved bundles and Codex-account analyses may name any stable Codex CLI release from 0.154.0 on
  (#1414). `humanish verify`, analysis reads and the Observer accept a participant execution
  profile or an analyst identity whose release no launch list names, such as 0.158.0 or 0.161.0.
  Before, they accepted only 0.154.0, 0.157.1, 0.159.2, 0.159.3 and 0.160.0, and rejected a bundle
  from any other release. A participant now records the release that launched; before, one outside
  that list was recorded as the host default, which only a `codex:qualify` candidate could reach.
  Published humanish and Observer builds keep their closed list, so they still reject a bundle that
  names a release they never listed.
- The metadata humanish sets on the E2B sandboxes it creates uses participant names. A
  computer-use participant's sandbox carries `participantId`, `participantIndex`,
  `participantCount` and `recordId` (the participant's `simulations[]` id in `run.json`) in place
  of `laneId`, `laneIndex`, `laneCount` and `simId`. A terminal sandbox carries `recordId` in place
  of `simId`. A shared-world or scripted subject sandbox carries `kind: subject` in place of
  `role: subject`, and the shared-world one `participantCount` in place of `roleCount`. Nothing in
  humanish reads these labels back; an E2B dashboard filter on the old keys needs the new ones
  (#1419).
- `humanish --help` lists the commands in workflow order (init, doctor, run, watch, observe,
  verify, review, analyze, feedback, export, then the rest), each on one line that says what it
  does: for example "Run a study, as a dry run or with live participants." in place of "Run a
  persona/scenario simulation or dry-run bundle.", and "Check that a run's resources were
  stopped." in place of "Write a resource cleanup inspection receipt.".
  - `-v` prints the version; `-V` is gone. `humanish help <command>` prints that command's help.
  - Every help screen ends with links to https://humanish.dev/docs and
    https://humanish.dev/docs/cli.
  - `humanish codex` is hidden from help and the CLI reference, and works as before.
  - The command index in llms.txt gives each command's full description.

### Fixes

- `openai-computer-use` participants on a zero-data-retention OpenAI organization remember the
  whole session (#1491). Before, each request in explicit-context mode carried only the previous
  reply, so a participant forgot everything older than one turn: per-turn input stayed flat,
  finished steps were started again, and closing reports contradicted the trace. Each request now
  carries the conversation from the client: the opening message, every earlier reply with the
  screenshots that answered it, and the latest reply. It sends `store: false` and asks for the
  reasoning back in encrypted form. Past an estimated 64,000 input tokens, the opening screenshot
  goes first, then the oldest turns become a note that keeps their reasoning summaries, messages
  and actions as text. The actor trace's new `conversation` record gives the mode, why and when it
  switched, and each request's carried context. A participant that ran this way gets a run
  warning. With `zeroDataRetention` set, requests were stored by default before; they now send
  `store: false`.

- The Observer player sizes a fitted recording in CSS from the stage's current box (#1447). On a
  phone, opening a recording whose declared viewport has a different shape from its screenshots
  showed the frame at about half size for one frame (105.8×229 in place of 191.75×415 for a 390×844
  capture declared 1280×800). The frame box was sized from a stage measurement one frame behind the
  stage. CI's `observer:reliability:proof` failed on that frame twice. Every settled stage and frame
  box matches the previous release on desktop and phone, in both orientations and at every zoom
  level. The live view still measures its stage.
- The TUI key legend fits on one line at 45 columns. Its separators are two spaces, and the
  lab and all-runs screens say "⏎ open" for "⏎ open run". Before, the lab and run legends wrapped
  and left "quit" alone on the last line. The start rows keep two columns between the label and
  its price, and put the price under the label when the two do not fit. At 45 columns, run rows
  keep their two-column gutter and the labs list keeps the ▸ before the selected description.
  "Start a LIVE run" reads "Start a live run", empty states are sentences, and on-screen em
  dashes became colons or semicolons.
- A word that names no command is reported as an unknown command whatever options follow it.
  `humanish nope --cwd .` and `humanish verfy --run latest` print "error: unknown command 'nope'"
  and "Did you mean 'verify'?" and exit 1. Before, an option after the word won: they printed
  "unknown option '--cwd'" and listed the commands that take `--cwd`, as if the word were one of
  them. `humanish nope --help` also reports the unknown command, where it printed the root help.
  A real command with a wrong option, such as `verify --nope`, keeps the unknown-option message.

## 0.107.0: A 44-name library API, --count and --participants (2026-10-02)

humanish 0.107.0 removes the library surfaces 0.106.0 deprecated, so the entry point exports 44
names, down from 83. `runLab(config, options)` is the one way to run a lab: the route runners, the
`RunLabOptions` hook bags, `LabOutcome.backend`, the `routesTo*` predicates and `rerun.laneIds` are
gone, and a JavaScript caller that still passes a removed option is refused before anything runs.
The release notes map each removed name to its replacement. On the CLI, `--count` replaces
`--sims` and `--participants` replaces `--lanes`; the old flags work with a warning until 0.108.0.
A scripted `press` step sends its key. A signalled live run records itself as interrupted and
kills its sandboxes. Restricted Codex launches check the release's app-server schema before they
start, and a terminal lab with no declared model runs on `gpt-5.6-sol` and prices its tokens.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.107.0)

## 0.106.1: Codex CLI 0.160.0 and reclaim in E2B debug mode (2026-10-01)

Codex participants, Codex-account analysis and `humanish doctor` admit Codex CLI 0.160.0 (published
to npm 2026-10-01) on Linux x64, which 0.106.0 refused. Doctor's recovery for an unadmitted release
suggests `npm install -g @openai/codex@0.160.0`. `humanish reclaim` refuses to run with
`E2B_DEBUG=true`, where the E2B SDK reports kills it never sent, and a run's sandbox teardown in
debug mode reads unconfirmed.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.106.1)

## 0.106.0: Node 22.19, a smaller library API and stricter share safety (2026-10-01)

humanish needs Node 22.19.0 or later. The library entry point exports 83 names, down from 377:
`runLab` runs a lab, and the release notes list the 300 removed names and how to migrate. Sequential
shared-world studies, the OSS meta-lab, `run --actor` and `run --app-url` are removed, so a
shared-world lab with `execution.concurrency: 1` fails at parse. Local Codex participants run only
on the Codex CLI releases admitted for their host, and `humanish doctor` names the release it found.
`humanish verify` judges share safety by file contents. It finds secrets in base64, hex and escaped
text, and it grades a run that holds an image or archive it cannot account for `local_only`.
`serve --safe` re-verifies a run whose files changed before serving it.

[Release notes](https://github.com/danielgwilson/humanish/releases/tag/v0.106.0)

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
