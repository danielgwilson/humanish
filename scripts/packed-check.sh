#!/usr/bin/env bash
# Checks the humanish package as a user installs it. Each row runs the CLI or the library from the
# package in a fresh project, with a temp HOME, a fresh npm cache and no variable from this shell
# but PATH, through `npx -y --package <spec> humanish`, and adds one line to the table it prints.
# The "Depends on" column names the PR whose behavior a row pins; "on main" means 0.108.0 or
# earlier. A PR that changes a pinned behavior updates its row here.
#
# Usage: pnpm packed:check                          pack this tree and check the tarball
#        pnpm packed:check -- humanish@<version>     check a published version, registry rows too
#
# The first form runs `npm pack`, whose prepack builds dist/, into a temp directory; a release runs
# it before tagging. The second form also checks `npm view`, dist-tags.latest and unpkg, and a
# release runs it after the publish workflow finishes.
#
# No row makes a model request or creates a desktop: first-run is the offline dry run, `doctor
# --study local-browser` checks the local Codex CLI without a provider call, and the observe checks
# fail on a bad port before any server binds. Some rows need more of this machine: 20t, 20w, 20ar
# and 20bo drive a local Chrome or Chromium on PATH against a loopback page (the scripted route, no
# model); 20x and the 401 row in group 21 send a synthetic E2B key to E2B's API, which refuses it
# before anything is created; the PTY and TUI rows need python3; 20cl needs bun on PATH or at
# ~/.bun/bin/bun; the library rows install the package with npm; and group 21 runs
# humanish@0.122.0 and humanish@0.109.1 from npm to write runs in their formats. 20af to 20ah draw
# an E2B app host at run time, `3000-<20 letters and digits>.e2b.app`, that names no sandbox.
set -uo pipefail

usage="usage: pnpm packed:check [-- humanish@<version>]"
# pnpm passes the `--` that ends its own options through to the script.
[ "${1:-}" = -- ] && shift
case "$#:${1:-}" in
  0:) registry=no ;;
  1:humanish@[0-9]*) registry=yes ;;
  *)
    echo "$usage" >&2
    exit 2
    ;;
esac

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/humanish-packed-check-XXXX")
project=$work/project
user_home=$work/home
mkdir -p "$project" "$work/npm-cache" "$user_home" "$work/logs"

if [ "$registry" = yes ]; then
  spec=$1
  version=${1#humanish@}
else
  version=$(node -p 'require(process.argv[1]).version' "$repo/package.json")
  spec=$work/humanish-$version.tgz
  echo "Packing $repo with npm pack, which builds dist/ first. Log: $work/logs/pack.log"
  (cd "$repo" && npm pack --pack-destination "$work") >"$work/logs/pack.log" 2>&1
  if [ ! -f "$spec" ]; then
    echo "npm pack wrote no $spec; see $work/logs/pack.log" >&2
    exit 2
  fi
fi

# PATH keeps node, npx and the Codex CLI this machine has, minus the node_modules/.bin entries that
# `pnpm run` puts first, so none of the repo's own tools reaches a row. Nothing else crosses from
# this shell.
user_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/node_modules/\.bin$' | paste -sd: -)
run_env=(
  env -i
  "PATH=$user_path"
  "HOME=$user_home"
  "TERM=dumb"
  "NO_COLOR=1"
  "DO_NOT_TRACK=1"
  "HUMANISH_TELEMETRY_DISABLED=1"
  "npm_config_cache=$work/npm-cache"
  "npm_config_update_notifier=false"
  "npm_config_fund=false"
  "npm_config_audit=false"
)
hx() { (cd "$project" && timeout 600 "${run_env[@]}" npx -y --package "$spec" humanish "$@"); }
# The rows that reach E2B install the optional peer beside humanish in npx's own directory, as a
# project install would. Without it, Node finds @e2b/desktop only when some node_modules above the
# work directory happens to hold one.
hx_e2b() { (cd "$project" && timeout 600 "${run_env[@]}" npx -y --package "$spec" --package @e2b/desktop humanish "$@"); }

rows=()
failures=0
record() { # name, PASS|FAIL, detail, depends-on
  rows+=("| $((${#rows[@]} + 1)) | $1 | $2 | $3 | ${4:-on main} |")
  [ "$2" = PASS ] || failures=$((failures + 1))
}
json_field() { # file, js expression over `d`
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=('"$2"'); process.stdout.write(v===undefined||v===null?"":String(v))' "$1" 2>/dev/null
}
# Synthetic values for the key variables some rows set. Each row is refused, or E2B rejects the
# value, before anything is created.
synthetic_e2b=synthetic-verify-e2b
synthetic_e2b_prefixed=e2b_synthetic-verify-key
synthetic_openai=synthetic-verify-openai

# 1. Registry: the version exists, has an integrity hash, and `latest` points at it.
if [ "$registry" = yes ]; then
published=$("${run_env[@]}" npm view "humanish@$version" version 2>"$work/logs/npm-view.err")
integrity=$("${run_env[@]}" npm view "humanish@$version" dist.integrity 2>>"$work/logs/npm-view.err")
# dist-tags from the registry itself: `npm view` answered from a stale cache after 0.109.0.
latest=$(curl -sS --max-time 60 https://registry.npmjs.org/-/package/humanish/dist-tags 2>>"$work/logs/npm-view.err" |
  node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).latest||"")}catch{}})')
if [ "$published" = "$version" ] && [ -n "$integrity" ]; then
  record "npm view humanish@$version" PASS "version $published, integrity ${integrity:0:22}…"
else
  record "npm view humanish@$version" FAIL "version '${published}', integrity '${integrity:0:22}'"
fi
if [ "$latest" = "$version" ]; then
  record "dist-tags.latest is $version" PASS "latest $latest"
else
  record "dist-tags.latest is $version" FAIL "latest is ${latest:-unknown}"
fi
fi

# 2. The CLI from npm reports its version, through `-v` (0.107 had only `-V` and `--version`).
cli_version=$(hx -v 2>"$work/logs/version.err" | tail -n 1)
if [ "$cli_version" = "$version" ]; then
  record "-v prints $version" PASS "$cli_version" "on main"
else
  record "-v prints $version" FAIL "printed '${cli_version}'; see logs/version.err" "on main"
fi

# 3. init in an empty project writes the starter studies as v3 files under humanish/studies/.
if hx init --yes --json >"$work/logs/init.json" 2>"$work/logs/init.err" &&
  [ -f "$project/humanish/studies/first-run.yaml" ] &&
  grep -q "humanish.study.v3" "$project/humanish/studies/first-run.yaml"; then
  record "init --yes" PASS "wrote humanish/studies/first-run.yaml (humanish.study.v3)" "on main"
else
  record "init --yes" FAIL "exit, path or schema; see logs/init.err" "on main"
fi

# 3b. A rerun of init changes no file (#1563). Its AGENTS.md section ends with the end marker, and
# init no longer writes the coverage files or the lobby study.
before_tree=$(cd "$project" && find . -type f -not -path './.git/*' -print0 | sort -z | xargs -0 sha256sum)
hx init --yes >"$work/logs/init-rerun.out" 2>"$work/logs/init-rerun.err"
init_rerun_exit=$?
after_tree=$(cd "$project" && find . -type f -not -path './.git/*' -print0 | sort -z | xargs -0 sha256sum)
dropped=$(cd "$project" && ls humanish/coverage-map.md humanish/coverage-matrix.md humanish/scenarios/onboarding-regression.yaml humanish/studies/lobby-trivia-3player.yaml 2>/dev/null | tr '\n' ' ')
if [ "$init_rerun_exit" = 0 ] && grep -qx "no files changed" "$work/logs/init-rerun.out" &&
  [ "$before_tree" = "$after_tree" ] && grep -qxF "<!-- /humanish:agents-guide -->" "$project/AGENTS.md" &&
  [ -z "$dropped" ]; then
  record "init rerun: no files changed" PASS "\"no files changed\", same file hashes; AGENTS.md end marker; no coverage or lobby files" "#1563"
else
  record "init rerun: no files changed" FAIL "exit $init_rerun_exit, tree same: $([ "$before_tree" = "$after_tree" ] && echo yes || echo no), dropped files present: '${dropped}'; see logs/init-rerun.out" "#1563"
fi

# 4. The offline dry run, through `run <study>`.
hx run first-run --no-open --json >"$work/logs/run.json" 2>"$work/logs/run.err"
run_exit=$?
run_ok=$(json_field "$work/logs/run.json" 'd.ok')
run_mode=$(json_field "$work/logs/run.json" 'd.mode')
run_id=$(json_field "$work/logs/run.json" 'd.runId')
if [ "$run_exit" = 0 ] && [ "$run_ok" = true ] && [ "$run_mode" = dry-run ]; then
  record "run first-run (offline dry run)" PASS "$run_id"
else
  record "run first-run (offline dry run)" FAIL "exit $run_exit, ok '$run_ok', mode '$run_mode'"
fi

# 5. verify the run it just made: JSON, then the one-line human pass.
hx verify --run latest --json >"$work/logs/verify.json" 2>"$work/logs/verify.err"
verify_exit=$?
verify_ok=$(json_field "$work/logs/verify.json" 'd.ok')
share=$(json_field "$work/logs/verify.json" 'd.shareSafety && d.shareSafety.status')
if [ "$verify_exit" = 0 ] && [ "$verify_ok" = true ]; then
  record "verify --run latest --json" PASS "ok, shareSafety ${share:-unknown}"
else
  record "verify --run latest --json" FAIL "exit $verify_exit, ok '$verify_ok'"
fi
verify_line=$(hx verify --run latest 2>"$work/logs/verify-human.err" | head -n 1)
case "$verify_line" in
  "verified $run_id · "*" checks passed") record "verify (human): one line" PASS "$verify_line" ;;
  *) record "verify (human): one line" FAIL "printed '${verify_line}'" ;;
esac

# 6. Errors print on stderr in human mode: `<command> failed: <message>` and a code line, with
# nothing on stdout. --json keeps the error in the envelope on stdout.
missing_out=$(hx verify --run nope 2>"$work/logs/verify-missing.err")
missing_exit=$?
if [ "$missing_exit" = 2 ] && [ -z "$missing_out" ] &&
  grep -q "^humanish verify failed: " "$work/logs/verify-missing.err" &&
  grep -q "^code: HUMANISH_RUN_NOT_FOUND$" "$work/logs/verify-missing.err"; then
  record "verify --run nope: error on stderr" PASS "exit 2, stdout empty, code line on stderr" "on main"
else
  record "verify --run nope: error on stderr" FAIL "exit $missing_exit; stdout '$(printf '%s' "${missing_out:0:60}" | tr '\n' ' ')'; see logs/verify-missing.err" "on main"
fi

# 7. observe is the one viewer: --all takes the library flags. A bad port fails before any bind.
hx observe --all --port 99999 --json >"$work/logs/observe-all.json" 2>"$work/logs/observe-all.err"
observe_code=$(json_field "$work/logs/observe-all.json" 'd.error && d.error.code')
observe_schema=$(json_field "$work/logs/observe-all.json" 'd.schema')
if [ "$observe_code" = HUMANISH_INVALID_PORT ] && [ "$observe_schema" = humanish.serve-result.v1 ]; then
  record "observe --all (library flags)" PASS "$observe_schema refused the port before binding" "on main"
else
  record "observe --all (library flags)" FAIL "schema '$observe_schema', code '$observe_code'; see logs/observe-all.err" "on main"
fi

# 8. serve, deprecated in 0.108.0, is an unknown command that points at observe.
hx serve --port 99999 --json >"$work/logs/serve.json" 2>"$work/logs/serve.err"
serve_exit=$?
if [ "$serve_exit" = 1 ] && grep -qF "error: unknown command 'serve'. Did you mean 'observe'?" "$work/logs/serve.err"; then
  record "serve (removed)" PASS "exit 1, unknown command, did you mean 'observe'" "#1526"
else
  record "serve (removed)" FAIL "exit $serve_exit; see logs/serve.err" "#1526"
fi

# 9. lab run, deprecated in 0.108.0, is an unknown command.
hx lab run first-run --no-open --json >"$work/logs/lab-run.json" 2>"$work/logs/lab-run.err"
lab_run_exit=$?
if [ "$lab_run_exit" = 1 ] && grep -qF "error: unknown command 'lab'" "$work/logs/lab-run.err"; then
  record "lab run (removed)" PASS "exit 1, unknown command 'lab'" "#1526"
else
  record "lab run (removed)" FAIL "exit $lab_run_exit; see logs/lab-run.err" "#1526"
fi

# 10. --sims, removed as 0.107.0 promised, is an unknown option.
hx run first-run --sims 2 --json >"$work/logs/sims.json" 2>"$work/logs/sims.err"
sims_exit=$?
if [ "$sims_exit" = 1 ] && grep -q "unknown option '--sims'" "$work/logs/sims.err"; then
  record "run --sims (removed)" PASS "exit 1, unknown option" "on main"
else
  record "run --sims (removed)" FAIL "exit $sims_exit; see logs/sims.err" "on main"
fi

# 11. The study group lists what init wrote, as humanish.study-list.v1 with `studies`, and an empty
# `retired` list in a project with no v2 or labs/ files (#1533).
hx study list --json >"$work/logs/study-list.json" 2>"$work/logs/study-list.err"
list_schema=$(json_field "$work/logs/study-list.json" 'd.schema')
studies=$(json_field "$work/logs/study-list.json" '(d.studies || []).map((s) => s.id).join(",")')
retired=$(json_field "$work/logs/study-list.json" 'Array.isArray(d.retired) ? d.retired.length : "missing"')
case "$list_schema,$retired,$studies," in
  humanish.study-list.v1,0,*first-run,*) record "study list" PASS "$list_schema: $studies; retired []" "#1533" ;;
  *) record "study list" FAIL "schema '${list_schema}', retired '${retired}', ids '${studies}'; see logs/study-list.err" "#1533" ;;
esac

# 12. The Codex CLI on this machine is admitted. Plain `doctor` does not check the Codex version, so
# this runs the local-browser study's checks, which do. A pass needs the output to mention Codex.
box_codex=$("${run_env[@]}" codex --version 2>/dev/null | head -n 1)
hx doctor --study local-browser --json >"$work/logs/doctor.json" 2>"$work/logs/doctor.err"
if grep -q "codex_unsupported_version" "$work/logs/doctor.json" "$work/logs/doctor.err"; then
  record "doctor --study local-browser: Codex admitted" FAIL "${box_codex:-no codex}: codex_unsupported_version" "on main"
elif grep -qi "codex" "$work/logs/doctor.json"; then
  record "doctor --study local-browser: Codex admitted" PASS "${box_codex:-no codex}: no codex_unsupported_version" "on main"
else
  record "doctor --study local-browser: Codex admitted" FAIL "doctor output never mentions Codex; see logs/doctor.json" "on main"
fi

# 13. Bare doctor passes on a keyless project; a key row is a note, never a failure.
hx doctor --json >"$work/logs/doctor-bare.json" 2>"$work/logs/doctor-bare.err"
bare_exit=$?
bare_status=$(json_field "$work/logs/doctor-bare.json" 'd.checks.map((c) => c.status).every(Boolean)')
if [ "$bare_exit" = 0 ] && [ "$bare_status" = true ]; then
  record "doctor (keyless): exit 0, status on every row" PASS "exit 0"
else
  record "doctor (keyless): exit 0, status on every row" FAIL "exit $bare_exit, status on every row '$bare_status'"
fi

# 14. migrate converts a v2 file. The v2 copy is written by hand, since 0.108 init writes v3. Its
# review.scoring is a key the preview route never reads, so the plan has a dropped line. The dry
# run prints the plan and writes nothing; the real run moves the file to humanish/studies/ as
# humanish.study.v3, and the moved study runs. Output shape from #1510.
mkdir -p "$project/humanish/labs"
cat >"$project/humanish/labs/legacy.yaml" <<'YAML'
schema: humanish.lab.v2
id: legacy
title: A v2 file for the migrate check
subject:
  source: this-repo
actors:
  - type: synthetic-persona
    count: 1
scenario:
  mode: dry-run
review:
  scoring: rubric-v1
YAML
# Before migrating, the v2 file is refused with the command that fixes it, on every surface a
# script reads: human stderr (message and code line, exit 2), run --json, and study list's
# `retired`. Text from #1533.
v2_message="humanish/labs/legacy.yaml is a humanish.lab.v2 file in humanish/labs/, which humanish no longer reads. Run humanish migrate humanish/labs/legacy.yaml to convert it and move it to humanish/studies/."
hx run legacy --no-open >"$work/logs/v2-run-human.out" 2>"$work/logs/v2-run-human.err"
v2_exit=$?
hx study list --json >"$work/logs/v2-list.json" 2>"$work/logs/v2-list.err"
v2_retired=$(json_field "$work/logs/v2-list.json" '(d.retired || []).map((f) => f.path + " " + f.code).join(",")')
if [ "$v2_exit" = 2 ] && grep -qxF "humanish run failed: $v2_message" "$work/logs/v2-run-human.err" &&
  grep -qx "code: HUMANISH_STUDY_V2_UNSUPPORTED" "$work/logs/v2-run-human.err" &&
  [ "$v2_retired" = "humanish/labs/legacy.yaml HUMANISH_STUDY_V2_UNSUPPORTED" ]; then
  record "v2 file refused: human stderr, study list retired" PASS "exit 2, names humanish migrate; retired lists it" "#1533"
else
  record "v2 file refused: human stderr, study list retired" FAIL "exit $v2_exit, retired '${v2_retired}'; see logs/v2-*" "#1533"
fi
hx run legacy --no-open --json >"$work/logs/v2-run.json" 2>"$work/logs/v2-run.err"
v2_code=$(json_field "$work/logs/v2-run.json" 'd.error && d.error.code')
v2_json_message=$(json_field "$work/logs/v2-run.json" 'd.error && d.error.message')
if [ "$v2_code" = HUMANISH_STUDY_V2_UNSUPPORTED ] && [ "$v2_json_message" = "$v2_message" ]; then
  record "v2 file refused: run --json" PASS "$v2_code, same message" "#1533"
else
  record "v2 file refused: run --json" FAIL "code '${v2_code}'; see logs/v2-run.json" "#1533"
fi

plan_line="humanish/labs/legacy.yaml -> humanish/studies/legacy.yaml (route: preview)"
hx migrate --dry-run >"$work/logs/migrate-dry.out" 2>"$work/logs/migrate-dry.err"
dry_exit=$?
if [ "$dry_exit" = 0 ] && grep -qxF "$plan_line" "$work/logs/migrate-dry.out" &&
  grep -q "^  moved: actors\[0\] -> actor, actors\[0\].count -> participants, scenario.mode -> mode$" "$work/logs/migrate-dry.out" &&
  grep -q '^  dropped review.scoring: "rubric-v1" (the preview route never reads it)$' "$work/logs/migrate-dry.out" &&
  grep -qxF "humanish/labs/: removed after the move, since nothing else is in it" "$work/logs/migrate-dry.out" &&
  grep -qxF "Dry run: nothing was written. 1 study file would change." "$work/logs/migrate-dry.out" &&
  [ -f "$project/humanish/labs/legacy.yaml" ] && [ ! -e "$project/humanish/studies/legacy.yaml" ]; then
  record "migrate --dry-run" PASS "plan, moved and dropped lines, labs/ removal planned; nothing written" "#1542"
else
  record "migrate --dry-run" FAIL "exit $dry_exit; see logs/migrate-dry.out" "on main"
fi
hx migrate >"$work/logs/migrate.out" 2>"$work/logs/migrate.err"
migrate_exit=$?
hx run legacy --no-open --json >"$work/logs/run-legacy.json" 2>"$work/logs/run-legacy.err"
legacy_ok=$(json_field "$work/logs/run-legacy.json" 'd.ok && d.studyId')
if [ "$migrate_exit" = 0 ] &&
  grep -qxF "Converted 1 study file. Removed humanish/labs/, which the move emptied." "$work/logs/migrate.out" &&
  [ ! -e "$project/humanish/labs" ] &&
  grep -qx "schema: humanish.study.v3" "$project/humanish/studies/legacy.yaml" 2>/dev/null &&
  [ "$legacy_ok" = legacy ]; then
  record "migrate, then run the moved study" PASS "humanish/studies/legacy.yaml (v3) ran; humanish/labs/ removed" "#1542"
else
  record "migrate, then run the moved study" FAIL "exit $migrate_exit, run '${legacy_ok}'; see logs/migrate.out" "on main"
fi

# 14b. --dotenv (#1546), the four cases scripts/dotenv-proof.mjs runs, through the published CLI.
# present.env holds a synthetic E2B_API_KEY; doctor reports presence only.
printf 'E2B_API_KEY=%s\n' "$synthetic_e2b" >"$project/present.env"
hx reclaim --dotenv missing.env --json >"$work/logs/dotenv-missing.json" 2>"$work/logs/dotenv-missing.err"
dotenv_missing_exit=$?
dotenv_missing_code=$(json_field "$work/logs/dotenv-missing.json" 'd.error && d.error.code')
if [ "$dotenv_missing_exit" = 2 ] && [ "$dotenv_missing_code" = HUMANISH_ENV_FILE_NOT_FOUND ]; then
  record "reclaim --dotenv missing.env" PASS "exit 2, $dotenv_missing_code" "#1546"
else
  record "reclaim --dotenv missing.env" FAIL "exit $dotenv_missing_exit, code '${dotenv_missing_code}'; see logs/dotenv-missing.*" "#1546"
fi
hx reclaim --env-file missing.env --json >"$work/logs/env-file-missing.json" 2>"$work/logs/env-file-missing.err"
env_file_missing_exit=$?
if [ "$env_file_missing_exit" = 9 ] && [ ! -s "$work/logs/env-file-missing.json" ] &&
  grep -q "missing.env: not found" "$work/logs/env-file-missing.err"; then
  record "reclaim --env-file missing.env (alias, Node checks it)" PASS "exit 9 from Node, stdout empty" "#1546"
else
  record "reclaim --env-file missing.env (alias, Node checks it)" FAIL "exit $env_file_missing_exit; see logs/env-file-missing.*" "#1546"
fi
dotenv_label='d.checks.filter((c) => c.name === "key E2B_API_KEY").map((c) => c.detail || c.message || "").join(" ")'
rename_warning="\`--env-file\` is now \`--dotenv\`; \`--env-file\` is removed in the first minor release on or after 2026-11-03."
hx doctor --dotenv present.env --json >"$work/logs/doctor-dotenv.json" 2>"$work/logs/doctor-dotenv.err"
doctor_dotenv_label=$(json_field "$work/logs/doctor-dotenv.json" "$dotenv_label")
case "$doctor_dotenv_label" in
  *"supplied by --dotenv present.env"*) record "doctor --dotenv present.env: key label" PASS "supplied by --dotenv present.env" "#1546" ;;
  *) record "doctor --dotenv present.env: key label" FAIL "label '${doctor_dotenv_label}'; see logs/doctor-dotenv.json" "#1546" ;;
esac
hx doctor --env-file present.env --json >"$work/logs/doctor-env-file.json" 2>"$work/logs/doctor-env-file.err"
doctor_alias_label=$(json_field "$work/logs/doctor-env-file.json" "$dotenv_label")
doctor_alias_warned=$(W="$rename_warning" json_field "$work/logs/doctor-env-file.json" '(d.warnings || []).includes(process.env.W)')
if [ "$doctor_alias_warned" = true ] && [ "$(grep -cF "warning: $rename_warning" "$work/logs/doctor-env-file.err")" = 1 ] &&
  case "$doctor_alias_label" in *"supplied by --dotenv present.env"*) true ;; *) false ;; esac; then
  record "doctor --env-file present.env (alias): label and one warning" PASS "same label; rename warning (2026-11-03) on stderr and in warnings[]" "#1546, #1568"
else
  record "doctor --env-file present.env (alias): label and one warning" FAIL "label '${doctor_alias_label}', warned '${doctor_alias_warned}'; see logs/doctor-env-file.*" "#1546, #1568"
fi
reclaim_help=$(hx reclaim --help 2>"$work/logs/reclaim-help.err")
if printf '%s' "$reclaim_help" | grep -q -- "--dotenv <path>" && ! printf '%s' "$reclaim_help" | grep -q -- "--env-file"; then
  record "reclaim --help: --dotenv listed, --env-file hidden" PASS "--dotenv <path>" "#1546"
else
  record "reclaim --help: --dotenv listed, --env-file hidden" FAIL "see logs/reclaim-help.err and the help text" "#1546"
fi

# 14c. Sandbox ids: see check 21's group below, which runs last because it edits the dry run's dir.

# 15. A --count that is not a positive integer is refused with the participant code (#1493 renamed
# HUMANISH_INVALID_SIM_COUNT). The lab-less run checks the count before it writes anything.
hx run --count 0 --json >"$work/logs/count.json" 2>"$work/logs/count.err"
count_exit=$?
count_code=$(json_field "$work/logs/count.json" 'd.error && d.error.code')
if [ "$count_exit" = 2 ] && [ "$count_code" = HUMANISH_INVALID_PARTICIPANT_COUNT ]; then
  record "run --count 0: participant code" PASS "exit 2, $count_code" "on main"
else
  record "run --count 0: participant code" FAIL "exit $count_exit, code '${count_code}'" "on main"
fi

# 16. lab list and --lab, deprecated in 0.108.0, are an unknown command and an unknown option.
hx lab list --json >"$work/logs/lab-list.json" 2>"$work/logs/lab-list.err"
lab_list_exit=$?
hx doctor --lab first-run --json >"$work/logs/doctor-lab.json" 2>"$work/logs/doctor-lab.err"
doctor_lab_exit=$?
if [ "$lab_list_exit" = 1 ] && grep -qF "error: unknown command 'lab'" "$work/logs/lab-list.err" &&
  [ "$doctor_lab_exit" = 1 ] && grep -qF "error: unknown option '--lab'" "$work/logs/doctor-lab.err"; then
  record "lab list and doctor --lab (removed)" PASS "exit 1 each: unknown command, unknown option" "#1526"
else
  record "lab list and doctor --lab (removed)" FAIL "exit $lab_list_exit and $doctor_lab_exit; see logs/lab-list.err, logs/doctor-lab.err" "#1526"
fi

# 17. study show and study check, the names that replaced lab inspect and lab preflight, return
# their schemas. The shapes are #1500's.
hx study show first-run --json >"$work/logs/study-show.json" 2>"$work/logs/study-show.err"
show_schema=$(json_field "$work/logs/study-show.json" 'd.schema')
show_ok=$(json_field "$work/logs/study-show.json" 'd.ok && typeof d.study === "string"')
if [ "$show_schema" = humanish.study-show.v1 ] && [ "$show_ok" = true ]; then
  record "study show first-run: study-show.v1" PASS "$show_schema" "on main"
else
  record "study show first-run: study-show.v1" FAIL "schema '${show_schema}'; see logs/study-show.err" "on main"
fi
hx study check first-run --json >"$work/logs/study-check.json" 2>"$work/logs/study-check.err"
check_schema=$(json_field "$work/logs/study-check.json" 'd.schema')
check_id=$(json_field "$work/logs/study-check.json" 'd.studyId')
if [ "$check_schema" = humanish.study-check.v1 ] && [ "$check_id" = first-run ]; then
  record "study check first-run: study-check.v1" PASS "$check_schema, studyId $check_id" "on main"
else
  record "study check first-run: study-check.v1" FAIL "schema '${check_schema}', studyId '${check_id}'; see logs/study-check.err" "on main"
fi

# 18. stats counts the dry runs above by study, as humanish.stats.v2 with `studies` rows (#1500).
hx stats --json >"$work/logs/stats.json" 2>"$work/logs/stats.err"
stats_schema=$(json_field "$work/logs/stats.json" 'd.schema')
stats_rows=$(json_field "$work/logs/stats.json" '(d.studies || []).map((r) => r.study).join(",")')
case "$stats_schema,$stats_rows," in
  humanish.stats.v2,*first-run,*) record "stats --json: stats.v2 by study" PASS "$stats_schema: $stats_rows" "on main" ;;
  *) record "stats --json: stats.v2 by study" FAIL "schema '${stats_schema}', rows '${stats_rows}'; see logs/stats.err" "on main" ;;
esac

# 19. The dry run from check 4 records its study as `study` only in run.json and status.json (#1531).
run_dir="$project/.humanish/runs/$run_id"
fields='[d.study && d.study.id, "lab" in d ? "lab present" : "no lab"].join(" / ")'
record_fields=$(json_field "$run_dir/run.json" "$fields")
status_fields=$(json_field "$run_dir/status.json" "$fields")
if [ -n "$run_id" ] && [ "$record_fields" = "first-run / no lab" ] && [ "$status_fields" = "first-run / no lab" ]; then
  record "run records study, not lab" PASS "run.json and status.json: study first-run, no lab" "#1531"
else
  record "run records study, not lab" FAIL "run.json '${record_fields}'; status.json '${status_fields}'" "#1531"
fi

# 20. Bare --json reports the study count and ids by their 0.109 keys (#1532).
hx --json >"$work/logs/bare.json" 2>"$work/logs/bare.err"
bare_keys=$(json_field "$work/logs/bare.json" '[d.studyCount, (d.studyIds || []).includes("first-run"), "labCount" in d].join(" ")')
case "$bare_keys" in
  [1-9]*" true false") record "bare --json: studyCount, studyIds" PASS "studyCount, studyIds; no labCount" "#1532" ;;
  *) record "bare --json: studyCount, studyIds" FAIL "studyCount, has first-run, has labCount: '${bare_keys}'; see logs/bare.json" "#1532" ;;
esac

# 20b. run.json records how the run ended, and status.json copies `ok` from it (#1556).
outcome_fields='[d.outcome && d.outcome.state, d.outcome && d.outcome.ok].join(" ")'
run_outcome=$(json_field "$run_dir/run.json" "$outcome_fields")
status_ok=$(json_field "$run_dir/status.json" 'd.outcome && d.outcome.ok')
if [ "$run_outcome" = "finished true" ] && [ "$status_ok" = true ]; then
  record "run.json outcome (dry run)" PASS "outcome.state finished, ok true; status.json ok true" "#1556"
else
  record "run.json outcome (dry run)" FAIL "run.json '${run_outcome}', status.json ok '${status_ok}'" "#1556"
fi

# 20c. review prints the findings section as text, and says why a dry run has none (#1554); its
# JSON carries the same view as humanish.analysis-findings.v1 and the display state (#1556).
# 0.111.4 continues the line with the live command (#1626); 20ao checks that part.
findings_line="findings: none. This is a dry run: no participant used the product, so there is nothing to analyze. Findings come from live runs"
hx review --run "$run_id" >"$work/logs/review.out" 2>"$work/logs/review.err"
review_exit=$?
hx review --run "$run_id" --json >"$work/logs/review.json" 2>"$work/logs/review-json.err"
review_view=$(json_field "$work/logs/review.json" '[d.analysis && d.analysis.schema, d.analysis && d.analysis.state, d.display && d.display.state].join(" ")')
if [ "$review_exit" = 0 ] && grep -q "^${findings_line}[.:]" "$work/logs/review.out" &&
  [ "$(head -n 1 "$work/logs/review.out")" = "humanish review $run_id: dry run; no product behavior was tested" ] &&
  [ "$review_view" = "humanish.analysis-findings.v1 dry_run dry_run" ]; then
  record "review: headline, findings as text, analysis-findings.v1" PASS "headline names the dry run; says why it has no findings; --json analysis and display dry_run" "#1554, #1556, #1562"
else
  record "review: headline, findings as text, analysis-findings.v1" FAIL "exit $review_exit, headline '$(head -n 1 "$work/logs/review.out")', json '${review_view}'; see logs/review.out" "#1554, #1556, #1562"
fi

# 20d. runs and stats show the display state (#1556).
hx runs --json >"$work/logs/runs.json" 2>"$work/logs/runs.err"
runs_display=$(R="$run_id" json_field "$work/logs/runs.json" '(d.runs || []).filter((r) => r.runId === process.env.R).map((r) => r.display && r.display.state).join(",")')
stats_dry=$(json_field "$work/logs/stats.json" 'd.totals && d.totals.outcomes && d.totals.outcomes.dry_run')
if [ "$runs_display" = dry_run ] && [ "${stats_dry:-0}" -ge 1 ] 2>/dev/null; then
  record "runs --json display, stats totals.outcomes" PASS "display dry_run; outcomes.dry_run $stats_dry" "#1556"
else
  record "runs --json display, stats totals.outcomes" FAIL "display '${runs_display}', outcomes.dry_run '${stats_dry}'; see logs/runs.json, logs/stats.json" "#1556"
fi

# 20e. reclaim reports clean, unconfirmed or unknown and exits 0 only for clean (#1557). A dry run
# with nothing journaled is clean with reason dry-run, exits 0 and contacts no E2B (#1561); 0.110.1
# reported it unknown with exit 2.
dry_line="Reclaim $run_id: clean. It was a dry run, which creates no sandboxes, so no provider was contacted."
hx reclaim --run "$run_id" --json >"$work/logs/reclaim.json" 2>"$work/logs/reclaim.err"
reclaim_exit=$?
reclaim_view=$(json_field "$work/logs/reclaim.json" '[d.schema, d.ok, d.state, d.mode, d.reason, d.tagSearch && d.tagSearch.status].join(" ")')
reclaim_human=$(hx reclaim --run "$run_id" 2>"$work/logs/reclaim-human.err" | head -n 1)
if [ "$reclaim_exit" = 0 ] && [ "$reclaim_view" = "humanish.reclaim-result.v1 true clean kill dry-run not-run" ] &&
  [ "$reclaim_human" = "$dry_line" ]; then
  record "reclaim a dry run: clean, exit 0" PASS "state clean, reason dry-run, tag search not-run" "#1557, #1561"
else
  record "reclaim a dry run: clean, exit 0" FAIL "exit $reclaim_exit, '${reclaim_view}', human '${reclaim_human}'" "#1557, #1561"
fi

# 20f. reclaim --check kills nothing and writes nothing (#1557).
before_files=$(cd "$run_dir" && find . -type f -printf '%p %s %T@\n' | sort)
hx reclaim --check --run "$run_id" --json >"$work/logs/reclaim-check.json" 2>"$work/logs/reclaim-check.err"
check_exit=$?
after_files=$(cd "$run_dir" && find . -type f -printf '%p %s %T@\n' | sort)
check_view=$(json_field "$work/logs/reclaim-check.json" '[d.schema, d.ok, d.state, d.mode].join(" ")')
check_human=$(hx reclaim --check --run "$run_id" 2>"$work/logs/reclaim-check-human.err" | head -n 1)
if [ "$check_exit" = 0 ] && [ "$check_view" = "humanish.reclaim-result.v1 true clean check" ] &&
  [ "$before_files" = "$after_files" ] && [ "$check_human" = "Reclaim check $run_id: clean. It was a dry run, which creates no sandboxes, so no provider was contacted." ]; then
  record "reclaim --check: mode check, run dir unchanged" PASS "exit 0, clean (dry run); no file written" "#1557, #1561"
else
  record "reclaim --check: mode check, run dir unchanged" FAIL "exit $check_exit, '${check_view}', human '${check_human}'; files changed: $([ "$before_files" = "$after_files" ] && echo no || echo yes)" "#1557, #1561"
fi

# 20g. cleanup is a deprecated alias of reclaim --check: one warning on stderr, the same text first
# in warnings[], then the reclaim --check result. It writes no cleanup.json and is not in --help.
cleanup_warning="\`cleanup\` is now \`reclaim --check\`; \`cleanup\` is removed in the first minor release on or after 2026-11-03."
hx cleanup --run "$run_id" --json >"$work/logs/cleanup-alias.json" 2>"$work/logs/cleanup-alias.err"
alias_exit=$?
alias_first=$(W="$cleanup_warning" json_field "$work/logs/cleanup-alias.json" '(d.warnings || [])[0] === process.env.W')
same_result=$(node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));delete a.warnings;delete b.warnings;process.stdout.write(String(JSON.stringify(a)===JSON.stringify(b)))' "$work/logs/cleanup-alias.json" "$work/logs/reclaim-check.json" 2>/dev/null)
help_mentions=$(hx --help 2>/dev/null | grep -c "cleanup")
if [ "$alias_exit" = 0 ] && [ "$alias_first" = true ] && [ "$same_result" = true ] &&
  [ "$(grep -cF "warning: $cleanup_warning" "$work/logs/cleanup-alias.err")" = 1 ] &&
  [ ! -e "$run_dir/cleanup.json" ] && [ "$help_mentions" = 0 ]; then
  record "cleanup (deprecated): warns, runs reclaim --check" PASS "one stderr warning, warnings[0], same result, no cleanup.json, hidden from --help" "#1557"
else
  record "cleanup (deprecated): warns, runs reclaim --check" FAIL "exit $alias_exit, warnings[0] '${alias_first}', same '${same_result}', --help mentions $help_mentions; see logs/cleanup-alias.*" "#1557"
fi

# 20h. Claude Code below 2.1.248 is refused before a desktop starts (#1555). A stand-in `claude`
# on PATH reports 2.1.200 and a login, so this needs no real Claude Code. present-keys.env holds
# synthetic keys: if the refusal failed, the create would fail on E2B auth and spend nothing.
mkdir -p "$work/fake-claude"
cat >"$work/fake-claude/claude" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo "2.1.200 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0 ;;
esac
echo "stand-in claude: unexpected $*" >&2
exit 3
SH
chmod +x "$work/fake-claude/claude"
printf 'E2B_API_KEY=%s\nOPENAI_API_KEY=%s\n' "$synthetic_e2b" "$synthetic_openai" >"$project/present-keys.env"
cat >"$project/humanish/studies/claude-floor.yaml" <<'YAML'
schema: humanish.study.v3
id: claude-floor
title: Claude Code version floor
route: computer-use
mode: live
subject:
  source: clone
  repos: [your-org/your-app]
  serve:
    start: npm start
    url: http://127.0.0.1:3000/
actor:
  type: local-agent
  localAgent: claude
  persona: synthetic-new-user
  mission: Open the app and stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx_old_claude() { (cd "$project" && timeout 600 "${run_env[@]}" "PATH=$work/fake-claude:$user_path" npx -y --package "$spec" humanish "$@"); }
hx_old_claude run claude-floor --dotenv present-keys.env --no-open --json >"$work/logs/claude-floor.json" 2>"$work/logs/claude-floor.err"
floor_exit=$?
floor_code=$(json_field "$work/logs/claude-floor.json" 'd.error && d.error.code')
floor_message=$(json_field "$work/logs/claude-floor.json" 'd.error && d.error.message')
hx_old_claude doctor --study claude-floor --dotenv present-keys.env --json >"$work/logs/claude-floor-doctor.json" 2>"$work/logs/claude-floor-doctor.err"
floor_doctor_exit=$?
case "$floor_exit,$floor_code,$floor_message" in
  "2,HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED,"*"2.1.248 or newer"*"this machine has 2.1.200"*"No desktop was launched."*)
    if [ "$floor_doctor_exit" = 2 ] && grep -q "2.1.248 or newer" "$work/logs/claude-floor-doctor.json"; then
      record "Claude Code 2.1.200 refused before a desktop" PASS "run exit 2 $floor_code; doctor --study exit 2 names 2.1.248" "#1555"
    else
      record "Claude Code 2.1.200 refused before a desktop" FAIL "run refused, but doctor --study exit $floor_doctor_exit; see logs/claude-floor-doctor.json" "#1555"
    fi ;;
  *) record "Claude Code 2.1.200 refused before a desktop" FAIL "exit $floor_exit, code '${floor_code}'; see logs/claude-floor.*" "#1555" ;;
esac

# 20i. Bare doctor with the same stand-in: the Claude Code row is a note, not ok, and doctor exits 0
# (#1562). 0.110.1 marked the row ok while its message said Claude Code could not run participants.
hx_old_claude doctor --json >"$work/logs/claude-bare-doctor.json" 2>"$work/logs/claude-bare-doctor.err"
claude_bare_exit=$?
claude_row=$(json_field "$work/logs/claude-bare-doctor.json" 'd.checks.filter((c) => c.name === "local agent claude").map((c) => c.status + " " + /2\.1\.248 or newer/.test(c.message)).join(",")')
if [ "$claude_bare_exit" = 0 ] && [ "$claude_row" = "note true" ]; then
  record "doctor (Claude Code 2.1.200): row is a note" PASS "exit 0; local agent claude: note, names 2.1.248" "#1562"
else
  record "doctor (Claude Code 2.1.200): row is a note" FAIL "exit $claude_bare_exit, row '${claude_row}'; see logs/claude-bare-doctor.json" "#1562"
fi

# 20j. watch and observe print the Observer path and exit 0 without a terminal (#1563). stdin is
# /dev/null and env -i names no agent runner, so the stdin test alone decides. 0.110.1 served until
# the timeout (exit 124). #1568 reworded the warning's last sentence; 0.110.2 said "Open the file,
# or pass --serve to keep serving."
no_tty="No interactive terminal, so watch printed the Observer path and exited instead of serving it until Ctrl-C. Pass --serve to keep serving, or open the file."
(cd "$project" && timeout 90 "${run_env[@]}" npx -y --package "$spec" humanish watch first-run --no-open </dev/null) >"$work/logs/watch-notty.out" 2>&1
watch_exit=$?
(cd "$project" && timeout 90 "${run_env[@]}" npx -y --package "$spec" humanish observe --run "$run_id" --no-open </dev/null) >"$work/logs/observe-notty.out" 2>&1
observe_exit=$?
if [ "$watch_exit" = 0 ] && grep -qxF "warning: $no_tty" "$work/logs/watch-notty.out" &&
  [ "$observe_exit" = 0 ] && grep -qxF "warning: ${no_tty/watch/observe}" "$work/logs/observe-notty.out" &&
  grep -q "^observer: " "$work/logs/watch-notty.out"; then
  record "watch and observe exit without a terminal" PASS "exit 0 each, Observer path printed, warning names --serve" "#1563, #1568"
else
  record "watch and observe exit without a terminal" FAIL "watch exit $watch_exit, observe exit $observe_exit (124 = still serving), warning '$(grep -m1 'Observer path and exited' "$work/logs/watch-notty.out" | cut -c1-200)'; see logs/watch-notty.out, logs/observe-notty.out" "#1563, #1568"
fi

# 20k. A study URL with a user name and password, or a token parameter, is refused at `study check`
# with HUMANISH_STUDY_INVALID, and the message names the field, never the value (#1564). An ordinary
# query still parses. The values are built here; they are fixtures, not credentials.
url_pass=$(printf 'pass%.0s' 1 2 3)
url_token=$(printf 'smoke%.0s' 1 2 3 4)
write_url_study() { # id url
  cat >"$project/humanish/studies/$1.yaml" <<YAML
schema: humanish.study.v3
id: $1
title: Credential URL check
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: "$2"
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: Open the page and stop.
caps:
  maxUsd: 1
execution:
  target: e2b-desktop
  timeoutMs: 600000
policies:
  allowPublicTargets: true
YAML
}
write_url_study url-userinfo "https://verify-user:$url_pass@example.com/"
write_url_study url-token "https://example.com/app?token=$url_token"
write_url_study url-plain "https://example.com/app?page=2&utm_source=verify"
url_rows=""
for id in url-userinfo url-token url-plain; do
  hx study check "$id" --json >"$work/logs/$id.json" 2>"$work/logs/$id.err"
  url_exit=$?
  url_view=$(json_field "$work/logs/$id.json" '[d.ok, d.error ? d.error.code : "-", d.error ? d.error.message.startsWith("`subject.appUrl` ") : "-"].join(" ")')
  leaked=$(cat "$work/logs/$id.json" "$work/logs/$id.err" | grep -cF -e "$url_pass" -e "$url_token")
  url_rows="$url_rows $id=$url_exit/$url_view/leaked:$leaked;"
done
rm -f "$project/humanish/studies/url-userinfo.yaml" "$project/humanish/studies/url-token.yaml" \
  "$project/humanish/studies/url-plain.yaml"
if [ "$url_rows" = " url-userinfo=2/false HUMANISH_STUDY_INVALID true/leaked:0; url-token=2/false HUMANISH_STUDY_INVALID true/leaked:0; url-plain=0/true - -/leaked:0;" ]; then
  record "study check refuses credential URLs" PASS "userinfo and token=: exit 2 HUMANISH_STUDY_INVALID naming subject.appUrl, value not echoed; ?page=2 passes" "#1564"
else
  record "study check refuses credential URLs" FAIL "${url_rows}; see logs/url-*.json" "#1564"
fi

# 20l. A terminal study that declares no runtimeAuth records openai-egress as the default (#1564).
# A dry run records the declaration only; 0.110.1's default was openai-env.
cat >"$project/humanish/studies/terminal-default-auth.yaml" <<'YAML'
schema: humanish.study.v3
id: terminal-default-auth
title: Terminal dry run with no runtimeAuth declared
route: terminal
mode: dry-run
subject:
  source: terminal-product
  product:
    name: widgetsmith-cli
    publicSurfaces:
      - https://example.com/widgetsmith
actor:
  type: codex-exec
  persona: autonomous-creative-agent
  mission: Find widgetsmith-cli from its public page and say what it does.
caps:
  maxUsd: 0
  maxJobs: 0
  maxMinutes: 10
YAML
hx run terminal-default-auth --no-open --json >"$work/logs/terminal-default-auth.json" 2>"$work/logs/terminal-default-auth.err"
tda_exit=$?
tda_run=$(json_field "$work/logs/terminal-default-auth.json" 'd.runId')
tda_channel=$(grep -o 'Runtime auth channel: [a-z-]*, the default' "$project/.humanish/runs/$tda_run/run.json" 2>/dev/null | head -n 1)
if [ "$tda_exit" = 0 ] && [ "$tda_channel" = "Runtime auth channel: openai-egress, the default" ]; then
  record "terminal study without runtimeAuth: openai-egress" PASS "dry run records \"$tda_channel\"" "#1564"
else
  record "terminal study without runtimeAuth: openai-egress" FAIL "exit $tda_exit, channel '${tda_channel}'; see logs/terminal-default-auth.*" "#1564"
fi

# 20m. verify blocks a run file that holds a token parameter (#1564); 0.110.1 graded it share_ready.
hx run first-run --run-id verify-token --no-open --json >"$work/logs/verify-token-run.json" 2>"$work/logs/verify-token-run.err"
printf '\nSee https://example.com/app?token=%s for the page.\n' "$url_token" >>"$project/.humanish/runs/verify-token/review.md"
hx verify --run verify-token --json >"$work/logs/verify-token.json" 2>"$work/logs/verify-token.err"
token_exit=$?
token_view=$(json_field "$work/logs/verify-token.json" '[d.shareSafety && d.shareSafety.status, (d.shareSafety && d.shareSafety.reasons || []).some((r) => r.code === "PUBLIC_SAFETY_FINDINGS")].join(" ")')
if [ "$token_exit" = 2 ] && [ "$token_view" = "blocked true" ] && ! grep -qF "$url_token" "$work/logs/verify-token.json"; then
  record "verify blocks a token= parameter" PASS "exit 2, blocked, PUBLIC_SAFETY_FINDINGS; value not echoed" "#1564"
else
  record "verify blocks a token= parameter" FAIL "exit $token_exit, '${token_view}'; see logs/verify-token.json" "#1564"
fi

# 20n-20u: 0.110.3 (#1567, #1568, #1569). There is no 20p: check 14b reads the --env-file warning.
# The PTY helper runs `npx humanish <args>` under a pseudo-terminal with run_env's variables plus
# any KEY=VALUE given. Asked to, it sends Ctrl-C (byte 0x03) the moment "press Ctrl-C to stop"
# appears. It prints whether it sent one and the output's `... stopped` lines, and never waits
# past 120 s.
cat >"$work/pty_driver.py" <<'PTY'
import os, pty, select, signal, sys, time
cwd, out, ctrl_c = sys.argv[1], sys.argv[2], sys.argv[3] == "ctrl-c"
rest = sys.argv[4:]
sep = rest.index("--")
env = dict(kv.split("=", 1) for kv in rest[:sep])
argv = rest[sep + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)
buf, sent, deadline = b"", None, time.time() + 120
while time.time() < deadline:
    if select.select([fd], [], [], 0.05)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if ctrl_c and sent is None and b"press Ctrl-C to stop" in buf:
            os.write(fd, b"\x03")
            sent = time.time()
    if sent and time.time() - sent > 20:
        break
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
open(out, "wb").write(buf)
# The terminal echoes the Ctrl-C as "^C", which can land before the prompt's own line break, so a
# stopped line is the text after the line's last echo.
stopped = [l.decode(errors="replace").split("^C")[-1].replace("\x03", "").strip()
           for l in buf.splitlines() if l.strip().endswith(b"stopped")]
print(f"sent={sent is not None} stopped={','.join(stopped) or 'none'}")
PTY
# run_env without its `env -i` and with a terminal type a PTY reports.
pty_env=()
for kv in "${run_env[@]:2}"; do
  case "$kv" in TERM=*) pty_env+=("TERM=xterm-256color") ;; *) pty_env+=("$kv") ;; esac
done
hx_pty() { # out-file ctrl-c|wait [KEY=VALUE ...] -- humanish args
  local out=$1 mode=$2
  shift 2
  local extra=()
  while [ "$1" != -- ]; do
    extra+=("$1")
    shift
  done
  shift
  timeout 150 python3 "$work/pty_driver.py" "$project" "$out" "$mode" "${pty_env[@]}" "${extra[@]}" -- npx -y --package "$spec" humanish "$@"
}

# 20n. Under a real terminal with an agent runner's variable set, watch exits without serving and
# its warning names the variable and the runner (#1568). 0.110.2 said "No interactive terminal".
agent_line="warning: An agent environment was detected (CLAUDECODE is set, which Claude Code sets), so watch printed the Observer path and exited instead of serving it until Ctrl-C. Pass --serve to keep serving, or open the file."
hx_pty "$work/logs/watch-agent.out" wait CLAUDECODE=1 -- watch first-run --no-open >"$work/logs/watch-agent.result" 2>&1
if tr -d '\r' <"$work/logs/watch-agent.out" | grep -qxF "$agent_line" && ! grep -q "press Ctrl-C to stop" "$work/logs/watch-agent.out"; then
  record "watch under a terminal with CLAUDECODE=1: warning names it" PASS "exits without serving; names CLAUDECODE and Claude Code" "#1568"
else
  record "watch under a terminal with CLAUDECODE=1: warning names it" FAIL "warning: '$(tr -d '\r' <"$work/logs/watch-agent.out" | grep -m1 'Observer path and exited' | cut -c1-90)'; see logs/watch-agent.out" "#1568"
fi

# 20o. Under a real terminal with no agent variable, a Ctrl-C sent the moment the prompt prints
# runs the shutdown: `watch stopped` and `observe stopped` (#1567). 0.110.2 printed the prompt
# before it installed the handler; it printed neither line in 11 such runs.
ctrl_rows=""
for i in 1 2 3; do
  ctrl_rows="$ctrl_rows watch$i:$(hx_pty "$work/logs/watch-ctrlc-$i.out" ctrl-c -- watch first-run --no-open)"
  ctrl_rows="$ctrl_rows observe$i:$(hx_pty "$work/logs/observe-ctrlc-$i.out" ctrl-c -- observe --run "$run_id" --no-open)"
done
ctrl_want=""
for i in 1 2 3; do
  ctrl_want="$ctrl_want watch$i:sent=True stopped=watch stopped observe$i:sent=True stopped=observe stopped"
done
if [ "$ctrl_rows" = "$ctrl_want" ]; then
  record "Ctrl-C at the watch and observe prompt: stopped line" PASS "3 of 3 each: watch stopped, observe stopped" "#1567"
else
  record "Ctrl-C at the watch and observe prompt: stopped line" FAIL "${ctrl_rows}; see logs/watch-ctrlc-*.out, logs/observe-ctrlc-*.out" "#1567"
fi

# 20q. verify reads `http://192.0.2.1\nE2B_SANDBOX=...` (a JSON-escaped line break) as no E2B URL
# (#1568); 0.110.2 blocked it. 20r. The E2B docs page that E2B's 401 names passes verify (#1568);
# 0.110.2 blocked it. Each line goes into its own dry run's review.md, as 20m does.
hx run first-run --run-id verify-escape --no-open --json >"$work/logs/verify-escape-run.json" 2>&1
printf '\nAgent output: http://192.0.2.1\\nE2B_SANDBOX=example\n' >>"$project/.humanish/runs/verify-escape/review.md"
hx verify --run verify-escape --json >"$work/logs/verify-escape.json" 2>"$work/logs/verify-escape.err"
escape_exit=$?
escape_share=$(json_field "$work/logs/verify-escape.json" 'd.shareSafety && d.shareSafety.status')
if [ "$escape_exit" = 0 ] && [ "$escape_share" = share_ready ]; then
  record "verify: escaped line break before E2B_ is no E2B URL" PASS "exit 0, share_ready" "#1568"
else
  record "verify: escaped line break before E2B_ is no E2B URL" FAIL "exit $escape_exit, '${escape_share}'; see logs/verify-escape.json" "#1568"
fi
hx run first-run --run-id verify-docs --no-open --json >"$work/logs/verify-docs-run.json" 2>&1
printf '\nSee https://docs.e2b.dev/api-key for more information.\n' >>"$project/.humanish/runs/verify-docs/review.md"
hx verify --run verify-docs --json >"$work/logs/verify-docs.json" 2>"$work/logs/verify-docs.err"
docs_exit=$?
docs_share=$(json_field "$work/logs/verify-docs.json" 'd.shareSafety && d.shareSafety.status')
if [ "$docs_exit" = 0 ] && [ "$docs_share" = share_ready ]; then
  record "verify: https://docs.e2b.dev/api-key passes" PASS "exit 0, share_ready" "#1568"
else
  record "verify: https://docs.e2b.dev/api-key passes" FAIL "exit $docs_exit, '${docs_share}'; see logs/verify-docs.json" "#1568"
fi

# 20s. init's humanish/README.md names commands with the install's invocation (#1568). 0.110.2
# wrote bare `humanish run`, which a project install does not put on PATH.
bare_cmds=$(grep -c '`humanish ' "$project/humanish/README.md")
npx_cmds=$(grep -c '`npx humanish' "$project/humanish/README.md")
if [ "$bare_cmds" = 0 ] && [ "$npx_cmds" -ge 1 ]; then
  record "init README: no bare humanish commands" PASS "$npx_cmds lines with npx humanish, 0 bare" "#1568"
else
  record "init README: no bare humanish commands" FAIL "$bare_cmds bare, $npx_cmds npx; see humanish/README.md" "#1568"
fi

# 20t. review on a live scripted run whose study sets review.analysis: false reports the findings
# view skipped with AUTOMATIC_ANALYSIS_DISABLED and names the study file (#1568). 0.110.2 said
# `none`. The scripted route replays four steps with a local browser against a loopback page: no
# model and no sandbox. The page and its server are written here and stopped after the run.
cat >"$work/signup-app.mjs" <<'JS'
import { createServer } from "node:http";
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signup</title></head>
<body><main><h1>Sign up</h1><form id="f"><label>Email <input type="email" name="email" required></label>
<button type="submit">Create account</button></form><p id="out"></p></main>
<script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault();
document.getElementById('out').textContent = 'Welcome, your account is ready.'; });</script></body></html>`;
const server = createServer((_q, r) => {
  r.setHeader("content-type", "text/html; charset=utf-8");
  r.end(page);
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
JS
timeout 300 node "$work/signup-app.mjs" >"$work/logs/signup-app.port" 2>&1 &
app_pid=$!
for _ in $(seq 1 50); do
  [ -s "$work/logs/signup-app.port" ] && break
  sleep 0.1
done
app_port=$(head -n 1 "$work/logs/signup-app.port")
mkdir -p "$project/humanish/scenarios"
cat >"$project/humanish/scenarios/verify-signup.yaml" <<'YAML'
schema: humanish.scenario.v1
id: verify-signup
title: Signup walkthrough
goal: Load the page, submit the form, and see the welcome line.
browser:
  startPath: /
  steps:
    - id: step-01-load
      label: Load the page
      action: goto
      path: /
      expect:
        selectorVisible: "main"
    - id: step-02-fill-email
      label: Fill the email
      action: fill
      selector: "input[type='email']"
      value: synthetic.user@example.test
    - id: step-03-submit
      label: Submit
      action: click
      selector: "button[type='submit']"
      expect:
        stateChanged: true
    - id: step-04-confirm
      label: See the welcome line
      action: waitForText
      expect:
        text: "Welcome"
YAML
cat >"$project/humanish/studies/scripted-analysis-off.yaml" <<YAML
schema: humanish.study.v3
id: scripted-analysis-off
title: Scripted signup with analysis off
route: scripted
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:$app_port
actor:
  type: scripted-browser
  persona: synthetic-new-user
scenario: verify-signup
execution:
  target: local
  timeoutMs: 120000
review:
  analysis: false
YAML
hx run scripted-analysis-off --no-open --json >"$work/logs/scripted-off-run.json" 2>"$work/logs/scripted-off-run.err"
off_exit=$?
kill "$app_pid" 2>/dev/null
wait "$app_pid" 2>/dev/null
off_run=$(json_field "$work/logs/scripted-off-run.json" 'd.runId')
hx review --run "$off_run" --json >"$work/logs/scripted-off-review.json" 2>"$work/logs/scripted-off-review.err"
off_view=$(json_field "$work/logs/scripted-off-review.json" '[d.analysis && d.analysis.state, d.analysis && d.analysis.reason, d.analysis && /review\.analysis: false in humanish\/studies\/scripted-analysis-off\.yaml/.test(d.analysis.message)].join(" ")')
if [ "$off_exit" = 0 ] && [ "$off_view" = "skipped AUTOMATIC_ANALYSIS_DISABLED true" ]; then
  record "review: live run with review.analysis: false" PASS "scripted run exit 0; analysis skipped AUTOMATIC_ANALYSIS_DISABLED, names the study file" "#1568"
else
  record "review: live run with review.analysis: false" FAIL "run exit $off_exit, view '${off_view}'; see logs/scripted-off-*" "#1568"
fi

# 20u. Keyless live runs on the computer-use, terminal and shared-world routes are refused before a
# run starts: exit 2, the route's code, and the analysis recorded skipped. #1569 moved these
# refusals into one shell (src/run/route-shell.ts); 0.110.2 prints the same envelopes.
cat >"$project/humanish/studies/refuse-terminal.yaml" <<'YAML'
schema: humanish.study.v3
id: refuse-terminal
title: Live terminal study with no key
route: terminal
mode: live
subject:
  source: terminal-product
  product:
    name: widgetsmith-cli
    publicSurfaces:
      - https://example.com/widgetsmith
actor:
  type: codex-exec
  persona: autonomous-creative-agent
  mission: Find widgetsmith-cli from its public page and say what it does.
caps:
  maxUsd: 0
  maxJobs: 0
  maxMinutes: 10
YAML
cat >"$project/humanish/studies/refuse-shared-world.yaml" <<'YAML'
schema: humanish.study.v3
id: refuse-shared-world
title: Live shared-world study with no key
route: shared-world
mode: live
subject:
  source: clone
  exposure: synthetic
  repos:
    - example-org/collab-notes-app
  serve:
    start: HOST=0.0.0.0 PORT=3000 python3 server.py
    url: http://127.0.0.1:3000/
  state:
    checkpoint:
      - name: task-count
        command: python3 checkpoint.py
actor:
  type: openai-computer-use
  mission: Add one task, then stop.
participants:
  - id: persona-a
    persona: weekly-planner
    device: desktop
    instruction: Add one task, then stop.
  - id: persona-b
    persona: ops-coordinator
    device: desktop
    instruction: Add one task, then stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
refusal_rows=""
for study in try-live refuse-terminal refuse-shared-world; do
  hx run "$study" --no-open --json >"$work/logs/refuse-$study.json" 2>"$work/logs/refuse-$study.err"
  refusal_exit=$?
  refusal_rows="$refusal_rows $study=$refusal_exit/$(json_field "$work/logs/refuse-$study.json" '[d.ok, d.runId, d.error && d.error.code, d.automaticAnalysis && d.automaticAnalysis.state, d.automaticAnalysis && d.automaticAnalysis.reason].join(",")')"
done
refusal_want=" try-live=2/false,not-created,HUMANISH_COMPUTER_USE_KEYS_MISSING,skipped,AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE"
refusal_want="$refusal_want refuse-terminal=2/false,not-created,HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING,skipped,AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE"
refusal_want="$refusal_want refuse-shared-world=2/false,not-created,HUMANISH_SHARED_WORLD_KEYS_MISSING,skipped,AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE"
rm -f "$project/humanish/studies/refuse-terminal.yaml" "$project/humanish/studies/refuse-shared-world.yaml"
if [ "$refusal_rows" = "$refusal_want" ]; then
  record "keyless live runs refused on three shell routes" PASS "exit 2 each, not-created, the route's code, analysis skipped" "#1569 (same on 0.110.2)"
else
  record "keyless live runs refused on three shell routes" FAIL "${refusal_rows}; see logs/refuse-*.json" "#1569 (same on 0.110.2)"
fi

# 20v-20z: 0.110.4 (#1574, #1575).

# 20v. reclaim --check on the live scripted app-url run from 20t reports `clean` with reason
# `no-sandbox` and exit 0, without searching E2B (#1574). hx installs no @e2b/desktop and run_env
# holds no E2B key, so a search could not succeed. 0.110.3 reported `unknown` and exited 2.
hx reclaim --check --run "$off_run" --json >"$work/logs/scripted-off-reclaim.json" 2>"$work/logs/scripted-off-reclaim.err"
off_reclaim_exit=$?
off_reclaim=$(json_field "$work/logs/scripted-off-reclaim.json" '[d.state, d.reason, d.tagSearch && d.tagSearch.status].join(" ")')
off_sandboxes=$(json_field "$project/.humanish/runs/$off_run/status.json" 'd.sandboxes')
if [ "$off_reclaim_exit" = 0 ] && [ "$off_reclaim" = "clean no-sandbox not-run" ] && [ "$off_sandboxes" = none ]; then
  record "reclaim --check on a live scripted app-url run: clean, no-sandbox" PASS "exit 0, clean, reason no-sandbox, tag search not run; status.json sandboxes: none" "#1574"
else
  record "reclaim --check on a live scripted app-url run: clean, no-sandbox" FAIL "exit $off_reclaim_exit, '${off_reclaim}', status.json sandboxes '${off_sandboxes}'; see logs/scripted-off-reclaim.*" "#1574"
fi

# 20w. The scripted route launches Chrome under a TMPDIR too long for Chrome's singleton socket
# path (#1574): the run is the 20t study, with TMPDIR set to a directory of more than 62 bytes.
# 0.110.3 failed the surface with "browserType.launch: Target page, context or browser has been
# closed".
long_tmp="$work/tmpdir-long-enough-that-chrome-singleton-socket-path-overflows"
mkdir -p "$long_tmp"
long_bytes=$(printf '%s' "$long_tmp" | wc -c)
timeout 300 node "$work/signup-app.mjs" >"$work/logs/signup-app-long.port" 2>&1 &
app_pid=$!
for _ in $(seq 1 50); do
  [ -s "$work/logs/signup-app-long.port" ] && break
  sleep 0.1
done
sed -i "s#appUrl: http://127.0.0.1:[0-9]*#appUrl: http://127.0.0.1:$(head -n 1 "$work/logs/signup-app-long.port")#" "$project/humanish/studies/scripted-analysis-off.yaml"
(cd "$project" && timeout 600 "${run_env[@]}" "TMPDIR=$long_tmp" npx -y --package "$spec" humanish run scripted-analysis-off --no-open --json) >"$work/logs/scripted-long-tmp.json" 2>"$work/logs/scripted-long-tmp.err"
long_exit=$?
kill "$app_pid" 2>/dev/null
wait "$app_pid" 2>/dev/null
long_sessions=$(json_field "$work/logs/scripted-long-tmp.json" '(d.sessions || []).map((s) => s.surface + ":" + s.status).join(",")')
if [ "$long_exit" = 0 ] && [ "$long_sessions" = "desktop:passed" ] && [ "$long_bytes" -gt 62 ]; then
  record "scripted run with a ${long_bytes}-byte TMPDIR" PASS "exit 0; sessions '${long_sessions}'" "#1574"
else
  record "scripted run with a ${long_bytes}-byte TMPDIR" FAIL "exit $long_exit; sessions '${long_sessions}', reason '$(json_field "$work/logs/scripted-long-tmp.json" '(d.sessions || []).map((s) => s.reason).join(" | ")' | cut -c1-90)'; see logs/scripted-long-tmp.*" "#1574"
fi

# 20x. A live run that fails before any participant starts prints no "Participants finished;
# preparing analysis…" line (#1574). The keys are synthetic: E2B refuses the malformed key with a
# 401 before anything is created, and no model request is made. 0.110.3 printed the line.
(cd "$project" && timeout 300 "${run_env[@]}" OPENAI_API_KEY=sk-synthetic-not-a-key E2B_API_KEY=e2b_synthetic-malformed-key npx -y --package "$spec" --package @e2b/desktop humanish run try-live --no-open --json) >"$work/logs/no-participant-run.json" 2>"$work/logs/no-participant-run.err"
np_exit=$?
np_facts=$(json_field "$work/logs/no-participant-run.json" '[d.ok, d.error && d.error.code, d.automaticAnalysis && d.automaticAnalysis.state, d.automaticAnalysis && d.automaticAnalysis.reason].join(",")')
np_lines=$(grep -c "preparing analysis" "$work/logs/no-participant-run.err")
if [ "$np_exit" = 2 ] && [ "$np_facts" = "false,HUMANISH_COMPUTER_USE_FAILED,skipped,AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE" ] && [ "$np_lines" = 0 ]; then
  record "E2B refuses the key before a participant starts: no preparing-analysis line" PASS "exit 2, HUMANISH_COMPUTER_USE_FAILED, analysis skipped NO_PARTICIPANT_EVIDENCE, 0 such lines" "#1574"
else
  record "E2B refuses the key before a participant starts: no preparing-analysis line" FAIL "exit $np_exit, '${np_facts}', $np_lines preparing-analysis lines; see logs/no-participant-run.*" "#1574"
fi

# 20y. review on a run interrupted while a participant was still running says so, in text and in
# --json (#1574). The run is a dry run whose run.json is edited to the shape an interrupted live
# run leaves: outcome `interrupted` by SIGINT, and its first participant record still `running`.
# 0.110.3 printed the review the last flush wrote.
hx run first-run --run-id review-interrupted --no-open --json >"$work/logs/review-interrupted-run.json" 2>&1
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.outcome={state:"interrupted",ok:false,signal:"SIGINT",at:"2026-10-05T00:00:00.000Z"};d.simulations[0].status="running";fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$project/.humanish/runs/review-interrupted/run.json"
hx review --run review-interrupted >"$work/logs/review-interrupted.txt" 2>"$work/logs/review-interrupted.err"
ri_exit=$?
hx review --run review-interrupted --json >"$work/logs/review-interrupted.json" 2>>"$work/logs/review-interrupted.err"
ri_summary="Interrupted by SIGINT while 1 of 4 participants was still running."
ri_gap="1 participant has no verdict: the run stopped before its session ended."
ri_json=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write([d.summary===process.argv[2],JSON.stringify(d.gaps)===JSON.stringify([process.argv[3]])].join(","))' "$work/logs/review-interrupted.json" "$ri_summary" "$ri_gap" 2>/dev/null)
if [ "$ri_exit" = 0 ] && grep -qxF "$ri_summary" "$work/logs/review-interrupted.txt" && grep -qxF -- "- $ri_gap" "$work/logs/review-interrupted.txt" && [ "$ri_json" = "true,true" ]; then
  record "review on an interrupted run with a running participant" PASS "text and --json: '${ri_summary}'" "#1574"
else
  record "review on an interrupted run with a running participant" FAIL "exit $ri_exit, json '${ri_json}', summary '$(sed -n 3p "$work/logs/review-interrupted.txt" | cut -c1-80)'; see logs/review-interrupted.*" "#1574"
fi

# 20z. migrate's refusal of a v2 file names v3 keys when a planner check refuses it (#1575):
# `actor.type`. 0.110.3 said `actors[0].type`. The file stays where it was.
mkdir -p "$work/migrate-refusal/humanish/labs"
cat >"$work/migrate-refusal/humanish/labs/bad-actor.yaml" <<'YAML'
schema: humanish.lab.v2
id: bad-actor
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actors:
  - type: not-a-real-actor
execution:
  target: e2b-desktop
YAML
hx migrate --cwd "$work/migrate-refusal" >"$work/logs/migrate-refusal.out" 2>"$work/logs/migrate-refusal.err"
mr_exit=$?
if [ "$mr_exit" = 2 ] && grep -qF 'it does not parse: actor.type must be a registered computer-use actor' "$work/logs/migrate-refusal.out" "$work/logs/migrate-refusal.err" &&
  ! grep -qF 'actors[0].type' "$work/logs/migrate-refusal.out" "$work/logs/migrate-refusal.err" &&
  [ -f "$work/migrate-refusal/humanish/labs/bad-actor.yaml" ]; then
  record "migrate refusal names actor.type" PASS "exit 2, HUMANISH_MIGRATE_REFUSED, 'actor.type must be ...'; file kept" "#1575"
else
  record "migrate refusal names actor.type" FAIL "exit $mr_exit, '$(cat "$work/logs/migrate-refusal.out" "$work/logs/migrate-refusal.err" | grep -o 'it does not parse: [^ ]*' | head -n 1)'; see logs/migrate-refusal.*" "#1575"
fi

# 20aa-20ae: 0.111.0 (#1581, #1582).

# 20aa. study show --json prints the v3 config (#1581): `config.actor`, `config.route`,
# `config.participants` and `config.mode`, and no `config.actors` or `config.scenario` object.
# 0.110.4 printed `actors[]` and `scenario.mode`.
hx study show first-run --json >"$work/logs/show-v3.json" 2>"$work/logs/show-v3.err"
show_v3=$(json_field "$work/logs/show-v3.json" '[d.config.actor && d.config.actor.type, d.config.route, d.config.participants, d.config.mode, "actors" in d.config, typeof d.config.scenario].join(" ")')
if [ "$show_v3" = "synthetic-persona preview 4 dry-run false undefined" ]; then
  record "study show --json: the v3 config" PASS "actor.type, route, participants 4, mode; no actors, no scenario object" "#1581"
else
  record "study show --json: the v3 config" FAIL "'${show_v3}'; see logs/show-v3.*" "#1581"
fi

# 20ab. The human study show prints `actor:` where 0.110.4 printed `actors:` (#1582).
hx study show first-run >"$work/logs/show-human.out" 2>"$work/logs/show-human.err"
if grep -qx "actor: synthetic-persona" "$work/logs/show-human.out" && ! grep -q "^actors:" "$work/logs/show-human.out"; then
  record "study show (human): actor line" PASS "actor: synthetic-persona" "#1582"
else
  record "study show (human): actor line" FAIL "'$(grep -m1 '^actor' "$work/logs/show-human.out")'; see logs/show-human.out" "#1582"
fi

# The library rows install the package in their own folder, as a consumer would.
lib=$work/lib
mkdir -p "$lib"
printf '{ "name": "packed-check-lib", "private": true, "type": "module" }\n' >"$lib/package.json"
(cd "$lib" && timeout 600 "${run_env[@]}" npm install --no-audit --no-fund "$spec") >"$work/logs/lib-install.log" 2>&1

# 20ac. For each init starter, the config `study show --json` prints reads back through parseStudy
# to the same config (#1581). 0.110.4's printed config was refused ("`actors:` is the
# humanish.lab.v2 spelling").
cat >"$lib/roundtrip.mjs" <<'JS'
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseStudy } from "humanish";
const out = [];
for (const file of process.argv.slice(2)) {
  const shown = JSON.parse(readFileSync(file, "utf8"));
  const parsed = parseStudy(structuredClone(shown.config));
  const verdict = parsed.ok ? (isDeepStrictEqual(parsed.config, shown.config) ? "same" : "differs") : `refused ${parsed.error.code}`;
  out.push(`${basename(file, ".json")}:${verdict}`);
}
console.log(out.join(","));
JS
shows=()
for id in first-run try-live local-browser cua-browser; do
  hx study show "$id" --json >"$work/logs/roundtrip-$id.json" 2>"$work/logs/roundtrip-$id.err"
  shows+=("$work/logs/roundtrip-$id.json")
done
roundtrip=$(cd "$lib" && timeout 120 "${run_env[@]}" node roundtrip.mjs "${shows[@]}" 2>"$work/logs/roundtrip.err")
if [ "$roundtrip" = "roundtrip-first-run:same,roundtrip-try-live:same,roundtrip-local-browser:same,roundtrip-cua-browser:same" ]; then
  record "study show --json reads back through parseStudy, 4 starters" PASS "each config deep-equals its parse" "#1581"
else
  record "study show --json reads back through parseStudy, 4 starters" FAIL "'${roundtrip}'; see logs/roundtrip*" "#1581"
fi

# 20ad. runStudy refuses a config built without parseStudy that still sets a 0.110 field, has no
# actor, or declares a route its subject and actor do not take, before anything runs (#1582). A
# budget in execution.caps is refused, so it cannot run uncapped. The control is the same config
# with its budget in `caps`, which runs. 0.110.4 reads `actors[0]`, so these v3-shaped configs
# threw or ran there.
cat >"$lib/refusals.mjs" <<'JS'
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runStudy } from "humanish";
const base = {
  schema: "humanish.study.v3",
  id: "lib-refusal",
  route: "computer-use",
  mode: "dry-run",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use", mission: "Open the page and stop." },
  participants: 2,
  execution: { target: "e2b-desktop" },
};
const { actor, ...noActor } = base;
const cases = {
  "execution.caps": { ...base, execution: { ...base.execution, caps: { maxUsd: 0.5 } } },
  actors: { ...noActor, actors: [actor] },
  "actor.count": { ...base, actor: { ...actor, count: 2 } },
  "no actor": noActor,
  "wrong route": { ...base, route: "scripted" },
  "caps control": { ...base, caps: { maxUsd: 0.5 } },
};
const runDirs = (cwd) => {
  try {
    return readdirSync(join(cwd, ".humanish/runs"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
};
const out = [];
for (const [name, config] of Object.entries(cases)) {
  const cwd = mkdtempSync(join(process.cwd(), "case-"));
  try {
    const { result } = await runStudy(config, { cwd, dryRun: true, runId: "lib-refusal" });
    out.push(`${name}:${result.ok ? "ok" : result.error?.code}:${runDirs(cwd)}`);
  } catch (error) {
    out.push(`${name}:threw ${error instanceof Error ? error.message.slice(0, 60) : String(error)}:${runDirs(cwd)}`);
  }
}
console.log(out.join(","));
JS
refusals=$(cd "$lib" && timeout 300 "${run_env[@]}" node refusals.mjs 2>"$work/logs/refusals.err")
echo "$refusals" >"$work/logs/refusals.out"
expected="execution.caps:HUMANISH_STUDY_V2_UNSUPPORTED:0,actors:HUMANISH_STUDY_V2_UNSUPPORTED:0,actor.count:HUMANISH_STUDY_V2_UNSUPPORTED:0,no actor:HUMANISH_STUDY_INVALID:0,wrong route:HUMANISH_STUDY_INVALID:0,caps control:ok:1"
if [ "$refusals" = "$expected" ]; then
  record "runStudy refuses 0.110 fields, no actor, a wrong route; caps control runs" PASS "5 refusals before a run directory; the control runs" "#1582"
else
  record "runStudy refuses 0.110 fields, no actor, a wrong route; caps control runs" FAIL "'${refusals}'; see logs/refusals.*" "#1582"
fi

# 20ae. study check --json names a participant's own target `participants[<i>].target`, with kind
# `participants[].target` (#1582). 0.110.4 said `actors[0].lanes[<i>].target`.
mkdir -p "$project/.humanish/studies"
cat >"$project/.humanish/studies/target-roster.yaml" <<'YAML'
schema: humanish.study.v3
id: target-roster
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
execution:
  target: e2b-desktop
actor:
  type: openai-computer-use
participants:
  - id: reviewer
    target: https://reviewer-preview.example.test/work
  - id: operator
    target: https://operator-preview.example.test/work
policies:
  allowPublicTargets: true
YAML
hx study check target-roster --json >"$work/logs/target-roster.json" 2>"$work/logs/target-roster.err"
targets=$(json_field "$work/logs/target-roster.json" '(d.targets || []).filter((t) => !t.kind.startsWith("subject")).map((t) => t.kind + " " + t.label).join(",")')
if [ "$targets" = "participants[].target participants[0].target,participants[].target participants[1].target" ]; then
  record "study check --json: participant target kind and labels" PASS "participants[].target, participants[0].target and [1]" "#1582"
else
  record "study check --json: participant target kind and labels" FAIL "'${targets}'; see logs/target-roster.*" "#1582"
fi

# 20af-20aj: 0.111.1 (#1594, #1595, #1597, #1602).

# The E2B app host these rows use, `3000-<20 letters and digits>.e2b.app`, is drawn here, so no
# file holds one. It names no sandbox that exists.
e2b_sid=$(node -e 'const c="abcdefghijklmnopqrstuvwxyz0123456789";let s="";for(const b of require("node:crypto").randomBytes(20))s+=c[b%36];process.stdout.write(s)')
e2b_host="3000-$e2b_sid.$(printf e2b).app"
e2b_url="https://$e2b_host/home"
urlenc() { node -p 'encodeURIComponent(process.argv[1])' "$1"; }

# 20af. A study URL may carry an E2B app URL in a parameter (#1602): `study check` passes it
# percent-encoded in `origin=` and as written in `return=`. The same URL with a user name and
# password before its own host, or before the nested E2B host, is refused with
# HUMANISH_STUDY_INVALID, the password not echoed. 0.111.0 refused all four as a credential.
write_url_study url-e2b-param "https://example.com/signin?origin=$(urlenc "$e2b_url")"
write_url_study url-e2b-raw "https://example.com/signin?return=$e2b_url"
write_url_study url-e2b-userinfo "https://verify-user:$url_pass@example.com/signin?origin=$(urlenc "$e2b_url")"
write_url_study url-e2b-nested "https://example.com/signin?origin=$(urlenc "https://verify-user:$url_pass@$e2b_host/home")"
e2b_rows=""
for id in url-e2b-param url-e2b-raw url-e2b-userinfo url-e2b-nested; do
  hx study check "$id" --json >"$work/logs/$id.json" 2>"$work/logs/$id.err"
  url_exit=$?
  url_view=$(json_field "$work/logs/$id.json" '[d.ok, d.error ? d.error.code : "-"].join(" ")')
  leaked=$(cat "$work/logs/$id.json" "$work/logs/$id.err" | grep -cF -e "$url_pass")
  e2b_rows="$e2b_rows $id=$url_exit/$url_view/leaked:$leaked;"
done
rm -f "$project/humanish/studies/url-e2b-param.yaml" "$project/humanish/studies/url-e2b-raw.yaml" \
  "$project/humanish/studies/url-e2b-userinfo.yaml" "$project/humanish/studies/url-e2b-nested.yaml"
if [ "$e2b_rows" = " url-e2b-param=0/true -/leaked:0; url-e2b-raw=0/true -/leaked:0; url-e2b-userinfo=2/false HUMANISH_STUDY_INVALID/leaked:0; url-e2b-nested=2/false HUMANISH_STUDY_INVALID/leaked:0;" ]; then
  record "study check: E2B app URL in a parameter passes, user info refused" PASS "origin= and return= exit 0; user info outer and nested exit 2, password not echoed" "#1602"
else
  record "study check: E2B app URL in a parameter passes, user info refused" FAIL "${e2b_rows}; see logs/url-e2b-*" "#1602"
fi

# 20ag. verify finds an E2B URL hex-encoded after `state=` in a run file (#1602). 0.111.0's
# quoted-printable pass read `=68` as one byte and graded the run share_ready.
hx run first-run --run-id verify-hex --no-open --json >"$work/logs/verify-hex-run.json" 2>&1
e2b_hex=$(node -p 'Buffer.from(process.argv[1]).toString("hex")' "$e2b_url")
printf '\nThe sign-in page returned to /callback?state=%s after login.\n' "$e2b_hex" >>"$project/.humanish/runs/verify-hex/review.md"
hx verify --run verify-hex --json >"$work/logs/verify-hex.json" 2>"$work/logs/verify-hex.err"
hex_exit=$?
hex_view=$(json_field "$work/logs/verify-hex.json" '[d.shareSafety && d.shareSafety.status, (d.shareSafety && d.shareSafety.reasons || []).some((r) => r.code === "PUBLIC_SAFETY_FINDINGS")].join(" ")')
if [ "$hex_exit" = 2 ] && [ "$hex_view" = "blocked true" ] && ! grep -qF "$e2b_hex" "$work/logs/verify-hex.json"; then
  record "verify blocks a hex-encoded E2B URL after state=" PASS "exit 2, blocked, PUBLIC_SAFETY_FINDINGS; value not echoed" "#1602"
else
  record "verify blocks a hex-encoded E2B URL after state=" FAIL "exit $hex_exit, '${hex_view}'; see logs/verify-hex.json" "#1602"
fi

# 20ah. A dry run of a computer-use study with two participants on an E2B app host verifies
# share_ready, and no run file holds the host: the review summary names it `[target-url:<digest>]`
# (#1597). 0.111.0 wrote the raw URL into run.json, review.json and review.md, and verify blocked it.
cat >"$project/humanish/studies/fanout-e2b.yaml" <<YAML
schema: humanish.study.v3
id: fanout-e2b
title: Fan-out dry run on an E2B app URL
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: "https://$e2b_host/"
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: Open the page and stop.
participants:
  - id: newcomer
    target: https://$e2b_host/sign-up
  - id: returning
    target: https://$e2b_host/sign-in
execution:
  target: e2b-desktop
  timeoutMs: 600000
policies:
  allowPublicTargets: true
YAML
hx run fanout-e2b --run-id fanout-e2b --no-open --json >"$work/logs/fanout-e2b-run.json" 2>"$work/logs/fanout-e2b-run.err"
fanout_exit=$?
hx verify --run fanout-e2b --json >"$work/logs/fanout-e2b-verify.json" 2>"$work/logs/fanout-e2b-verify.err"
fanout_verify=$?
fanout_share=$(json_field "$work/logs/fanout-e2b-verify.json" 'd.shareSafety && d.shareSafety.status')
fanout_holding=$(grep -rlF -- "$e2b_sid" "$project/.humanish/runs/fanout-e2b" 2>/dev/null | wc -l | tr -d ' ')
fanout_label=$(json_field "$project/.humanish/runs/fanout-e2b/run.json" '/\[target-url:[0-9a-f]{16}\]/.test(d.review && d.review.summary)')
rm -f "$project/humanish/studies/fanout-e2b.yaml"
if [ "$fanout_exit" = 0 ] && [ "$fanout_verify" = 0 ] && [ "$fanout_share" = share_ready ] && [ "$fanout_holding" = 0 ] && [ "$fanout_label" = true ]; then
  record "fan-out dry run on an E2B app URL: share_ready, no host in run files" PASS "verify exit 0, share_ready; 0 files hold the host; summary names [target-url:<digest>]" "#1597"
else
  record "fan-out dry run on an E2B app URL: share_ready, no host in run files" FAIL "run exit $fanout_exit, verify exit $fanout_verify, '${fanout_share}', $fanout_holding files hold the host, label '${fanout_label}'; see logs/fanout-e2b-*" "#1597"
fi

# 20ai. execution.egressAllow on the computer-use route warns at `study check` and at `run`, and
# the run records the warning as a study.warning event in run.json (#1595). 0.111.0 said nothing.
cat >"$project/humanish/studies/egress-allow.yaml" <<'YAML'
schema: humanish.study.v3
id: egress-allow
title: egressAllow on computer use
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: https://example.com/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: Open the page and stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
  egressAllow:
    - example.com
policies:
  allowPublicTargets: true
YAML
egress_text='`execution.egressAllow` is ignored on route: computer-use'
hx study check egress-allow >"$work/logs/egress-check.out" 2>"$work/logs/egress-check.err"
egress_check_exit=$?
egress_check=$(cat "$work/logs/egress-check.out" "$work/logs/egress-check.err" | grep -cF "$egress_text")
hx run egress-allow --run-id egress-allow --no-open --json >"$work/logs/egress-run.json" 2>"$work/logs/egress-run.err"
egress_run_exit=$?
egress_stderr=$(grep -cF "$egress_text" "$work/logs/egress-run.err")
egress_event=$(json_field "$project/.humanish/runs/egress-allow/run.json" '(d.events || []).filter((e) => e.type === "study.warning" && e.message.includes("the first minor release on or after 2026-11-04 refuses it")).length')
rm -f "$project/humanish/studies/egress-allow.yaml"
if [ "$egress_check_exit" = 0 ] && [ "$egress_check" = 1 ] && [ "$egress_run_exit" = 0 ] && [ "$egress_stderr" = 1 ] && [ "$egress_event" = 1 ]; then
  record "egressAllow on computer use: warning at check and run, study.warning event" PASS "1 warning line each; run.json has 1 study.warning naming 2026-11-04" "#1595"
else
  record "egressAllow on computer use: warning at check and run, study.warning event" FAIL "check exit $egress_check_exit with $egress_check lines; run exit $egress_run_exit with $egress_stderr lines; events '${egress_event}'; see logs/egress-*" "#1595"
fi

# 20aj. doctor reads the placeholder a terminal study's sandbox gets in CODEX_API_KEY as no key
# (#1594). 0.111.0 printed "ok key CODEX_API_KEY: supplied by process env".
(cd "$project" && timeout 600 "${run_env[@]}" CODEX_API_KEY=humanish-egress-auth-placeholder npx -y --package "$spec" humanish doctor) >"$work/logs/doctor-placeholder.out" 2>"$work/logs/doctor-placeholder.err"
placeholder_exit=$?
placeholder_row=$(grep -m1 "key CODEX_API_KEY:" "$work/logs/doctor-placeholder.out")
case "$placeholder_row" in
  "- note key CODEX_API_KEY: not a key: CODEX_API_KEY holds the placeholder humanish sets in a terminal study's sandbox"*)
    record "doctor: the egress placeholder is no key" PASS "exit $placeholder_exit; note: not a key, the sandbox placeholder" "#1594" ;;
  *) record "doctor: the egress placeholder is no key" FAIL "exit $placeholder_exit; '${placeholder_row:0:90}'; see logs/doctor-placeholder.out" "#1594" ;;
esac

# 20ak. The Observer page check 4's dry run wrote inlines the Observer app. It carries the
# stopped-server notice (#1601) and the focus view's heading-line navigation, `player-navigation`
# (#1600). 0.111.1's page has neither. This reads the page source; no browser opens it here.
obs_page="$run_dir/observer/index.html"
obs_notice=$(grep -c 'The Observer server stopped answering' "$obs_page" 2>/dev/null)
obs_nav=$(grep -c 'player-navigation' "$obs_page" 2>/dev/null)
if [ "${obs_notice:-0}" -ge 1 ] && [ "${obs_nav:-0}" -ge 1 ]; then
  record "dry run's Observer page: stopped-server notice and heading-line navigation" PASS "notice heading and player-navigation present" "#1600, #1601"
else
  record "dry run's Observer page: stopped-server notice and heading-line navigation" FAIL "notice heading lines ${obs_notice:-0}, player-navigation lines ${obs_nav:-0}; see the run's observer/index.html" "#1600, #1601"
fi

# 20al-20an: 0.111.3 (#1616, #1617). The feedback candidates (#1622, #1624), the scripted E2B key
# scrub (#1615) and the subject sandbox warnings (#1621) need a live participant or a subject
# sandbox, which this check does not create.

# 20al. A shared-world dry run with caps.maxUsd and no caps.maxTotalUsd warns that the cap applies to
# each participant's model spend (#1617): one `warning:` line on stdout and one entry in the
# `--json` warnings. The same study with caps.maxTotalUsd gives none. 0.111.2 gave none for either.
write_sw_cap() { # id, extra caps line
  cat >"$project/humanish/studies/$1.yaml" <<YAML
schema: humanish.study.v3
id: $1
title: Shared-world dry run with a per-participant cap
route: shared-world
mode: dry-run
subject:
  source: clone
  exposure: synthetic
  repos:
    - example-org/collab-notes-app
  serve:
    start: HOST=0.0.0.0 PORT=3000 python3 server.py
    url: http://127.0.0.1:3000/
  state:
    checkpoint:
      - name: task-count
        command: python3 checkpoint.py
actor:
  type: openai-computer-use
  mission: Add one task, then stop.
participants:
  - id: persona-a
    persona: weekly-planner
    device: desktop
    instruction: Add one task, then stop.
  - id: persona-b
    persona: ops-coordinator
    device: desktop
    instruction: Add one task, then stop.
caps:
  maxUsd: 1
$2
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
}
write_sw_cap sw-cap ""
write_sw_cap sw-cap-total "  maxTotalUsd: 2"
cap_text="caps.maxUsd (\$1) caps each participant's model spend, so 2 participants may spend up to 2 × \$1"
hx run sw-cap --no-open >"$work/logs/sw-cap-run.out" 2>"$work/logs/sw-cap-run.err"
cap_exit=$?
cap_lines=$(grep -cF "warning: $cap_text" "$work/logs/sw-cap-run.out")
hx run sw-cap --no-open --json >"$work/logs/sw-cap-run.json" 2>"$work/logs/sw-cap-run-json.err"
cap_json=$(json_field "$work/logs/sw-cap-run.json" '(d.warnings || []).filter((w) => String(w).startsWith("caps.maxUsd ($1) caps each participant") && String(w).includes("model spend")).length')
hx run sw-cap-total --no-open --json >"$work/logs/sw-cap-total.json" 2>"$work/logs/sw-cap-total.err"
cap_total_exit=$?
cap_total=$(json_field "$work/logs/sw-cap-total.json" '(d.warnings || []).filter((w) => String(w).includes("caps.maxUsd")).length')
rm -f "$project/humanish/studies/sw-cap.yaml" "$project/humanish/studies/sw-cap-total.yaml"
if [ "$cap_exit" = 0 ] && [ "$cap_lines" = 1 ] && [ "$cap_json" = 1 ] && [ "$cap_total_exit" = 0 ] && [ "$cap_total" = 0 ]; then
  record "shared-world caps.maxUsd without maxTotalUsd warns per participant" PASS "1 stdout line, 1 --json warning; with maxTotalUsd 0" "#1617"
else
  record "shared-world caps.maxUsd without maxTotalUsd warns per participant" FAIL "exit $cap_exit, $cap_lines stdout lines, '${cap_json}' --json warnings; with maxTotalUsd exit $cap_total_exit, '${cap_total}'; see logs/sw-cap-*" "#1617"
fi

# 20am. A live scripted clone study whose environment lacks a subject.env value is refused with the
# message computer use and shared world give (#1616): it names the variable and says to pass it
# with --dotenv. The E2B key is synthetic; the refusal comes before any sandbox. 0.111.2 said
# "Subject env values missing for a live clone scripted-browser study: VERIFY_SUBJECT_TOKEN."
cat >"$project/humanish/studies/scripted-subject-env.yaml" <<'YAML'
schema: humanish.study.v3
id: scripted-subject-env
title: Scripted clone with an unset subject env value
route: scripted
mode: live
subject:
  source: clone
  exposure: synthetic
  repos:
    - example-org/collab-notes-app
  env:
    - VERIFY_SUBJECT_TOKEN
  serve:
    start: python3 -m http.server 3000 --bind 0.0.0.0
    url: http://127.0.0.1:3000/
  state:
    seed:
      - name: no-server-state
        command: "true"
        when: before-start
actor:
  type: scripted-browser
  persona: synthetic-new-user
scenario: verify-signup
execution:
  target: e2b-desktop
  timeoutMs: 300000
review:
  analysis: false
YAML
(cd "$project" && timeout 600 "${run_env[@]}" "E2B_API_KEY=$synthetic_e2b_prefixed" npx -y --package "$spec" humanish run scripted-subject-env --no-open --json) >"$work/logs/scripted-subject-env.json" 2>"$work/logs/scripted-subject-env.err"
senv_exit=$?
senv_view=$(json_field "$work/logs/scripted-subject-env.json" '[d.error && d.error.code, d.error && d.error.message].join(" | ")')
rm -f "$project/humanish/studies/scripted-subject-env.yaml"
if [ "$senv_exit" = 2 ] && [ "$senv_view" = "HUMANISH_SCRIPTED_SUBJECT_ENV_MISSING | subject.env declares VERIFY_SUBJECT_TOKEN but the environment does not provide it (pass via --dotenv; values are never persisted)." ]; then
  record "scripted clone: unset subject.env refused with the shared wording" PASS "exit 2, HUMANISH_SCRIPTED_SUBJECT_ENV_MISSING, names the variable and --dotenv" "#1616"
else
  record "scripted clone: unset subject.env refused with the shared wording" FAIL "exit $senv_exit, '${senv_view:0:160}'; see logs/scripted-subject-env.json" "#1616"
fi

# 20an. A keyless live shared-world study on the provisioned plane names a signed-in coding agent and
# suggests actor.type: local-agent (#1616); one on the external-public plane does not, since its
# lobby-code reader needs OPENAI_API_KEY anyway. A stand-in `claude` on PATH reports 2.1.290 and a
# login; the temp HOME has no Codex login. 0.111.2 suggested nothing on either plane.
mkdir -p "$work/fake-claude-current"
cat >"$work/fake-claude-current/claude" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo "2.1.290 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0 ;;
esac
echo "stand-in claude: unexpected $*" >&2
exit 3
SH
chmod +x "$work/fake-claude-current/claude"
cat >"$project/humanish/studies/keys-provisioned.yaml" <<'YAML'
schema: humanish.study.v3
id: keys-provisioned
title: Keyless provisioned shared world
route: shared-world
mode: live
subject:
  source: clone
  exposure: synthetic
  repos:
    - example-org/collab-notes-app
  serve:
    start: HOST=0.0.0.0 PORT=3000 python3 server.py
    url: http://127.0.0.1:3000/
  state:
    checkpoint:
      - name: task-count
        command: python3 checkpoint.py
actor:
  type: openai-computer-use
  mission: Add one task, then stop.
participants:
  - id: persona-a
    persona: weekly-planner
    device: desktop
    instruction: Add one task, then stop.
  - id: persona-b
    persona: ops-coordinator
    device: desktop
    instruction: Add one task, then stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
cat >"$project/humanish/studies/keys-external.yaml" <<'YAML'
schema: humanish.study.v3
id: keys-external
title: Keyless external-public shared world
route: shared-world
mode: live
subject:
  source: app-url
  appUrl: https://lobby-trivia.example.test/
  publicTarget:
    owner: your-org/your-app
    authorized: true
policies:
  allowPublicTargets: true
actor:
  type: openai-computer-use
  mission: Play one round of the trivia game with your friends, then stop.
participants:
  - id: host
    host: true
    device: mobile
    persona: party-host
    instruction: Create a lobby and start the game once your friend joins.
  - id: friend
    device: mobile
    persona: casual-friend
    instruction: Join the lobby your friend created and play one round.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
suggest_rows=""
for study in keys-provisioned keys-external; do
  (cd "$project" && timeout 600 "${run_env[@]}" "PATH=$work/fake-claude-current:$user_path" npx -y --package "$spec" humanish run "$study" --no-open --json) >"$work/logs/$study.json" 2>"$work/logs/$study.err"
  suggest_rows="$suggest_rows $study=$?/$(json_field "$work/logs/$study.json" '[d.error && d.error.code, /Claude Code reports authenticated on this machine\. Set actor\.type: local-agent to use it instead of a key\.$/.test(d.error && d.error.message), /local-agent/.test(d.error && d.error.message)].join(",")')"
done
rm -f "$project/humanish/studies/keys-provisioned.yaml" "$project/humanish/studies/keys-external.yaml"
if [ "$suggest_rows" = " keys-provisioned=2/HUMANISH_SHARED_WORLD_KEYS_MISSING,true,true keys-external=2/HUMANISH_SHARED_WORLD_KEYS_MISSING,false,false" ]; then
  record "keyless shared world: local-agent suggestion on the provisioned plane only" PASS "provisioned names Claude Code and actor.type: local-agent; external-public suggests nothing" "#1616"
else
  record "keyless shared world: local-agent suggestion on the provisioned plane only" FAIL "${suggest_rows}; see logs/keys-*.json" "#1616"
fi

# 20ao-20ar: 0.111.4 (#1626, #1627). The encoded-form scrub on the computer-use, shared-world and
# terminal routes needs a live participant or agent, which this check does not start.

# 20ao. review on check 4's dry run names the command that starts a live run (#1626): the findings
# line ends "the next command runs try-live live.", a `next:` line follows, and `analysis.next` in
# --json holds that command. init wrote try-live with mode: live, so the command runs try-live. Under
# `npx --package <spec>` the command reads `npx humanish@<version> run try-live`.
# 0.111.3 printed no `next:` line and `analysis.next` was null.
next_findings="findings: none. This is a dry run: no participant used the product, so there is nothing to analyze. Findings come from live runs: the next command runs try-live live."
hx review --run "$run_id" >"$work/logs/review-next.out" 2>"$work/logs/review-next.err"
next_exit=$?
hx review --run "$run_id" --json >"$work/logs/review-next.json" 2>"$work/logs/review-next-json.err"
next_json=$(json_field "$work/logs/review-next.json" 'd.analysis && d.analysis.next')
next_line=$(grep '^next: ' "$work/logs/review-next.out" | head -n 1)
case "$next_exit,$next_json,$next_line" in
  "0,"*humanish*" run try-live,next: "*humanish*" run try-live")
    if grep -qxF "$next_findings" "$work/logs/review-next.out" && [ "${next_line#next: }" = "$next_json" ]; then
      record "review of a dry run names the live command" PASS "analysis.next '$next_json'; the same on the next: line" "#1626"
    else
      record "review of a dry run names the live command" FAIL "next '$next_json', but the findings line or the next: line differs; see logs/review-next.out" "#1626"
    fi ;;
  *) record "review of a dry run names the live command" FAIL "exit $next_exit, analysis.next '${next_json}', line '${next_line}'; see logs/review-next.*" "#1626" ;;
esac

# 20ap. A keyless live computer-use run on a machine where Codex and Claude Code both report a
# sign-in says "report" (#1626). Stand-ins for both are first on PATH: `codex login status` prints
# "Logged in using ChatGPT", and `claude` reports 2.1.290 and a login. 0.111.3 said "reports".
mkdir -p "$work/fake-two-agents"
cat >"$work/fake-two-agents/claude" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo "2.1.290 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0 ;;
esac
echo "stand-in claude: unexpected $*" >&2
exit 3
SH
cat >"$work/fake-two-agents/codex" <<'SH'
#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
if [ "$1" = "--version" ]; then echo "codex-cli 0.159.3"; exit 0; fi
echo "stand-in codex: unexpected $*" >&2
exit 3
SH
chmod +x "$work/fake-two-agents/claude" "$work/fake-two-agents/codex"
(cd "$project" && timeout 600 "${run_env[@]}" "PATH=$work/fake-two-agents:$user_path" npx -y --package "$spec" humanish run try-live --no-open --json) >"$work/logs/two-agents.json" 2>"$work/logs/two-agents.err"
two_exit=$?
two_view=$(json_field "$work/logs/two-agents.json" '[d.error && d.error.code, /Codex and Claude Code report authenticated on this machine\. Set actor\.type: local-agent to use one instead of a key\.$/.test(d.error && d.error.message), /reports authenticated/.test(d.error && d.error.message)].join(",")')
if [ "$two_exit" = 2 ] && [ "$two_view" = "HUMANISH_COMPUTER_USE_KEYS_MISSING,true,false" ]; then
  record "two signed-in agents: \"Codex and Claude Code report authenticated\"" PASS "exit 2, HUMANISH_COMPUTER_USE_KEYS_MISSING, plural verb" "#1626"
else
  record "two signed-in agents: \"Codex and Claude Code report authenticated\"" FAIL "exit $two_exit, '${two_view}'; see logs/two-agents.json" "#1626"
fi

# 20aq. A keyless live terminal study that leaves execution.runtimeAuth unset is refused with a
# message that names both keys and the default runtime auth (#1626). 0.111.3 read
# `declare runtimeAuth "undefined"`. Code and exit status are unchanged.
cat >"$project/humanish/studies/refuse-terminal-auth.yaml" <<'YAML'
schema: humanish.study.v3
id: refuse-terminal-auth
title: Live terminal study with no key and no runtimeAuth
route: terminal
mode: live
subject:
  source: terminal-product
  product:
    name: widgetsmith-cli
    publicSurfaces:
      - https://example.com/widgetsmith
actor:
  type: codex-exec
  persona: autonomous-creative-agent
  mission: Find widgetsmith-cli from its public page and say what it does.
caps:
  maxUsd: 0
  maxJobs: 0
  maxMinutes: 10
YAML
auth_want="Live terminal-product studies need CODEX_API_KEY or OPENAI_API_KEY in the environment, and neither is set. \`execution.runtimeAuth\` is unset, so the default openai-egress keeps the key outside the sandbox in an E2B header transform. Pass one with --dotenv; the value is never persisted."
hx run refuse-terminal-auth --no-open --json >"$work/logs/terminal-auth.json" 2>"$work/logs/terminal-auth.err"
auth_exit=$?
hx run refuse-terminal-auth --no-open >"$work/logs/terminal-auth.out" 2>"$work/logs/terminal-auth-text.err"
auth_code=$(json_field "$work/logs/terminal-auth.json" 'd.error && d.error.code')
auth_message=$(json_field "$work/logs/terminal-auth.json" 'd.error && d.error.message')
rm -f "$project/humanish/studies/refuse-terminal-auth.yaml"
if [ "$auth_exit" = 2 ] && [ "$auth_code" = HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING ] && [ "$auth_message" = "$auth_want" ] &&
  grep -qxF "humanish run failed: $auth_want" "$work/logs/terminal-auth-text.err" &&
  ! grep -qF undefined "$work/logs/terminal-auth.json" "$work/logs/terminal-auth-text.err"; then
  record "keyless terminal refusal names the default runtime auth" PASS "exit 2, HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING, no \"undefined\"" "#1626"
else
  record "keyless terminal refusal names the default runtime auth" FAIL "exit $auth_exit, code '${auth_code}', message '${auth_message:0:80}'; see logs/terminal-auth.*" "#1626"
fi

# 20ar. A scripted run scrubs a known value from its step trace, scenario title, goal and step labels,
# also in encoded forms (#1627). E2B_API_KEY holds a synthetic value with a space, quotes, a slash,
# an @ and an é. A local scripted run against a loopback page (Chrome on PATH, no model, no
# sandbox) opens a goto path that holds it, so the browser reports it percent-encoded, and the
# scenario's title, goal and second step's label quote it. Every file of the run directory and the
# command's output are read for the value as written, percent-encoded (encodeURIComponent and
# encodeURI), JSON-escaped (also with \u escapes, and twice) and base64 or base64url. 0.111.3 kept it
# in traces/desktop.json, actor-desktop.json, run.json, review.*, events.ndjson and the Observer.
scrub_value='verify01114 "syn/tok@en" é7Zp'
cat >"$work/scrub-app.mjs" <<'JS'
import { createServer } from "node:http";
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settings</title></head>
<body><main><h1>Settings</h1><p>Synthetic settings page.</p></main></body></html>`;
const server = createServer((_q, r) => {
  r.setHeader("content-type", "text/html; charset=utf-8");
  r.end(page);
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
JS
timeout 300 node "$work/scrub-app.mjs" >"$work/logs/scrub-app.port" 2>&1 &
scrub_pid=$!
for _ in $(seq 1 50); do
  [ -s "$work/logs/scrub-app.port" ] && break
  sleep 0.1
done
scrub_port=$(head -n 1 "$work/logs/scrub-app.port")
cat >"$project/humanish/scenarios/verify-scrub.yaml" <<'YAML'
schema: humanish.scenario.v1
id: verify-scrub
title: 'Scrub verify01114 "syn/tok@en" é7Zp'
goal: 'Open the settings page for verify01114 "syn/tok@en" é7Zp.'
browser:
  startPath: /
  steps:
    - id: step-01-load
      label: Load the page
      action: goto
      path: /
      expect:
        selectorVisible: "main"
    - id: step-02-settings
      label: 'Open the settings page for verify01114 "syn/tok@en" é7Zp'
      action: goto
      path: '/settings/verify01114 "syn/tok@en" é7Zp/'
      expect:
        selectorVisible: "main"
YAML
cat >"$project/humanish/studies/scripted-scrub.yaml" <<YAML
schema: humanish.study.v3
id: scripted-scrub
title: Scripted run with a known value in its trace
route: scripted
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:$scrub_port
actor:
  type: scripted-browser
  persona: synthetic-new-user
scenario: verify-scrub
execution:
  target: local
  timeoutMs: 120000
review:
  analysis: false
YAML
(cd "$project" && timeout 600 "${run_env[@]}" "E2B_API_KEY=$scrub_value" npx -y --package "$spec" humanish run scripted-scrub --no-open --json) >"$work/logs/scripted-scrub.json" 2>"$work/logs/scripted-scrub.err"
scrub_exit=$?
kill "$scrub_pid" 2>/dev/null
wait "$scrub_pid" 2>/dev/null
rm -f "$project/humanish/studies/scripted-scrub.yaml" "$project/humanish/scenarios/verify-scrub.yaml"
scrub_run=$(json_field "$work/logs/scripted-scrub.json" 'd.runId')
scrub_steps=$(json_field "$project/.humanish/runs/$scrub_run/traces/desktop.json" '(d.steps || []).filter((s) => s.status === "passed").length')
scrub_hits=$(node -e '
const fs = require("fs"), path = require("path");
const [value, ...roots] = process.argv.slice(1);
const bytes = Buffer.from(value, "utf8");
const json = JSON.stringify(value).slice(1, -1);
const forms = {
  raw: [value],
  percent: [encodeURIComponent(value), encodeURI(value)],
  json: [json, json.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")), JSON.stringify(json).slice(1, -1)],
  base64: [bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url")],
};
const files = [];
const walk = (p) => { const s = fs.statSync(p); if (s.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); else files.push(p); };
for (const r of roots) if (fs.existsSync(r)) walk(r);
const out = [];
for (const [name, list] of Object.entries(forms)) {
  const hit = files.filter((f) => { const d = fs.readFileSync(f); return list.some((x) => d.includes(Buffer.from(x, "utf8"))); });
  if (hit.length) out.push(name + ":" + hit.map((f) => path.basename(f)).join("+"));
}
process.stdout.write(out.join(" "));
' "$scrub_value" "$project/.humanish/runs/$scrub_run" "$work/logs/scripted-scrub.json" "$work/logs/scripted-scrub.err")
if [ "$scrub_exit" = 0 ] && [ -n "$scrub_run" ] && [ "$scrub_steps" = 2 ] && [ -z "$scrub_hits" ]; then
  record "scripted trace, title, goal and labels: known value scrubbed in four forms" PASS "2/2 steps; 0 files hold the value as written, percent-encoded, JSON-escaped or base64" "#1627"
else
  record "scripted trace, title, goal and labels: known value scrubbed in four forms" FAIL "exit $scrub_exit, run '${scrub_run}', steps passed '${scrub_steps}', hits '${scrub_hits:0:300}'; see logs/scripted-scrub.*" "#1627"
fi

# 20as-20au: 0.112.0 (#1640, #1642, #1644). The analysis headlines and design findings (#1643) need
# a live run with analysis, which this check does not make.

# 20as. A terminal dry run records the resolved DO_NOT_TRACK setting in its runtime declaration
# (#1642): true by default, false when the study sets `execution.terminal.doNotTrack: false`, and a
# quoted value is refused at parse. 0.111.4 recorded no setting and refused the field as unknown.
for dnt in default false quoted; do
  case "$dnt" in
    default) dnt_line="" ;;
    false) dnt_line="    doNotTrack: false" ;;
    quoted) dnt_line='    doNotTrack: "false"' ;;
  esac
  cat >"$project/humanish/studies/dnt-$dnt.yaml" <<YAML
schema: humanish.study.v3
id: dnt-$dnt
title: Terminal dry run, doNotTrack $dnt
route: terminal
mode: dry-run
subject:
  source: terminal-product
  product:
    name: widgetsmith-cli
    publicSurfaces:
      - https://example.com/widgetsmith
actor:
  type: codex-exec
  persona: autonomous-creative-agent
  mission: Discover the CLI and stop.
caps:
  maxUsd: 0
  maxJobs: 0
  maxMinutes: 7
execution:
  terminal:
    transport: exec-stream
    stdin: disabled
$dnt_line
YAML
  hx run "dnt-$dnt" --run-id "dnt-$dnt" --no-open --json >"$work/logs/dnt-$dnt.json" 2>"$work/logs/dnt-$dnt.err"
  eval "dnt_exit_$dnt=\$?"
  rm -f "$project/humanish/studies/dnt-$dnt.yaml"
done
dnt_of() { # run id: the doNotTrack values the run's runtime declaration records
  json_field "$project/.humanish/runs/$1/run.json" '(d.events || []).map((e) => typeof e.message === "string" && /"doNotTrack":(true|false)/.exec(e.message)).filter(Boolean).map((m) => m[1]).join(",")'
}
dnt_default=$(dnt_of dnt-default)
dnt_false=$(dnt_of dnt-false)
dnt_quoted=$(json_field "$work/logs/dnt-quoted.json" '[d.error && d.error.code, d.error && d.error.message].join(" ")')
dnt_want_quoted='HUMANISH_STUDY_INVALID `execution.terminal.doNotTrack` must be true or false (unquoted).'
if [ "$dnt_exit_default" = 0 ] && [ "$dnt_default" = true ] && [ "$dnt_exit_false" = 0 ] && [ "$dnt_false" = false ] &&
  [ "$dnt_exit_quoted" = 2 ] && [ "$dnt_quoted" = "$dnt_want_quoted" ]; then
  record "terminal dry run records doNotTrack (default true, false, quoted refused)" PASS "true; false; exit 2 HUMANISH_STUDY_INVALID" "#1642"
else
  record "terminal dry run records doNotTrack (default true, false, quoted refused)" FAIL "default exit $dnt_exit_default '${dnt_default}'; false exit $dnt_exit_false '${dnt_false}'; quoted exit $dnt_exit_quoted '${dnt_quoted}'; see logs/dnt-*" "#1642"
fi

# 20at. A shared-world dry run with three participants, one on a phone and one with a numbered id,
# captions each by its roster id in words, the phone one with ", phone", the numbered one by its
# persona's name, and its captions, participant summaries, run summary and persona name hold none
# of swarm, plane, coherently, "overlap proven", goal_satisfied, type:, surface:, case: (#1644).
# 0.111.4 captioned "Concurrent persona <id> (type:... / surface:... / case:...) · <study>".
cat >"$project/humanish/studies/sw-captions.yaml" <<'YAML'
schema: humanish.study.v3
id: sw-captions
title: Shared-world dry run, three participants
route: shared-world
mode: dry-run
subject:
  source: clone
  exposure: synthetic
  repos:
    - example-org/collab-notes-app
  serve:
    start: HOST=0.0.0.0 PORT=3000 python3 server.py
    url: http://127.0.0.1:3000/
  state:
    checkpoint:
      - name: task-count
        command: python3 checkpoint.py
actor:
  type: openai-computer-use
  mission: Add one task, then stop.
participants:
  - id: lobby-host
    actorType: host
    surface: task-board
    caseGroup: board-001
    persona: weekly-planner
    device: desktop
    instruction: Add one task, then stop.
  - id: player-two
    persona: ops-coordinator
    device: mobile
    instruction: Add one task, then stop.
  - id: lane-03
    persona: ops-coordinator
    device: desktop
    instruction: Add one task, then stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx run sw-captions --run-id sw-captions --no-open --json >"$work/logs/sw-captions.json" 2>"$work/logs/sw-captions.err"
swc_exit=$?
rm -f "$project/humanish/studies/sw-captions.yaml"
swc_labels=$(json_field "$project/.humanish/runs/sw-captions/run.json" '(d.streams || []).map((s) => s.label).join("|")')
swc_words=$(json_field "$project/.humanish/runs/sw-captions/run.json" '[...(d.streams || []).map((s) => s.label), ...(d.simulations || []).map((s) => s.summary), d.review && d.review.summary, d.persona && d.persona.name].filter((t) => typeof t === "string" && [/\bswarm\b/i, /\bplane\b/i, /\bcoherently\b/i, /overlap proven/i, /goal_satisfied/, /\btype:/, /\bsurface:/, /\bcase:/].some((re) => re.test(t))).length')
if [ "$swc_exit" = 0 ] && [ "$swc_labels" = "Lobby host|Player two, phone|Ops coordinator" ] && [ "$swc_words" = 0 ]; then
  record "shared-world dry run: plain captions and summaries" PASS "captions '${swc_labels}'; 0 strings hold a removed word" "#1644"
else
  record "shared-world dry run: plain captions and summaries" FAIL "exit $swc_exit, captions '${swc_labels:0:300}', strings with a removed word '${swc_words}'; see logs/sw-captions.*" "#1644"
fi

# 20au. `runs --json` reads a run directory with no outcome, no status record and a running
# simulation as interrupted (#1640). The bundle is check 4's dry run with its outcome removed and
# its simulations marked running, under a new id. 0.111.4 read it as running.
mkdir -p "$project/.humanish/runs/unfinished-run"
node -e 'const fs=require("fs");const [src,dst]=process.argv.slice(1);const d=JSON.parse(fs.readFileSync(src,"utf8"));const old=d.runId;delete d.outcome;d.runId="unfinished-run";for(const s of d.simulations||[])s.status="running";fs.writeFileSync(dst,JSON.stringify(d,null,2).split(old).join("unfinished-run")+"\n")' "$run_dir/run.json" "$project/.humanish/runs/unfinished-run/run.json"
hx runs --json >"$work/logs/runs-unfinished.json" 2>"$work/logs/runs-unfinished.err"
unf_exit=$?
unf_state=$(json_field "$work/logs/runs-unfinished.json" '((d.runs || []).find((r) => r.runId === "unfinished-run") || {}).display && (d.runs.find((r) => r.runId === "unfinished-run").display.state)')
# Later rows list runs; the crafted directory goes before them, by its absolute path under $work.
rm -r "$project/.humanish/runs/unfinished-run"
if [ "$unf_exit" = 0 ] && [ "$unf_state" = interrupted ]; then
  record "runs --json: no outcome, no status, running simulation reads interrupted" PASS "display.state interrupted" "#1640"
else
  record "runs --json: no outcome, no status, running simulation reads interrupted" FAIL "exit $unf_exit, display.state '${unf_state}'; see logs/runs-unfinished.*" "#1640"
fi

# 20av-20az: 0.113.0 (#1656, #1658, #1660). Participant impressions (#1650), the shared-world closing
# output (#1655) and the local capacity refusal on a Mac (#1658) need a live run or a Mac; this
# check covers none of them.

# 20av. `keys` with no subcommand reports each provider key humanish uses, with its source or the
# command that adds it, and never a value (#1660). On this keyless HOME every key is missing, so
# each has a hint. Run through npx, a hint names `npx humanish@<version> keys set ...`. `keys set` without a terminal names the `--stdin` form. 0.112.0 printed the
# usage block, exit 1, and `keys set` failed with commander's "missing required argument".
hx keys >"$work/logs/keys-status.out" 2>"$work/logs/keys-status.err"
ks_exit=$?
hx keys --json >"$work/logs/keys-status.json" 2>"$work/logs/keys-status-json.err"
ksj_exit=$?
hx keys set </dev/null >"$work/logs/keys-set.out" 2>"$work/logs/keys-set.err"
kset_exit=$?
ks_shape=$(json_field "$work/logs/keys-status.json" '[d.schema, d.action, (d.keys || []).map((k) => k.name + ":" + (k.source === null ? (typeof k.hint === "string" && /humanish(@[0-9.]+)? keys set /.test(k.hint) ? "hint" : "nohint") : "source")).join(",")].join(" ")')
ks_want='humanish.keys-result.v1 status E2B_API_KEY:hint,OPENAI_API_KEY:hint,GH_TOKEN:hint,AGENTMAIL_API_KEY:hint,GEMINI_API_KEY:hint,ANTHROPIC_API_KEY:hint'
if [ "$ks_exit" = 0 ] && [ "$ksj_exit" = 0 ] && [ "$ks_shape" = "$ks_want" ] &&
  grep -qE '^E2B_API_KEY \(hosted desktops\): missing; run `e2b auth login`, or `npx humanish(@[0-9.]+)? keys set e2b`$' "$work/logs/keys-status.out" &&
  grep -q '^Values are never printed.' "$work/logs/keys-status.out" &&
  [ "$kset_exit" = 2 ] && grep -q 'keys set e2b --stdin' "$work/logs/keys-set.err"; then
  record "keys: status with sources or hints; keys set without a terminal names --stdin" PASS "5 keys missing with hints; set exit 2 naming --stdin" "#1660"
else
  record "keys: status with sources or hints; keys set without a terminal names --stdin" FAIL "keys exit $ks_exit, --json exit $ksj_exit '${ks_shape}'; set exit $kset_exit; see logs/keys-*" "#1660"
fi

# 20aw. `help` is not listed under Commands in any command's help, and `help <command>` and
# `<command> help` still print that command's usage (#1660). 0.112.0 listed `help [command]`.
hx --help >"$work/logs/help-root.out" 2>&1
hx keys --help >"$work/logs/help-keys.out" 2>&1
hx help run >"$work/logs/help-run.out" 2>&1
hr_exit=$?
hx keys help >"$work/logs/help-keys2.out" 2>&1
hk_exit=$?
help_listed=0
for f in help-root help-keys; do
  n=$(awk '/^Commands:/{c=1;next} c&&/^[^ ]/{c=0} c' "$work/logs/$f.out" | grep -cE '^ +help\b')
  help_listed=$((help_listed + n))
done
if [ "$help_listed" = 0 ] && grep -q '^Commands:' "$work/logs/help-root.out" &&
  [ "$hr_exit" = 0 ] && grep -q '^Usage: humanish run ' "$work/logs/help-run.out" &&
  [ "$hk_exit" = 0 ] && grep -q '^Usage: humanish keys ' "$work/logs/help-keys2.out"; then
  record "help: not listed under Commands; help run and keys help still work" PASS "0 help entries; both usages printed" "#1660"
else
  record "help: not listed under Commands; help run and keys help still work" FAIL "help entries $help_listed, help run exit $hr_exit, keys help exit $hk_exit; see logs/help-*" "#1660"
fi

# 20ax. `study check` warns, and still passes, when a computer-use mission is a numbered click list
# or a participant's persona has no background (#1656). The starter studies init writes print no
# warning: their personas lead with a background. 0.112.0 printed neither warning.
cat >"$project/humanish/studies/scripted-mission.yaml" <<'YAML'
schema: humanish.study.v3
id: scripted-mission
title: A mission written as a numbered click list
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    1. Click "New task". 2. Type "Buy milk" into the title field, then press Save. 3. Open
    http://127.0.0.1:3000/settings and click the Export button.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
cat >"$project/humanish/personas/no-bg-user.yaml" <<'YAML'
schema: humanish.persona.v1
id: no-bg-user
name: No Background User
summary: A synthetic first-time user.
traits:
  patience: medium
  technical_confidence: medium
YAML
cat >"$project/humanish/studies/no-background.yaml" <<'YAML'
schema: humanish.study.v3
id: no-background
title: A participant whose persona has no background
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: no-bg-user
  mission: >-
    You are planning a weekend for your family. See whether this app helps you keep track of what
    needs doing, then stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx study check scripted-mission >"$work/logs/check-scripted.out" 2>"$work/logs/check-scripted.err"
cs_exit=$?
hx study check no-background >"$work/logs/check-nobg.out" 2>"$work/logs/check-nobg.err"
cn_exit=$?
rm -f "$project/humanish/studies/scripted-mission.yaml" "$project/humanish/studies/no-background.yaml" "$project/humanish/personas/no-bg-user.yaml"
starter_warn=""
for s in first-run try-live local-browser cua-browser; do
  hx study check "$s" >"$work/logs/check-starter-$s.out" 2>"$work/logs/check-starter-$s.err"
  e=$?
  if [ "$e" != 0 ] || grep -qi '^warning' "$work/logs/check-starter-$s.out" "$work/logs/check-starter-$s.err"; then starter_warn="$starter_warn $s(exit $e)"; fi
done
starter_bg=$(grep -l '^background:' "$project/humanish/personas/synthetic-new-user.yaml" "$project/humanish/personas/skeptical-power-user.yaml" 2>/dev/null | wc -l)
if [ "$cs_exit" = 0 ] && grep -q '^warning: actor.mission reads like a script' "$work/logs/check-scripted.out" "$work/logs/check-scripted.err" &&
  grep -q '^> 1. Click "New task".' "$work/logs/check-scripted.out" "$work/logs/check-scripted.err" &&
  [ "$cn_exit" = 0 ] && grep -q 'has no persona background because persona no-bg-user has no readable background' "$work/logs/check-nobg.out" "$work/logs/check-nobg.err" &&
  [ -z "$starter_warn" ] && [ "$starter_bg" = 2 ]; then
  record "study check: script and no-background warnings; starter studies warn on nothing" PASS "both warnings, exit 0; 4 starter studies, 0 warnings; 2 starter personas with background" "#1656"
else
  record "study check: script and no-background warnings; starter studies warn on nothing" FAIL "scripted exit $cs_exit, no-background exit $cn_exit, starter warnings '${starter_warn}', starter personas with background $starter_bg; see logs/check-*" "#1656"
fi

# 20ay. `runtime status --json` reports this machine's capacity, `runtime setup --memory` refuses
# on Linux, and check 12's `doctor --study local-browser` has a local desktop capacity row (#1658).
# Linux only: on a Mac the capacity is the Lima VM's. 0.112.0 had no `capacity` and no --memory.
hx runtime status --json >"$work/logs/runtime-status.json" 2>"$work/logs/runtime-status.err"
rs_exit=$?
rt_cap=$(json_field "$work/logs/runtime-status.json" 'd.capacity && [d.capacity.host, d.capacity.reservedMemoryGiB, d.capacity.perDesktop && d.capacity.perDesktop.memoryGiB, d.capacity.perDesktop && d.capacity.perDesktop.cpus, d.capacity.desktops === Math.max(0, Math.floor((d.capacity.memoryGiB - d.capacity.reservedMemoryGiB) / 3 + 1e-9))].join(" ")')
hx runtime setup --memory 8 >"$work/logs/runtime-setup-memory.out" 2>"$work/logs/runtime-setup-memory.err"
rsm_exit=$?
cap_row=$(json_field "$work/logs/doctor.json" '((d.checks || []).find((c) => c.name === "local desktop capacity") || {}).message')
if [ "$rs_exit" = 0 ] && [ "$rt_cap" = "linux-host 1 3 2 true" ] && [ "$rsm_exit" = 2 ] &&
  grep -q 'which runs only on a Mac' "$work/logs/runtime-setup-memory.out" "$work/logs/runtime-setup-memory.err" &&
  [[ "$cap_row" == *"desktops fit at once"*"This study runs 1 at once, so it fits."* ]]; then
  record "runtime status --json capacity; setup --memory refused on Linux; doctor capacity row" PASS "$(json_field "$work/logs/runtime-status.json" 'd.capacity.desktops') desktops fit; exit 2; row present" "#1658"
else
  record "runtime status --json capacity; setup --memory refused on Linux; doctor capacity row" FAIL "status exit $rs_exit '${rt_cap}', setup exit $rsm_exit, doctor row '${cap_row:0:120}'; see logs/runtime-*" "#1658"
fi

# 20az. The update notice (#1660). A cache naming a newer latest version, checked now so no
# registry request starts: `doctor` shows it; a command at a terminal prints the one notice line
# when DO_NOT_TRACK and HUMANISH_TELEMETRY_DISABLED are off (telemetry stays off: telemetry.json
# says enabled false, and HUMANISH_TELEMETRY_DEBUG keeps any payload local); the same command
# with DO_NOT_TRACK=1 prints none. Both cache files are removed after. 0.112.0 had no notice.
upd_dir="$user_home/.config/humanish"
mkdir -p "$upd_dir"
upd_cache() { printf '{\n  "checkedAt": "%s",\n  "latest": "99.0.0"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$upd_dir/update-check.json"; }
had_telemetry=no
[ -f "$upd_dir/telemetry.json" ] && had_telemetry=yes
[ "$had_telemetry" = no ] && printf '{ "enabled": false, "anonymousId": "00000000-0000-4000-8000-000000000000", "noticed": true }\n' >"$upd_dir/telemetry.json"
upd_cache
hx doctor >"$work/logs/update-doctor.out" 2>"$work/logs/update-doctor.err"
hx_pty "$work/logs/update-tty.out" wait DO_NOT_TRACK=0 HUMANISH_TELEMETRY_DISABLED=0 HUMANISH_TELEMETRY_DEBUG=1 -- runs >"$work/logs/update-tty.result" 2>&1
cp "$upd_dir/update-check.json" "$work/logs/update-cache-after.json"
upd_cache
hx_pty "$work/logs/update-tty-dnt.out" wait DO_NOT_TRACK=1 HUMANISH_TELEMETRY_DISABLED=0 HUMANISH_TELEMETRY_DEBUG=1 -- runs >"$work/logs/update-tty-dnt.result" 2>&1
rm -f "$upd_dir/update-check.json"
[ "$had_telemetry" = no ] && rm -f "$upd_dir/telemetry.json"
upd_line="humanish $version is out of date; the latest is 99.0.0. Run npx humanish@latest to use it."
upd_tty=$(tr -d '\r' <"$work/logs/update-tty.out" | grep -cxF "$upd_line")
upd_dnt=$(grep -c 'is out of date' "$work/logs/update-tty-dnt.out")
upd_debug=$(grep -c 'telemetry (debug' "$work/logs/update-tty.out")
if grep -qF "$version installed; 99.0.0 is the latest" "$work/logs/update-doctor.out" &&
  [ "$upd_tty" = 1 ] && [ "$upd_dnt" = 0 ] && [ "$upd_debug" = 0 ] && grep -q '"notifiedAt"' "$work/logs/update-cache-after.json"; then
  record "update notice: doctor row; one line at a terminal; none with DO_NOT_TRACK" PASS "doctor names 99.0.0; 1 notice line; 0 with DO_NOT_TRACK=1; no telemetry payload" "#1660"
else
  record "update notice: doctor row; one line at a terminal; none with DO_NOT_TRACK" FAIL "terminal notice lines $upd_tty, with DO_NOT_TRACK $upd_dnt, telemetry debug lines $upd_debug; see logs/update-*" "#1660"
fi

# 20ba-20be: 0.114.0 (#1667, #1668, #1670). The impressions request in conversation.requests
# (#1666), automatic analysis admitted under the default cap after a live run (#1667) and the
# Observer form for notes in a browser (#1668) need a live run or a browser, which this check
# does not use.

# 20ba. Reviewer notes from the CLI (#1668). `notes` is listed under Commands and has its own help.
# A dry run has no capture times, so a note on it is refused. 20t's live scripted run records no
# capture times either, so its four captures get `at` stamps 2 s apart in run.json and its actor
# trace first, the way a computer-use trace carries them. A humanish.run-bundle.v2 run (0.123.0)
# keeps the trace in its own file, indexed in run.json by bytes and sha256, so the stamp rewrites
# that index too; without it verify refuses the edited trace as tampered. Then one note on the whole run, one on
# its participant, and one holding a synthetic secret-shaped value and a local path, built here at
# run time; that one is saved with both replaced and a warning. `notes --json` lists the three in
# run clock order, one file each under notes/, and verify grades the run as it did before the
# notes. 0.113.0 has no notes command.
hx --help >"$work/logs/notes-root-help.out" 2>&1
hx notes --help >"$work/logs/notes-help.out" 2>&1
nh_exit=$?
notes_listed=$(awk '/^Commands:/{c=1;next} c&&/^[^ ]/{c=0} c' "$work/logs/notes-root-help.out" | grep -cE '^ +notes\b')
hx notes "$run_id" --add --at 0:01 "A dry run has no clock." --json >"$work/logs/notes-dry.json" 2>"$work/logs/notes-dry.err"
nd_exit=$?
nd_code=$(json_field "$work/logs/notes-dry.json" 'd.error && d.error.code')
off_dir="$project/.humanish/runs/$off_run"
hx verify --run "$off_run" --json >"$work/logs/notes-verify-before.json" 2>"$work/logs/notes-verify-before.err"
nv_before=$(json_field "$work/logs/notes-verify-before.json" 'd.shareSafety && d.shareSafety.status')
node -e '
const fs=require("fs"),p=require("path"),c=require("crypto");const dir=process.argv[1];
const stamp=(a)=>{const s=Date.parse(a.startedAt);let n=0;for(const i of a.items??[])if(i.screenshotRef)i.at=new Date(s+2000*n++).toISOString();return n;};
const run=JSON.parse(fs.readFileSync(p.join(dir,"run.json"),"utf8"));let n=0;const indexed=new Set();
for(const s of run.streams){if(s.actor)n+=stamp(s.actor);if(!s.trace)continue;indexed.add(s.trace.path);
const a=JSON.parse(fs.readFileSync(p.join(dir,s.trace.path),"utf8"));n+=stamp(a);const b=Buffer.from(JSON.stringify(a,null,2)+"\n");
fs.writeFileSync(p.join(dir,s.trace.path),b);s.trace.bytes=b.length;s.trace.sha256=c.createHash("sha256").update(b).digest("hex");}
fs.writeFileSync(p.join(dir,"run.json"),JSON.stringify(run,null,2));
for(const f of fs.readdirSync(dir).filter((f)=>/^actor-.*\.json$/.test(f)&&!indexed.has(f))){const a=JSON.parse(fs.readFileSync(p.join(dir,f),"utf8"));stamp(a);fs.writeFileSync(p.join(dir,f),JSON.stringify(a,null,2));}
console.log(n);' "$off_dir" >"$work/logs/notes-stamped.txt" 2>&1
notes_stream=$(json_field "$off_dir/run.json" 'd.streams[0].id')
fake_key=$(node -e 'const c="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";let s="sk-proj-";for(let i=0;i<48;i++)s+=c[require("crypto").randomInt(c.length)];process.stdout.write(s)')
hx notes "$off_run" --add --at 0:02 "The welcome line took a moment." >"$work/logs/notes-add-1.out" 2>"$work/logs/notes-add-1.err"
na1=$?
hx notes "$off_run" --add --at 0:04 --participant "$notes_stream" "They looked for a second field." >"$work/logs/notes-add-2.out" 2>"$work/logs/notes-add-2.err"
na2=$?
hx notes "$off_run" --add --at 0:06 "Pasted $fake_key from /home/someuser/app/.env by mistake." >"$work/logs/notes-add-3.out" 2>"$work/logs/notes-add-3.err"
na3=$?
hx notes "$off_run" --json >"$work/logs/notes-list.json" 2>"$work/logs/notes-list.err"
nl_exit=$?
hx notes "$off_run" >"$work/logs/notes-list.out" 2>>"$work/logs/notes-list.err"
nl_shape=$(json_field "$work/logs/notes-list.json" '[d.schema, d.ok, d.notes.map((n) => n.atMs / 1000 + ":" + (n.participant === null ? "run" : "participant") + ":" + n.author).join(","), d.notes[2] && /^Pasted \[REDACTED_SECRET\] from \[REDACTED_RUNTIME_PATH\] by mistake\.$/.test(d.notes[2].text)].join(" ")')
nl_files=$(find "$off_dir/notes" -name '*.json' 2>/dev/null | wc -l)
fake_hits=$(grep -rlF "$fake_key" "$off_dir" "$work/logs" 2>/dev/null | head -n 3 | tr '\n' ' ')
unset fake_key
hx verify --run "$off_run" --json >"$work/logs/notes-verify-after.json" 2>"$work/logs/notes-verify-after.err"
nv_after=$(json_field "$work/logs/notes-verify-after.json" 'd.shareSafety && d.shareSafety.status')
if [ "$nh_exit" = 0 ] && grep -q '^Usage: humanish notes ' "$work/logs/notes-help.out" && [ "$notes_listed" = 1 ] &&
  [ "$nd_exit" = 2 ] && [ "$nd_code" = HUMANISH_NOTE_NO_CLOCK ] &&
  [ "$na1" = 0 ] && [ "$na2" = 0 ] && [ "$na3" = 0 ] && grep -q '^warning: Part of the note looked like a secret or a local path' "$work/logs/notes-add-3.out" &&
  [ "$nl_exit" = 0 ] && [ "$nl_shape" = "humanish.notes-result.v1 true 2:run:you,4:participant:you,6:run:you true" ] &&
  [ "$nl_files" = 3 ] && [ -z "$fake_hits" ] && grep -q '^Reviewer notes on run .*: 3$' "$work/logs/notes-list.out" &&
  [ -n "$nv_before" ] && [ "$nv_before" = "$nv_after" ]; then
  record "notes: help, dry-run refusal, add three, --json, scrub, verify unchanged" PASS "3 notes in notes/, secret and path replaced; verify ${nv_after} before and after" "#1668"
else
  record "notes: help, dry-run refusal, add three, --json, scrub, verify unchanged" FAIL "help $nh_exit listed $notes_listed; dry $nd_exit $nd_code; adds $na1 $na2 $na3; list $nl_exit '${nl_shape}' files $nl_files; key hits '${fake_hits}'; verify ${nv_before} -> ${nv_after}; see logs/notes-*" "#1668"
fi

# 20bb. The served Observer takes a note only with the token in the page it rendered, from that
# page's own address (#1668). `observe --run --serve` on the same run; the page's run-notes slot
# carries a 43-character token. Without the token, with a foreign Origin, or with another Host the
# POST is 403; text/plain is 415; DELETE is 405; with the token from the page's own address it is
# 201 and a fourth file appears. The token is read into this shell only. 0.113.0 answers no POST.
obs_port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
(cd "$project" && timeout 120 "${run_env[@]}" npx -y --package "$spec" humanish observe --run "$off_run" --serve --no-open --port "$obs_port" </dev/null >"$work/logs/notes-observe.out" 2>"$work/logs/notes-observe.err") &
obs_pid=$!
for _ in $(seq 1 100); do
  grep -q "^url: http://127.0.0.1:$obs_port/" "$work/logs/notes-observe.out" 2>/dev/null && break
  sleep 0.2
done
obs_url=$(grep -o "http://127.0.0.1:$obs_port/[^ ]*" "$work/logs/notes-observe.out" | head -n 1)
node - "$obs_url" "$off_run" >"$work/logs/notes-post.json" 2>"$work/logs/notes-post.err" <<'JS'
const [url, runId] = process.argv.slice(2);
const { request } = require("node:http");
const u = new URL(url);
const send = (method, headers, body) => new Promise((resolve) => {
  const req = request({ host: "127.0.0.1", port: u.port, path: "/api/notes", method, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", () => resolve("error"));
  if (body) req.write(body);
  req.end();
});
(async () => {
  const page = await (await fetch(url)).text();
  const slot = /<script[^>]*id="run-notes"[^>]*>([\s\S]*?)<\/script>/.exec(page);
  const token = slot ? JSON.parse(slot[1])?.write?.token ?? "" : "";
  const host = `127.0.0.1:${u.port}`;
  const origin = `http://${host}`;
  const body = JSON.stringify({ runId, atMs: 1000, participant: null, text: "Posted with the page token." });
  const json = "application/json";
  console.log(JSON.stringify({
    tokenLength: token.length,
    noToken: await send("POST", { host, origin, "content-type": json }, body),
    foreignOrigin: await send("POST", { host, origin: "http://attacker.example", "content-type": json, "x-humanish-notes-token": token }, body),
    otherHost: await send("POST", { host: `attacker.example:${u.port}`, origin: `http://attacker.example:${u.port}`, "content-type": json, "x-humanish-notes-token": token }, body),
    textPlain: await send("POST", { host, origin, "content-type": "text/plain", "x-humanish-notes-token": token }, body),
    del: await send("DELETE", { host, origin }),
    withToken: await send("POST", { host, origin, "content-type": json, "x-humanish-notes-token": token }, body),
  }));
})();
JS
pkill -TERM -P "$obs_pid" 2>/dev/null
wait "$obs_pid" 2>/dev/null
# The server prints "observe stopped" and closes its port shortly after the signal.
for _ in $(seq 1 50); do
  obs_after=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$obs_port/" 2>/dev/null)
  [ "$obs_after" = 000 ] && break
  sleep 0.2
done
post_view=$(json_field "$work/logs/notes-post.json" '[d.tokenLength, d.noToken, d.foreignOrigin, d.otherHost, d.textPlain, d.del, d.withToken].join(" ")')
post_files=$(find "$off_dir/notes" -name '*.json' 2>/dev/null | wc -l)
if [ "$post_view" = "43 403 403 403 415 405 201" ] && [ "$post_files" = 4 ] && [ "$obs_after" = 000 ]; then
  record "observe --serve: notes POST needs the page token and address" PASS "403 without token, foreign Origin, other Host; 415 text/plain; 405 DELETE; 201 with token" "#1668"
else
  record "observe --serve: notes POST needs the page token and address" FAIL "token length, no token, origin, host, text/plain, DELETE, with token: '${post_view}'; files $post_files; server after stop ${obs_after}; see logs/notes-post.* and notes-observe.*" "#1668"
fi

# 20bc. Analysis admission on 20t's live scripted run, with --dry-run so no key is read and no
# request is sent (#1667). `--json` admission carries the expected cost as estimatedCostUsd, below
# worstCaseCostUsd, and maxCostUsd; the human dry run prints the expected cost, the worst case and
# the cap; --max-cost 0.01 is refused, exit 2, naming the expected cost and the analyze command
# with a whole-dollar --max-cost. 0.113.0 printed one conservative estimate and refused with "The
# conservative admission estimate exceeds --max-cost." 0.115.0 names the command as this install runs
# humanish, `npx humanish@<version> analyze` (#1681), so the grep accepts that prefix.
hx analyze --run "$off_run" --dry-run --max-cost 3 --json >"$work/logs/admission-dry.json" 2>"$work/logs/admission-dry.err"
ad_exit=$?
ad_view=$(json_field "$work/logs/admission-dry.json" 'd.admission && [d.admission.allowed, d.admission.estimatedCostUsd > 0 && d.admission.estimatedCostUsd < d.admission.worstCaseCostUsd, d.admission.maxCostUsd].join(" ")')
hx analyze --run "$off_run" --dry-run --max-cost 3 >"$work/logs/admission-dry.out" 2>>"$work/logs/admission-dry.err"
adh_exit=$?
hx analyze --run "$off_run" --dry-run --max-cost 0.01 >"$work/logs/admission-refuse.out" 2>"$work/logs/admission-refuse.err"
ar_exit=$?
if [ "$ad_exit" = 0 ] && [ "$ad_view" = "true true 3" ] && [ "$adh_exit" = 0 ] &&
  grep -qE '^Expected cost: \$[0-9.]+\. Worst case: \$[0-9.]+, .*Admitted under the \$3 cap\. No request sent\.$' "$work/logs/admission-dry.out" &&
  [ "$ar_exit" = 2 ] && grep -qE 'The expected cost is \$[0-9.]+ and the worst case is \$[0-9.]+\. With a 10% margin the expected cost is over the \$0\.01 cap' "$work/logs/admission-refuse.err" &&
  grep -qE "humanish(@[0-9.]+)? analyze --run $off_run --max-cost [0-9]+$" "$work/logs/admission-refuse.err" && grep -q '^code: analysis_budget_exceeded' "$work/logs/admission-refuse.err"; then
  record "analyze --dry-run: expected cost, worst case, cap; refusal names the command" PASS "admitted under 3 with expected below worst case; 0.01 refused, exit 2" "#1667"
else
  record "analyze --dry-run: expected cost, worst case, cap; refusal names the command" FAIL "json exit $ad_exit '${ad_view}', human exit $adh_exit, refusal exit $ar_exit; see logs/admission-*" "#1667"
fi

# 20bd. `study check` gives the expected analysis cost range for the study's participant count
# (#1667): try-live, one participant, $0.15 to $0.76 for the default gpt-6.1-sol analysis, in the
# text and as analysis.participants and analysis.expectedCostUsd {low, high} in JSON, and says the
# cap is compared with the expected cost plus a 10% margin. 0.118.0 (#1735) ended the range at
# $2.83, the largest packet admission admitted under the old $3 cap; the default cap is now $10,
# which admits the packet at the evidence limits, so the range ends at $0.76. The rule is stated as
# both the worst case and the expected cost plus the margin over the cap. 0.113.0 printed "refused
# before it starts if its estimate is over $3". On this keyless HOME, `doctor --study` says the
# analysis will be skipped, so its cap wording is not checked here.
hx study check try-live >"$work/logs/check-range.out" 2>"$work/logs/check-range.err"
cr_exit=$?
hx study check try-live --json >"$work/logs/check-range.json" 2>>"$work/logs/check-range.err"
crj_exit=$?
cr_view=$(json_field "$work/logs/check-range.json" 'd.analysis && [d.analysis.participants, d.analysis.expectedCostUsd && d.analysis.expectedCostUsd.low.toFixed(2), d.analysis.expectedCostUsd && d.analysis.expectedCostUsd.high.toFixed(2), d.analysis.maxCostUsd].join(" ")')
if [ "$cr_exit" = 0 ] && [ "$crj_exit" = 0 ] && [ "$cr_view" = "1 0.15 0.76 10" ] &&
  grep -qF 'expected $0.15 to $0.76 for 1 participant, depending on how much evidence the run keeps' "$work/logs/check-range.out" &&
  grep -qF 'refused before it starts if both its worst case and its expected cost plus a 10% margin are over $10' "$work/logs/check-range.out"; then
  record "study check: expected analysis cost range" PASS "1 participant: \$0.15 to \$0.76, cap \$10 on the worst case and expected plus 10%" "#1667, #1735"
else
  record "study check: expected analysis cost range" FAIL "exit $cr_exit/$crj_exit '${cr_view}'; see logs/check-range*" "#1667, #1735"
fi

# 20be. verify reads percent escapes as UTF-8 as well as byte by byte (#1670). A dry run's review.md
# gets a percent-encoded `?next=` redirect whose target holds `password=` and a value built here at
# run time: U+00E0 (UTF-8 C3 A0, which the byte reading turns into a letter and a no-break space)
# then 20 random letters and digits. The control is the same with an ASCII first letter. Both are
# blocked with PUBLIC_SAFETY_FINDINGS and neither value is echoed. 0.113.0 grades the first
# share_ready and blocks the control.
for kind in utf8 ascii; do
  hx run first-run --run-id "verify-pct-$kind" --no-open --json >"$work/logs/verify-pct-$kind-run.json" 2>"$work/logs/verify-pct-$kind-run.err"
  node -e '
const { randomInt } = require("crypto");
const pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
let rest = ""; for (let i = 0; i < 20; i++) rest += pool[randomInt(pool.length)];
const first = process.argv[2] === "ascii" ? pool[randomInt(26)] : String.fromCodePoint(0xe0);
const line = `\nopened https://app.example.com/?next=${encodeURIComponent("/login?password=" + first + rest)}\n`;
require("fs").appendFileSync(process.argv[1], line);
process.stdout.write(encodeURIComponent(first + rest));' "$project/.humanish/runs/verify-pct-$kind/review.md" "$kind" >"$work/verify-pct-$kind.value"
done
pct_views=""
pct_echo=0
for kind in utf8 ascii; do
  hx verify --run "verify-pct-$kind" --json >"$work/logs/verify-pct-$kind.json" 2>"$work/logs/verify-pct-$kind.err"
  pct_views="$pct_views $kind:$?:$(json_field "$work/logs/verify-pct-$kind.json" '[d.shareSafety && d.shareSafety.status, (d.shareSafety && d.shareSafety.reasons || []).some((r) => r.code === "PUBLIC_SAFETY_FINDINGS")].join(",")')"
  grep -qF "$(cat "$work/verify-pct-$kind.value")" "$work/logs/verify-pct-$kind.json" "$work/logs/verify-pct-$kind.err" && pct_echo=$((pct_echo + 1))
done
rm -f "$work/verify-pct-utf8.value" "$work/verify-pct-ascii.value"
if [ "$pct_views" = " utf8:2:blocked,true ascii:2:blocked,true" ] && [ "$pct_echo" = 0 ]; then
  record "verify: percent-encoded password starting with a non-ASCII letter" PASS "U+00E0 first and ASCII control both blocked, PUBLIC_SAFETY_FINDINGS; values not echoed" "#1670"
else
  record "verify: percent-encoded password starting with a non-ASCII letter" FAIL "'${pct_views}', echoed $pct_echo; see logs/verify-pct-*" "#1670"
fi

# 20bf-20bk: 0.115.0 (#1678, #1680, #1681, #1682). The OpenAI participant's closing request schema
# (#1680), concurrent note adds (#1679, fixed in #1682) and analysis admission after a live run need
# a live run or a browser, which this check does not use.

# 20bf. `analyze --json` adds admission.admittedCostUsd (#1681): the expected cost plus 10%, or the
# worst case when that is lower, rounded up to six places, the smallest --max-cost that admits the
# analysis. Read on 20t's live scripted run with --dry-run, so no key is read and no request is
# sent: a dry run at that cap is admitted and one 0.000001 below it is refused. The refusal without
# --dry-run names its command the way this install runs humanish, `npx humanish@<version>
# analyze`, as `notes` does (20ba). 0.114.0 has no admittedCostUsd and names a bare
# `humanish analyze`.
hx analyze --run "$off_run" --dry-run --max-cost 3 --json >"$work/logs/admitted-dry.json" 2>"$work/logs/admitted-dry.err"
adm_exit=$?
adm_view=$(json_field "$work/logs/admitted-dry.json" 'd.admission && [typeof d.admission.admittedCostUsd, Math.abs(d.admission.admittedCostUsd - Math.ceil(Math.min(d.admission.worstCaseCostUsd, d.admission.estimatedCostUsd * 1.1) * 1e6 - 1e-6) / 1e6) < 2e-6, d.admission.admittedCostUsd <= d.admission.maxCostUsd].join(" ")')
adm_cap=$(json_field "$work/logs/admitted-dry.json" 'd.admission && d.admission.admittedCostUsd')
adm_at=none
adm_below=none
if [ -n "$adm_cap" ]; then
  hx analyze --run "$off_run" --dry-run --max-cost "$adm_cap" >"$work/logs/admitted-at.out" 2>"$work/logs/admitted-at.err"
  adm_at=$?
  hx analyze --run "$off_run" --dry-run --max-cost "$(node -p "($adm_cap - 0.000001).toFixed(6)")" >"$work/logs/admitted-below.out" 2>"$work/logs/admitted-below.err"
  adm_below=$?
fi
hx analyze --run "$off_run" --max-cost 0.01 >"$work/logs/admitted-refuse.out" 2>"$work/logs/admitted-refuse.err"
adr_exit=$?
if [ "$adm_exit" = 0 ] && [ "$adm_view" = "number true true" ] && [ "$adm_at" = 0 ] && [ "$adm_below" = 2 ] &&
  [ "$adr_exit" = 2 ] && grep -qE "To run it, raise the cap: npx humanish@$version analyze --run $off_run --max-cost [0-9]+$" "$work/logs/admitted-refuse.err"; then
  record "analyze --json: admittedCostUsd admits at the cap, refuses below; refusal names npx" PASS "admitted ${adm_cap}; exit 0 at it, 2 at 0.000001 below; npx humanish@$version analyze" "#1681"
else
  record "analyze --json: admittedCostUsd admits at the cap, refuses below; refusal names npx" FAIL "json exit $adm_exit '${adm_view}' cap '${adm_cap}', at $adm_at, below $adm_below, refusal exit $adr_exit '$(grep -o 'raise the cap: .*' "$work/logs/admitted-refuse.err" | cut -c1-120)'; see logs/admitted-*" "#1681"
fi

# 20bg. `keys set constructor` and `keys set __proto__` with a value on stdin are refused with the
# store's provider-key list, exit 2, and write nothing (#1678). Both names matched a built-in object
# property in the alias table: 0.114.0 printed "Not a valid env name: function Object() { [native
# code] }" and "[object Object]". The store here is this check's temporary HOME.
ks_dir="$user_home/.config/humanish"
ks_before=$(find "$ks_dir" -type f 2>/dev/null | sort | xargs -r sha256sum 2>/dev/null | sha256sum)
ks_view=""
for name in constructor __proto__; do
  (cd "$project" && printf 'x' | timeout 600 "${run_env[@]}" npx -y --package "$spec" humanish keys set "$name" --stdin >"$work/logs/keys-set-$name.out" 2>"$work/logs/keys-set-$name.err")
  ks_view="$ks_view $name:$?:$(grep -c '^humanish keys set failed: The store holds provider keys only (' "$work/logs/keys-set-$name.err")"
done
ks_after=$(find "$ks_dir" -type f 2>/dev/null | sort | xargs -r sha256sum 2>/dev/null | sha256sum)
if [ "$ks_view" = " constructor:2:1 __proto__:2:1" ] && [ "$ks_before" = "$ks_after" ]; then
  record "keys set constructor and __proto__: provider-key refusal" PASS "exit 2 each, 'The store holds provider keys only (...)'; nothing written" "#1678"
else
  record "keys set constructor and __proto__: provider-key refusal" FAIL "'${ks_view}', store changed: $([ "$ks_before" = "$ks_after" ] && echo no || echo yes); see logs/keys-set-*" "#1678"
fi

# 20bh. `export --local-only` of a dry run that verify grades blocked: its review.md gets a synthetic
# OpenAI-shaped key built here at run time. verify grades it blocked with VERIFY_FAILED and
# PUBLIC_SAFETY_FINDINGS, and export refuses it, exit 2, HUMANISH_EXPORT_VERIFY_FAILED, its share
# safety still blocked, with no file written. #1682's rule (a failed export check only moves a run
# toward blocked) applies after verify passes its checks; a planted value fails them first, so this
# row reads the same on 0.114.0. The rule itself is covered by tests/feedback in release:check.
hx run first-run --run-id export-blocked --no-open --json >"$work/logs/export-blocked-run.json" 2>"$work/logs/export-blocked-run.err"
node -e '
const { randomInt } = require("crypto");
const pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
let rest = ""; for (let i = 0; i < 48; i++) rest += pool[randomInt(pool.length)];
require("fs").appendFileSync(process.argv[1], `\nThe participant pasted sk-proj-${rest} into the name field.\n`);' "$project/.humanish/runs/export-blocked/review.md"
hx verify --run export-blocked --json >"$work/logs/export-blocked-verify.json" 2>"$work/logs/export-blocked-verify.err"
eb_verify="$?:$(json_field "$work/logs/export-blocked-verify.json" '[d.shareSafety.status, d.shareSafety.reasons.map((r) => r.code).filter((c) => c === "VERIFY_FAILED" || c === "PUBLIC_SAFETY_FINDINGS").join("+")].join(",")')"
hx export --run export-blocked --local-only --json >"$work/logs/export-blocked.json" 2>"$work/logs/export-blocked.err"
eb_export="$?:$(json_field "$work/logs/export-blocked.json" '[d.error && d.error.code, d.shareSafety && d.shareSafety.status].join(",")')"
eb_files=$(find "$project/.humanish/exports" -name 'export-blocked*' 2>/dev/null | wc -l)
if [ "$eb_verify" = "2:blocked,VERIFY_FAILED+PUBLIC_SAFETY_FINDINGS" ] && [ "$eb_export" = "2:HUMANISH_EXPORT_VERIFY_FAILED,blocked" ] && [ "$eb_files" = 0 ]; then
  record "export --local-only of a blocked run stays blocked" PASS "verify blocked; export refused, exit 2, share safety blocked; no file" "#1682"
else
  record "export --local-only of a blocked run stays blocked" FAIL "verify '${eb_verify}', export '${eb_export}', files $eb_files; see logs/export-blocked*" "#1682"
fi

# 20bi. Telemetry reads CI=false and HUMANISH_STUDY_PARTICIPANT=false as off (#1678). Read from the
# debug line, which prints the payload and sends nothing: telemetry.json in this check's temporary
# HOME says enabled true with a zero anonymous id, HUMANISH_TELEMETRY_DEBUG=1, the update check is
# off, and DO_NOT_TRACK and HUMANISH_TELEMETRY_DISABLED are 0 for these two commands only. The file
# is removed after when this row wrote it. 0.114.0 counted any value other than empty or `0` as
# set, so CI=false gave ci true.
tel_file="$user_home/.config/humanish/telemetry.json"
mkdir -p "$(dirname "$tel_file")"
tel_saved=""
[ -f "$tel_file" ] && tel_saved=$(cat "$tel_file")
printf '{ "enabled": true, "anonymousId": "00000000-0000-4000-8000-000000000000", "noticed": true }\n' >"$tel_file"
tel_view=""
for ci in false true; do
  (cd "$project" && timeout 600 "${run_env[@]}" DO_NOT_TRACK=0 HUMANISH_TELEMETRY_DISABLED=0 HUMANISH_TELEMETRY_DEBUG=1 HUMANISH_NO_UPDATE_CHECK=1 "CI=$ci" HUMANISH_STUDY_PARTICIPANT=false \
    npx -y --package "$spec" humanish runs --json >"$work/logs/telemetry-ci-$ci.out" 2>"$work/logs/telemetry-ci-$ci.err")
  tel_line=$(grep -m1 '^humanish telemetry (debug, not sent): ' "$work/logs/telemetry-ci-$ci.err" | sed 's/^humanish telemetry (debug, not sent): //')
  tel_view="$tel_view CI=$ci:$(printf '%s' "$tel_line" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{const p=JSON.parse(s).properties;process.stdout.write(`ci=${p.ci},studyParticipant=${p.studyParticipant}`)}catch{process.stdout.write("none")}})')"
done
if [ -n "$tel_saved" ]; then printf '%s\n' "$tel_saved" >"$tel_file"; else rm -f "$tel_file"; fi
if [ "$tel_view" = " CI=false:ci=false,studyParticipant=false CI=true:ci=true,studyParticipant=false" ]; then
  record "telemetry: CI=false and HUMANISH_STUDY_PARTICIPANT=false read as off" PASS "debug payload ci false with CI=false, true with CI=true; studyParticipant false; nothing sent" "#1678"
else
  record "telemetry: CI=false and HUMANISH_STUDY_PARTICIPANT=false read as off" FAIL "'${tel_view}'; see logs/telemetry-ci-*" "#1678"
fi

# 20bj. The TUI's study screen shows the analysis budget line `study check` prints (#1678): in a
# fresh project with only `init --yes`, `humanish tui` runs under a 100x40 pseudo-terminal (the
# size is set on that pty alone), the driver presses g, j a few times and Enter to open try-live,
# then q. Nothing else is pressed, so nothing starts. 0.114.0 showed "separate $3 admission
# estimate limit" with no expected cost.
tui_project="$work/tui-project"
mkdir -p "$tui_project"
(cd "$tui_project" && timeout 600 "${run_env[@]}" npx -y --package "$spec" humanish init --yes --json >"$work/logs/tui-init.json" 2>"$work/logs/tui-init.err")
cat >"$work/tui_driver.py" <<'PTY'
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
cwd, out, downs = sys.argv[1], sys.argv[2], int(sys.argv[3])
rest = sys.argv[4:]
sep = rest.index("--")
env = dict(kv.split("=", 1) for kv in rest[:sep])
argv = rest[sep + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
os.kill(pid, signal.SIGWINCH)
buf = b""
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
pump(10)
for key in [b"g"] + [b"j"] * downs + [b"\r"]:
    os.write(fd, key)
    pump(0.6)
pump(6)
mark = len(buf)
os.write(fd, b"q")
pump(2)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
plain = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r", b"", buf[:mark])
open(out, "wb").write(plain)
PTY
tui_found=none
for downs in 3 0 1 2 4 5; do
  timeout 90 python3 "$work/tui_driver.py" "$tui_project" "$work/logs/tui-study-$downs.txt" "$downs" "${pty_env[@]}" -- npx -y --package "$spec" humanish tui >"$work/logs/tui-study-$downs.result" 2>&1
  if grep -q 'studies / try-live' "$work/logs/tui-study-$downs.txt"; then tui_found=$downs; break; fi
done
tui_text=$(sed -n '/studies \/ try-live/,$p' "$work/logs/tui-study-$tui_found.txt" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
tui_runs=$(find "$tui_project/.humanish/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
if [ "$tui_found" != none ] && grep -qF 'expected $0.15 to $0.76 for 1 participant, depending on how much evidence the run keeps' <<<"$tui_text" &&
  grep -qF 'margin are over $10; this is not a billing cap.' <<<"$tui_text" && ! grep -qF 'admission estimate limit' <<<"$tui_text" && [ "$tui_runs" = 0 ]; then
  record "tui: try-live study screen shows the expected analysis cost line" PASS "expected \$0.15 to \$0.76 for 1 participant; no 'admission estimate limit'; no run started" "#1678, #1735"
else
  record "tui: try-live study screen shows the expected analysis cost line" FAIL "found at $tui_found; text '$(grep -o 'After live runs[^>]*' <<<"$tui_text" | cut -c1-160)'; runs $tui_runs; see logs/tui-study-*" "#1678, #1735"
fi

# 20bk. The warning for a participant whose persona has no background names `study show` the way
# this install runs humanish, `npx humanish@<version> study show <id> --json` (#1678); 0.114.0
# named a bare `humanish study show`. The same study and persona as 20ax, written again here and
# removed after.
cat >"$project/humanish/personas/no-bg-user.yaml" <<'YAML'
schema: humanish.persona.v1
id: no-bg-user
name: No Background User
summary: A synthetic first-time user.
traits:
  patience: medium
  technical_confidence: medium
YAML
cat >"$project/humanish/studies/no-background.yaml" <<'YAML'
schema: humanish.study.v3
id: no-background
title: A participant whose persona has no background
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: no-bg-user
  mission: >-
    You are planning a weekend for your family. See whether this app helps you keep track of what
    needs doing, then stop.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx study check no-background >"$work/logs/check-nobg-cli.out" 2>"$work/logs/check-nobg-cli.err"
nbc_exit=$?
rm -f "$project/humanish/studies/no-background.yaml" "$project/humanish/personas/no-bg-user.yaml"
if [ "$nbc_exit" = 0 ] && grep -qF "Run npx humanish@$version study show no-background --json to see what the participant receives." "$work/logs/check-nobg-cli.out" "$work/logs/check-nobg-cli.err"; then
  record "study check: no-background warning names npx study show" PASS "Run npx humanish@$version study show no-background --json" "#1678"
else
  record "study check: no-background warning names npx study show" FAIL "exit $nbc_exit '$(grep -ho 'Run [^ ]* *[^ ]* study show[^.]*' "$work/logs/check-nobg-cli.out" "$work/logs/check-nobg-cli.err" | head -n 1)'; see logs/check-nobg-cli.*" "#1678"
fi

# 20bl-20bs: 0.116.0 (#1685, #1691, #1693, #1698, #1707, #1711, #1716). Hosted keyboard input
# (#1713), the kill key (#1717), a sandbox past 60 minutes accepted by E2B and the TUI cursor,
# cost line and Run again rows need a live run or a second process, which this check does not
# use.

# 20bl. doctor's `e2b sandbox ceiling` row (#1707): 60 minutes at the default, the setting's value
# when HUMANISH_E2B_MAX_SANDBOX_MINUTES is set, and a failed row with exit 2 for 1441. 0.115.0 has
# no such row.
hx doctor >"$work/logs/ceiling-doctor.out" 2>"$work/logs/ceiling-doctor.err"
(cd "$project" && timeout 600 "${run_env[@]}" HUMANISH_E2B_MAX_SANDBOX_MINUTES=120 npx -y --package "$spec" humanish doctor) >"$work/logs/ceiling-doctor-120.out" 2>"$work/logs/ceiling-doctor-120.err"
(cd "$project" && timeout 600 "${run_env[@]}" HUMANISH_E2B_MAX_SANDBOX_MINUTES=1441 npx -y --package "$spec" humanish doctor) >"$work/logs/ceiling-doctor-1441.out" 2>"$work/logs/ceiling-doctor-1441.err"
cdb_exit=$?
cd_def=$(grep -cxF -e "- ok e2b sandbox ceiling: 60 minutes, E2B's Hobby limit. On a plan with longer sandboxes (Pro allows 1440 minutes), set HUMANISH_E2B_MAX_SANDBOX_MINUTES to that plan's limit." "$work/logs/ceiling-doctor.out")
cd_120=$(grep -c '^- ok e2b sandbox ceiling: 120 minutes, from HUMANISH_E2B_MAX_SANDBOX_MINUTES\.' "$work/logs/ceiling-doctor-120.out")
cd_bad=$(grep -cF -e '- missing e2b sandbox ceiling: HUMANISH_E2B_MAX_SANDBOX_MINUTES must be a whole number of minutes from 1 to 1440 (got "1441").' "$work/logs/ceiling-doctor-1441.out")
if [ "$cd_def" = 1 ] && [ "$cd_120" = 1 ] && [ "$cd_bad" = 1 ] && [ "$cdb_exit" = 2 ]; then
  record "doctor: e2b sandbox ceiling row" PASS "60 minutes by default; 120 from the setting; 1441 fails the row, exit 2" "#1707"
else
  record "doctor: e2b sandbox ceiling row" FAIL "default $cd_def, 120 $cd_120, 1441 $cd_bad exit $cdb_exit; see logs/ceiling-doctor*" "#1707"
fi

# 20bm. A dry-run study whose sandbox deadline is 90 minutes (an app-url session of 80 minutes plus
# the 10-minute teardown buffer) is refused at the default ceiling before a run is created, and the
# refusal names the setting value that admits it; with HUMANISH_E2B_MAX_SANDBOX_MINUTES=120 it
# plans (#1707). 0.115.0 refuses it at both, with no setting named. The study is removed after.
cat >"$project/humanish/studies/ceiling-ninety.yaml" <<'YAML'
schema: humanish.study.v3
id: ceiling-ninety
title: A study whose sandbox deadline is 90 minutes
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Look at the page that is open in the browser, then stop and say what it is for.
execution:
  target: e2b-desktop
  timeoutMs: 4800000
YAML
hx run ceiling-ninety --no-open >"$work/logs/ceiling-ninety.out" 2>"$work/logs/ceiling-ninety.err"
cn_def=$?
(cd "$project" && timeout 600 "${run_env[@]}" HUMANISH_E2B_MAX_SANDBOX_MINUTES=120 npx -y --package "$spec" humanish run ceiling-ninety --no-open) >"$work/logs/ceiling-ninety-120.out" 2>"$work/logs/ceiling-ninety-120.err"
cn_120=$?
rm -f "$project/humanish/studies/ceiling-ninety.yaml"
if [ "$cn_def" = 2 ] && grep -qF "derives a 90m sandbox deadline, and a sandbox may not live longer than 60m." "$work/logs/ceiling-ninety.out" "$work/logs/ceiling-ninety.err" &&
  grep -qF "set HUMANISH_E2B_MAX_SANDBOX_MINUTES to 90 or more." "$work/logs/ceiling-ninety.out" "$work/logs/ceiling-ninety.err" &&
  grep -qxF "run: not-created" "$work/logs/ceiling-ninety.out" &&
  [ "$cn_120" = 0 ] && grep -qxF "humanish run ceiling-ninety: dry run finished" "$work/logs/ceiling-ninety-120.out"; then
  record "run: a 90-minute sandbox deadline refused at 60, planned at 120" PASS "exit 2 naming HUMANISH_E2B_MAX_SANDBOX_MINUTES to 90 or more; exit 0 dry run at 120" "#1707"
else
  record "run: a 90-minute sandbox deadline refused at 60, planned at 120" FAIL "default exit $cn_def '$(grep -ho 'If your E2B plan[^.]*' "$work/logs/ceiling-ninety.out" "$work/logs/ceiling-ninety.err" | head -n 1)', 120 exit $cn_120; see logs/ceiling-ninety*" "#1707"
fi

# 20bn. NO_UPDATE_NOTIFIER turns the update check off with any value, `0` included (#1693). The
# 20az setup: a cache naming 99.0.0 checked now, a command at a terminal with DO_NOT_TRACK and
# HUMANISH_TELEMETRY_DISABLED off (telemetry.json says enabled false, HUMANISH_TELEMETRY_DEBUG keeps
# any payload local). Without NO_UPDATE_NOTIFIER the notice prints once; with NO_UPDATE_NOTIFIER=0
# it prints nothing. 0.115.0 did not read NO_UPDATE_NOTIFIER. Both files are removed after.
nun_had_telemetry=no
[ -f "$upd_dir/telemetry.json" ] && nun_had_telemetry=yes
[ "$nun_had_telemetry" = no ] && printf '{ "enabled": false, "anonymousId": "00000000-0000-4000-8000-000000000000", "noticed": true }\n' >"$upd_dir/telemetry.json"
upd_cache
hx_pty "$work/logs/nun-unset.out" wait DO_NOT_TRACK=0 HUMANISH_TELEMETRY_DISABLED=0 HUMANISH_TELEMETRY_DEBUG=1 -- runs >"$work/logs/nun-unset.result" 2>&1
upd_cache
hx_pty "$work/logs/nun-zero.out" wait DO_NOT_TRACK=0 HUMANISH_TELEMETRY_DISABLED=0 HUMANISH_TELEMETRY_DEBUG=1 NO_UPDATE_NOTIFIER=0 -- runs >"$work/logs/nun-zero.result" 2>&1
rm -f "$upd_dir/update-check.json"
[ "$nun_had_telemetry" = no ] && rm -f "$upd_dir/telemetry.json"
nun_unset=$(tr -d '\r' <"$work/logs/nun-unset.out" | grep -cxF "$upd_line")
nun_zero=$(grep -c 'is out of date' "$work/logs/nun-zero.out")
if [ "$nun_unset" = 1 ] && [ "$nun_zero" = 0 ]; then
  record "update notice: NO_UPDATE_NOTIFIER=0 turns it off" PASS "1 notice line without it; 0 with NO_UPDATE_NOTIFIER=0" "#1693"
else
  record "update notice: NO_UPDATE_NOTIFIER=0 turns it off" FAIL "notice lines without $nun_unset, with NO_UPDATE_NOTIFIER=0 $nun_zero; see logs/nun-*" "#1693"
fi

# 20bo. The first line of `humanish run` when the run's own result is ok and its explicit analysis
# did not complete (#1685): a live scripted run on a loopback page (20t's page, no model) whose
# review.analysis.maxCostUsd is 0.01, so admission refuses the analysis before any request. It
# reads "live run finished; the analysis did not complete", exit 2. 0.115.0 said "live run
# failed". Needs a Chrome or Chromium on PATH, as 20t does.
timeout 300 node "$work/signup-app.mjs" >"$work/logs/header-app.port" 2>&1 &
header_app_pid=$!
for _ in $(seq 1 50); do
  [ -s "$work/logs/header-app.port" ] && break
  sleep 0.1
done
header_port=$(head -n 1 "$work/logs/header-app.port")
cat >"$project/humanish/studies/scripted-cent-cap.yaml" <<YAML
schema: humanish.study.v3
id: scripted-cent-cap
title: Scripted signup, analysis capped at one cent
route: scripted
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:$header_port
actor:
  type: scripted-browser
  persona: synthetic-new-user
scenario: verify-signup
execution:
  target: local
  timeoutMs: 120000
review:
  analysis:
    maxCostUsd: 0.01
YAML
hx run scripted-cent-cap --no-open >"$work/logs/header-run.out" 2>"$work/logs/header-run.err"
hdr_exit=$?
kill "$header_app_pid" 2>/dev/null
wait "$header_app_pid" 2>/dev/null
rm -f "$project/humanish/studies/scripted-cent-cap.yaml"
hdr_first=$(head -n 1 "$work/logs/header-run.out")
if [ "$hdr_exit" = 2 ] && [ "$hdr_first" = "humanish run scripted-cent-cap: live run finished; the analysis did not complete" ] &&
  grep -q '^analysis: refused before it started\. ' "$work/logs/header-run.out"; then
  record "run: header when only the explicit analysis did not complete" PASS "'live run finished; the analysis did not complete', exit 2; analysis refused at the \$0.01 cap" "#1685"
else
  record "run: header when only the explicit analysis did not complete" FAIL "exit $hdr_exit, first line '${hdr_first}'; see logs/header-run.*" "#1685"
fi

# 20bp. A desktop-cli dry run (#1711, #1716): the run output's subject line names the product and
# source, and run.json records subject.source desktop-cli with the product. 0.115.0 printed an
# empty `subject: ` and recorded app-url. verify grades the run share_ready on both. The study is
# removed after.
cat >"$project/humanish/studies/desktop-cli-dry.yaml" <<'YAML'
schema: humanish.study.v3
id: desktop-cli-dry
title: A terminal product on a hosted desktop, dry run
route: computer-use
mode: dry-run
subject:
  source: desktop-cli
  product:
    name: humanish
    install: >-
      sudo -n npm install -g humanish@latest && mkdir -p /home/user/project && cd
      /home/user/project && humanish init --yes
    workdir: /home/user/project
    publicSurfaces:
      - https://www.npmjs.com/package/humanish
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Open the tool's interactive terminal interface, find out which studies the project holds, then
    stop and say what you found.
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx run desktop-cli-dry --run-id desktop-cli-dry --no-open >"$work/logs/desktop-cli-dry.out" 2>"$work/logs/desktop-cli-dry.err"
dcd_exit=$?
dcd_subject=$(json_field "$project/.humanish/runs/desktop-cli-dry/run.json" '[d.subject && d.subject.source, d.subject && d.subject.product].join(" ")')
hx verify --run desktop-cli-dry --json >"$work/logs/desktop-cli-dry-verify.json" 2>"$work/logs/desktop-cli-dry-verify.err"
dcd_verify="$?:$(json_field "$work/logs/desktop-cli-dry-verify.json" 'd.shareSafety && d.shareSafety.status')"
rm -f "$project/humanish/studies/desktop-cli-dry.yaml"
if [ "$dcd_exit" = 0 ] && grep -qxF "subject: humanish (desktop-cli)" "$work/logs/desktop-cli-dry.out" && [ "$dcd_subject" = "desktop-cli humanish" ] && [ "$dcd_verify" = "0:share_ready" ]; then
  record "run: desktop-cli dry run names its product; run.json subject desktop-cli" PASS "subject: humanish (desktop-cli); run.json desktop-cli/humanish; verify share_ready" "#1711, #1716"
else
  record "run: desktop-cli dry run names its product; run.json subject desktop-cli" FAIL "exit $dcd_exit, '$(grep -m1 '^subject:' "$work/logs/desktop-cli-dry.out")', run.json '${dcd_subject}', verify '${dcd_verify}'; see logs/desktop-cli-dry*" "#1711, #1716"
fi

# 20bq. A live study refused before its run is created, here try-live with no keys, ends its output
# with the refusal and its code and prints no `analysis:` line (#1711). 0.115.0 printed "analysis:
# skipped because the run's evidence could not be read".
hx run try-live --no-open >"$work/logs/keyless-header.out" 2>"$work/logs/keyless-header.err"
kh_exit=$?
kh_analysis=$(grep -c '^analysis:' "$work/logs/keyless-header.out" "$work/logs/keyless-header.err" | awk -F: '{s += $NF} END {print s}')
if [ "$kh_exit" = 2 ] && grep -qxF "run: not-created" "$work/logs/keyless-header.out" && [ "$kh_analysis" = 0 ] &&
  grep -qxF "code: HUMANISH_COMPUTER_USE_KEYS_MISSING" "$work/logs/keyless-header.out" "$work/logs/keyless-header.err"; then
  record "run: a keyless live run prints no analysis line" PASS "exit 2, run: not-created, code HUMANISH_COMPUTER_USE_KEYS_MISSING, no analysis: line" "#1711"
else
  record "run: a keyless live run prints no analysis line" FAIL "exit $kh_exit, analysis lines $kh_analysis; see logs/keyless-header.*" "#1711"
fi

# 20br. verify's bounded reads (#1691), on dry runs given fixtures here: a 33 MiB text file under
# extras/ is listed under UNSCANNED_ARTIFACT and the run grades local_only; a run with one more
# file than its entry limit stops its scan at that limit, listed there too; a folder with mode 000 fails the run
# storage check, blocked, as it does on 0.115.0 (the storage walk lists every folder before the
# scan reaches it). 0.115.0 graded the first two share_ready. The large file and the many files
# are removed and the folder's mode restored after: `observe --all --safe` (row 21) verifies every
# run in the project, and 0.123.0's verify of 30,001 small files takes about 38 s. From 0.123.0 the limit is 10,000 entries plus 5,000 for each
# participant run.json records (#1774); before, it was 10,000 for every run.
hx run first-run --run-id bounded-large --no-open --json >"$work/logs/bounded-large-run.json" 2>"$work/logs/bounded-large-run.err"
hx run first-run --run-id bounded-many --no-open --json >"$work/logs/bounded-many-run.json" 2>"$work/logs/bounded-many-run.err"
hx run first-run --run-id bounded-locked --no-open --json >"$work/logs/bounded-locked-run.json" 2>"$work/logs/bounded-locked-run.err"
br_large="$project/.humanish/runs/bounded-large/extras/large.txt"
mkdir -p "$(dirname "$br_large")" "$project/.humanish/runs/bounded-many/extras/many" "$project/.humanish/runs/bounded-locked/extras/locked"
head -c $((33 * 1024 * 1024)) /dev/zero | tr '\0' 'a' >"$br_large"
br_limit=$(json_field "$project/.humanish/runs/bounded-many/run.json" '10000 + 5000 * d.simulations.length')
br_limit=${br_limit:-10000}
(cd "$project/.humanish/runs/bounded-many/extras/many" && seq 1 $((br_limit + 1)) | xargs -n 500 sh -c 'for i; do printf "n%s\n" "$i" >"f$i.txt"; done' _)
printf 'synthetic note\n' >"$project/.humanish/runs/bounded-locked/extras/locked/a.txt"
chmod 000 "$project/.humanish/runs/bounded-locked/extras/locked"
br_view=""
for id in bounded-large bounded-many bounded-locked; do
  hx verify --run "$id" --json >"$work/logs/$id-verify.json" 2>"$work/logs/$id-verify.err"
  br_view="$br_view $id:$?:$(json_field "$work/logs/$id-verify.json" '[d.shareSafety && d.shareSafety.status, (d.shareSafety && d.shareSafety.reasons || []).map((r) => r.code).join("+")].join(",")')"
  hx verify --run "$id" >"$work/logs/$id-verify.txt" 2>&1
done
chmod 700 "$project/.humanish/runs/bounded-locked/extras/locked"
rm -f "$br_large"
rm -rf "${project:?}/.humanish/runs/bounded-many/extras/many"
if [ "$br_view" = " bounded-large:0:local_only,UNSCANNED_ARTIFACT bounded-many:0:local_only,UNSCANNED_ARTIFACT bounded-locked:2:blocked,VERIFY_FAILED" ] &&
  grep -qF "extras/large.txt" "$work/logs/bounded-large-verify.txt" &&
  grep -qF "extras/many/" "$work/logs/bounded-many-verify.txt" &&
  grep -qxF -- "- run storage must contain only identity-bound directories and single-link regular files" "$work/logs/bounded-locked-verify.txt"; then
  record "verify: 33 MiB file and limit+1 entries unscanned; mode-000 folder blocked" PASS "local_only, UNSCANNED_ARTIFACT naming extras/large.txt and the ${br_limit}-entry stop; locked folder fails storage, blocked" "#1691"
else
  record "verify: 33 MiB file and limit+1 entries unscanned; mode-000 folder blocked" FAIL "'${br_view}'; see logs/bounded-*" "#1691"
fi

# 20bs. In the TUI, a live start of a study whose file says `mode: dry-run` is blocked (#1698): in
# 20bj's fresh project, cua-browser (the first row) opens, its live row reads `needs mode: live`,
# and Enter on it names the file to change. The driver waits 4 s after opening the study and
# after moving to the live row (W), so the study's summary is read before Enter. Nothing else is pressed, so nothing starts. 0.115.0
# armed the live start, which would have started a dry run on a second Enter; this row presses
# Enter once.
cat >"$work/tui_keys.py" <<'PTY'
import fcntl, os, pty, re, select, signal, struct, sys, termios, time
cwd, out, keys = sys.argv[1], sys.argv[2], sys.argv[3]
rest = sys.argv[4:]
sep = rest.index("--")
env = dict(kv.split("=", 1) for kv in rest[:sep])
argv = rest[sep + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
os.kill(pid, signal.SIGWINCH)
buf = b""
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
pump(10)
for key in keys:
    if key == "W":
        pump(4)
        continue
    os.write(fd, b"\r" if key == "E" else key.encode())
    pump(1.5)
pump(3)
mark = len(buf)
os.write(fd, b"q")
pump(2)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
plain = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r", b"", buf[:mark])
open(out, "wb").write(plain)
PTY
timeout 90 python3 "$work/tui_keys.py" "$tui_project" "$work/logs/tui-dry-file.txt" gEWjWE "${pty_env[@]}" -- npx -y --package "$spec" humanish tui >"$work/logs/tui-dry-file.result" 2>&1
tdf_text=$(sed -n '/studies \/ cua-browser/,$p' "$work/logs/tui-dry-file.txt" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
tdf_runs=$(find "$tui_project/.humanish/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
if grep -qF 'needs mode: live' <<<"$tdf_text" && grep -qF 'Set mode: live in humanish/studies/cua-browser.yaml to start a live run.' <<<"$tdf_text" &&
  ! grep -qF 'start a live run?' <<<"$tdf_text" && [ "$tdf_runs" = 0 ]; then
  record "tui: live start of a mode: dry-run study names the file to change" PASS "needs mode: live; 'Set mode: live in humanish/studies/cua-browser.yaml'; nothing armed or started" "#1698"
else
  record "tui: live start of a mode: dry-run study names the file to change" FAIL "text '$(grep -o 'Start a live run[^>]*' <<<"$tdf_text" | head -c 160)'; runs $tdf_runs; see logs/tui-dry-file.txt" "#1698"
fi

# 20bt-20bx: 0.117.0 (#1724, #1727, #1736). A participant's long wait on a hosted desktop, the length
# of an OpenAI wait with no duration and a serve.build bash cannot parse need a live run; this
# check does not make one.

# 20bt. actor.maxWaitMs (#1724): a computer-use dry run with 90000 plans; 999 and 3600001 are refused
# before a run is created with the range. 0.116.0 refuses all three as an unknown actor field. From
# 0.131.0 the range reaches 3600000, the longest the watch of repeated idle turns grows.
wait_cu_study() { # id, extra actor lines
  cat >"$project/humanish/studies/$1.yaml" <<YAML
schema: humanish.study.v3
id: $1
title: A computer-use dry run with a wait setting
route: computer-use
mode: dry-run
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Wait on the page until it changes, then stop and say what it shows.
$2
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
}
mw_view=""
for v in 90000 999 3600001; do
  wait_cu_study "wait-max-$v" "  maxWaitMs: $v"
  hx run "wait-max-$v" --no-open >"$work/logs/wait-max-$v.out" 2>"$work/logs/wait-max-$v.err"
  mw_view="$mw_view $v:$?"
  rm -f "$project/humanish/studies/wait-max-$v.yaml"
done
mw_range="actor.maxWaitMs, the longest one wait or one turn of only waits lasts, must be a whole number of milliseconds from 1000 to 3600000."
if [ "$mw_view" = " 90000:0 999:2 3600001:2" ] && grep -qxF "humanish run wait-max-90000: dry run finished" "$work/logs/wait-max-90000.out" &&
  grep -qF "$mw_range" "$work/logs/wait-max-999.out" "$work/logs/wait-max-999.err" &&
  grep -qF "$mw_range" "$work/logs/wait-max-3600001.out" "$work/logs/wait-max-3600001.err"; then
  record "run: actor.maxWaitMs 90000 plans; 999 and 3600001 refused with the range" PASS "exits 0, 2, 2; the refusal names 1000 to 3600000" "#1724"
else
  record "run: actor.maxWaitMs 90000 plans; 999 and 3600001 refused with the range" FAIL "exits '${mw_view}', '$(grep -ho 'Unknown study field[^.]*\|actor.maxWaitMs[^.]*' "$work/logs/wait-max-999.out" "$work/logs/wait-max-999.err" | head -n 1)'; see logs/wait-max-*" "#1724"
fi

# 20bu. A terminal study, whose participants take no wait actions, that sets actor.maxWaitMs or
# actor.idleWaitMs is refused as a field its route does not read (#1724, #1736). 0.116.0 refuses
# both as unknown actor fields. The same study without the fields passes study check on both.
term_study() { # id, extra actor lines
  cat >"$project/humanish/studies/$1.yaml" <<YAML
schema: humanish.study.v3
id: $1
title: A terminal dry run
route: terminal
mode: dry-run
subject:
  source: terminal-product
  product:
    name: humanish
    publicSurfaces:
      - https://www.npmjs.com/package/humanish
actor:
  type: codex-exec
  persona: autonomous-coding-agent
  mission: >-
    Find out what the tool does from its public pages, then stop and say what you found.
$2
caps:
  maxUsd: 0
  maxMinutes: 10
execution:
  target: e2b-terminal
YAML
}
tw_view=""
for f in none maxWaitMs idleWaitMs; do
  if [ "$f" = none ]; then term_study "wait-term-$f" ""; else term_study "wait-term-$f" "  $f: 60000"; fi
  hx study check "wait-term-$f" >"$work/logs/wait-term-$f.out" 2>"$work/logs/wait-term-$f.err"
  tw_view="$tw_view $f:$?"
  rm -f "$project/humanish/studies/wait-term-$f.yaml"
done
if [ "$tw_view" = " none:0 maxWaitMs:2 idleWaitMs:2" ] &&
  grep -qF "does not read actor.maxWaitMs" "$work/logs/wait-term-maxWaitMs.out" "$work/logs/wait-term-maxWaitMs.err" &&
  grep -qF "does not read actor.idleWaitMs" "$work/logs/wait-term-idleWaitMs.out" "$work/logs/wait-term-idleWaitMs.err"; then
  record "study check: a terminal study that sets a wait field is refused as unread" PASS "no field exit 0; maxWaitMs and idleWaitMs exit 2, 'does not read actor.<field>'" "#1724, #1736"
else
  record "study check: a terminal study that sets a wait field is refused as unread" FAIL "exits '${tw_view}', '$(grep -ho 'Unknown study field[^.]*\|does not read[^.]*' "$work/logs/wait-term-maxWaitMs.out" "$work/logs/wait-term-maxWaitMs.err" | head -n 1)'; see logs/wait-term-*" "#1724, #1736"
fi

# 20bv. actor.idleWaitMs (#1736): 15000 plans; above an explicit actor.maxWaitMs it is refused with
# both values. 0.116.0 refuses both as an unknown actor field.
wait_cu_study wait-idle-15000 "  idleWaitMs: 15000"
hx run wait-idle-15000 --no-open >"$work/logs/wait-idle-15000.out" 2>"$work/logs/wait-idle-15000.err"
wi_ok=$?
wait_cu_study wait-idle-over "  maxWaitMs: 45000
  idleWaitMs: 60000"
hx run wait-idle-over --no-open >"$work/logs/wait-idle-over.out" 2>"$work/logs/wait-idle-over.err"
wi_over=$?
rm -f "$project/humanish/studies/wait-idle-15000.yaml" "$project/humanish/studies/wait-idle-over.yaml"
wi_msg="actor.idleWaitMs (60000) is longer than actor.maxWaitMs (45000), the longest one wait or one turn of only waits lasts. Lower actor.idleWaitMs or raise actor.maxWaitMs."
if [ "$wi_ok" = 0 ] && [ "$wi_over" = 2 ] && grep -qF "$wi_msg" "$work/logs/wait-idle-over.out" "$work/logs/wait-idle-over.err"; then
  record "run: actor.idleWaitMs plans; above actor.maxWaitMs it is refused" PASS "15000 exit 0; 60000 over 45000 exit 2 naming both" "#1736"
else
  record "run: actor.idleWaitMs plans; above actor.maxWaitMs it is refused" FAIL "15000 exit $wi_ok, over exit $wi_over, '$(grep -ho 'Unknown study field[^.]*\|actor.idleWaitMs[^.]*' "$work/logs/wait-idle-over.out" "$work/logs/wait-idle-over.err" | head -n 1)'; see logs/wait-idle-*" "#1736"
fi

# 20bw. The wait fields in a study as the CLI reads them (#1724, #1736): `study show --json` on a
# computer-use dry run that sets actor.maxWaitMs 90000 and actor.idleWaitMs 15000 reports both
# under config.actor, and the dry run itself writes no participant trace, so it records no
# waitSettings (only a live session records them, in actor.json). 0.116.0 refuses the study file.
wait_cu_study wait-settings-set "  maxWaitMs: 90000
  idleWaitMs: 15000"
hx study show wait-settings-set --json >"$work/logs/wait-settings-show.json" 2>"$work/logs/wait-settings-show.err"
ws_show_exit=$?
hx run wait-settings-set --run-id wait-settings-set --no-open >"$work/logs/wait-settings-set.out" 2>"$work/logs/wait-settings-set.err"
ws_run_exit=$?
rm -f "$project/humanish/studies/wait-settings-set.yaml"
ws_show=$(json_field "$work/logs/wait-settings-show.json" 'd.config && d.config.actor && [d.config.actor.maxWaitMs, d.config.actor.idleWaitMs].join("/")')
ws_traces=$(find "$project/.humanish/runs/wait-settings-set" -maxdepth 1 -name 'actor*.json' 2>/dev/null | wc -l)
ws_hits=$(grep -rl 'waitSettings' "$project/.humanish/runs/wait-settings-set" 2>/dev/null | wc -l)
if [ "$ws_show_exit" = 0 ] && [ "$ws_show" = "90000/15000" ] && [ "$ws_run_exit" = 0 ] && [ "$ws_traces" = 0 ] && [ "$ws_hits" = 0 ]; then
  record "study show: the wait fields; a computer-use dry run records no waitSettings" PASS "config.actor 90000/15000; dry run exit 0 with no participant trace" "#1724, #1736"
else
  record "study show: the wait fields; a computer-use dry run records no waitSettings" FAIL "show exit $ws_show_exit '${ws_show}', run exit $ws_run_exit, traces $ws_traces, waitSettings files $ws_hits; see logs/wait-settings-*" "#1724, #1736"
fi

# 20bx. In the TUI, an armed confirmation ends when the screen leaves it (#1727): in an empty
# directory the TUI offers "Set up humanish here"; Enter arms it, `?` opens the shortcuts and `?`
# returns, and the next Enter arms it again and writes nothing. 0.116.0 kept the arming, so that
# Enter ran init and wrote humanish/. The directory is removed after.
setup_dir="$work/tui-setup"
mkdir -p "$setup_dir"
printf '{ "name": "tui-setup", "private": true }\n' >"$setup_dir/package.json"
timeout 90 python3 "$work/tui_keys.py" "$setup_dir" "$work/logs/tui-setup.txt" "EW?W?WE" "${pty_env[@]}" -- npx -y --package "$spec" humanish tui >"$work/logs/tui-setup.result" 2>&1
ts_dir=no
[ -e "$setup_dir/humanish" ] && ts_dir=yes
ts_pkg=$(json_field "$setup_dir/package.json" 'Object.keys(d).join(",")')
ts_armed=$(grep -c 'Enter again to confirm' "$work/logs/tui-setup.txt")
ts_help=$(grep -c 'Keyboard shortcuts' "$work/logs/tui-setup.txt")
rm -rf "${setup_dir:?}"
if [ "$ts_dir" = no ] && [ "$ts_pkg" = "name,private" ] && [ "$ts_armed" -ge 1 ] && [ "$ts_help" -ge 1 ]; then
  record "tui: Set up humanish here disarms when the shortcuts open" PASS "Enter, ?, ?, Enter: armed again, nothing written" "#1727"
else
  record "tui: Set up humanish here disarms when the shortcuts open" FAIL "humanish/ written $ts_dir, package.json keys '${ts_pkg}', armed lines $ts_armed, help $ts_help; see logs/tui-setup.txt" "#1727"
fi

# 20by-20cd: 0.118.0 (#1733, #1735, #1739). Participants past 16 on hosted desktops, waves at the
# concurrent-sandbox limit, the analysis skip on a live run, the analysis line's admitted range and
# the TUI's key entry need a live run or a person at a terminal, which this check does not use.

# 20by. doctor's `e2b concurrent sandboxes` row (#1739): 20 at once by default, the setting's value
# when HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES is set, and a failed row with exit 2 for a value it
# cannot read. 0.117.0 has no such row.
hx doctor >"$work/logs/concurrent-doctor.out" 2>"$work/logs/concurrent-doctor.err"
(cd "$project" && timeout 600 "${run_env[@]}" HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES=100 npx -y --package "$spec" humanish doctor) >"$work/logs/concurrent-doctor-100.out" 2>"$work/logs/concurrent-doctor-100.err"
(cd "$project" && timeout 600 "${run_env[@]}" HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES=lots npx -y --package "$spec" humanish doctor) >"$work/logs/concurrent-doctor-lots.out" 2>"$work/logs/concurrent-doctor-lots.err"
cc_bad_exit=$?
cc_def=$(grep -cxF -e "- ok e2b concurrent sandboxes: 20 at once, E2B's Hobby limit. On a plan that runs more (Pro runs 100), set HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES to that plan's limit." "$work/logs/concurrent-doctor.out")
cc_100=$(grep -c '^- ok e2b concurrent sandboxes: 100 at once, from HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES\.' "$work/logs/concurrent-doctor-100.out")
cc_bad=$(grep -cF -e '- missing e2b concurrent sandboxes: HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES must be a whole number of 1 or more (got "lots").' "$work/logs/concurrent-doctor-lots.out")
if [ "$cc_def" = 1 ] && [ "$cc_100" = 1 ] && [ "$cc_bad" = 1 ] && [ "$cc_bad_exit" = 2 ]; then
  record "doctor: e2b concurrent sandboxes row" PASS "20 at once by default; 100 from the setting; lots fails the row, exit 2" "#1739"
else
  record "doctor: e2b concurrent sandboxes row" FAIL "default $cc_def, 100 $cc_100, lots $cc_bad exit $cc_bad_exit; see logs/concurrent-doctor*" "#1739"
fi

# 20bz. How many participants a computer-use study may have (#1739): a dry run of 17 participants
# finishes, `study check` of the same live study gives the expected cost of its 2 cohort requests
# and one merge request under the default $10 cap (#1742; 0.118.0 said automatic analysis will not
# run for more than 16 participants, and the old $3 default refused it even with no evidence), and
# 101 participants are refused naming 100. 0.117.0 refuses 17 and 101 at 16 participants.
crowd_study() { # id, participants, extra execution lines
  cat >"$project/humanish/studies/$1.yaml" <<YAML
schema: humanish.study.v3
id: $1
title: A computer-use study of $2 participants
route: computer-use
mode: live
participants: $2
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Look at the page that is open in the browser, then stop and say what it is for.
execution:
  target: e2b-desktop
  timeoutMs: 600000
$3
YAML
}
crowd_study crowd-17 17 ""
crowd_study crowd-101 101 ""
hx run crowd-17 --dry-run --run-id crowd-17 --no-open >"$work/logs/crowd-17.out" 2>"$work/logs/crowd-17.err"
c17_run=$?
hx study check crowd-17 >"$work/logs/crowd-17-check.out" 2>"$work/logs/crowd-17-check.err"
c17_check=$?
hx run crowd-101 --dry-run --no-open >"$work/logs/crowd-101.out" 2>"$work/logs/crowd-101.err"
c101_run=$?
c17_sims=$(json_field "$project/.humanish/runs/crowd-17/run.json" 'd.simCount')
rm -f "$project/humanish/studies/crowd-17.yaml" "$project/humanish/studies/crowd-101.yaml"
c17_line="After live runs: default analysis · gpt-6.1-sol at medium effort · expected \$0.92 to \$2.14 for 17 participants in 2 cohort requests of at most 16 participants and one merge request, depending on how much evidence the run keeps · refused before it starts if both its worst case and its expected cost plus a 10% margin are over \$10; this is not a billing cap. Set review.analysis: false to disable."
if [ "$c17_run" = 0 ] && [ "$c17_sims" = 17 ] && [ "$c17_check" = 0 ] && grep -qxF "$c17_line" "$work/logs/crowd-17-check.out" &&
  [ "$c101_run" = 2 ] && grep -qF "at most 100 participants" "$work/logs/crowd-101.out" "$work/logs/crowd-101.err" && grep -qF "has 101" "$work/logs/crowd-101.out" "$work/logs/crowd-101.err"; then
  record "run: 17 participants plan, cohort analysis admitted at the default cap; 101 refused" PASS "17: dry run exit 0, simCount 17, study check names 2 cohort requests and one merge request at \$0.92 to \$2.14 under \$10; 101: exit 2, at most 100" "#1739, #1742"
else
  record "run: 17 participants plan, cohort analysis admitted at the default cap; 101 refused" FAIL "17 run exit $c17_run simCount '${c17_sims}', check exit $c17_check; 101 exit $c101_run '$(grep -ho 'at most [0-9]* participants[^.]*' "$work/logs/crowd-101.out" "$work/logs/crowd-101.err" | head -n 1)'; see logs/crowd-*" "#1739, #1742"
fi

# 20ca. execution.concurrency above the concurrent-sandbox limit (#1739): 24 participants with
# `execution.concurrency: 24` are refused at the default limit of 20, naming the setting value that
# admits them, and plan with HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES=100. 0.117.0 refuses both at 16
# participants.
crowd_study crowd-24-at-once 24 "  concurrency: 24"
hx run crowd-24-at-once --dry-run --no-open >"$work/logs/crowd-24-at-once.out" 2>"$work/logs/crowd-24-at-once.err"
c24_def=$?
(cd "$project" && timeout 600 "${run_env[@]}" HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES=100 npx -y --package "$spec" humanish run crowd-24-at-once --dry-run --no-open) >"$work/logs/crowd-24-at-once-100.out" 2>"$work/logs/crowd-24-at-once-100.err"
c24_100=$?
rm -f "$project/humanish/studies/crowd-24-at-once.yaml"
if [ "$c24_def" = 2 ] && grep -qF "execution.concurrency runs 24 participants at once, and humanish runs at most 20 sandboxes at once" "$work/logs/crowd-24-at-once.out" "$work/logs/crowd-24-at-once.err" &&
  grep -qF "set HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES to 24 or more." "$work/logs/crowd-24-at-once.out" "$work/logs/crowd-24-at-once.err" &&
  [ "$c24_100" = 0 ] && grep -qF "24 participants, strategy per-lane-worlds, concurrency 24, 1 wave." "$work/logs/crowd-24-at-once-100.out" "$work/logs/crowd-24-at-once-100.err"; then
  record "run: execution.concurrency 24 refused at 20, planned at 100" PASS "exit 2 naming HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES to 24 or more; exit 0, 24 at once, at 100" "#1739"
else
  record "run: execution.concurrency 24 refused at 20, planned at 100" FAIL "default exit $c24_def '$(grep -ho 'execution.concurrency runs[^.]*\|at most [0-9]* participants[^.]*' "$work/logs/crowd-24-at-once.out" "$work/logs/crowd-24-at-once.err" | head -n 1)', 100 exit $c24_100 '$(grep -ho 'concurrency [0-9]*, [0-9]* waves\?' "$work/logs/crowd-24-at-once-100.out" "$work/logs/crowd-24-at-once-100.err" | head -n 1)'; see logs/crowd-24-at-once*" "#1739"
fi

# 20cb. `study check` plans the study as `run` does (#1733): a study whose sandbox deadline is 90
# minutes (an app-url session of 80 minutes plus the 10-minute teardown buffer) fails the check
# with a plan row and the run's code, as `run` refuses it. 0.117.0 passes the check.
cat >"$project/humanish/studies/check-ninety.yaml" <<'YAML'
schema: humanish.study.v3
id: check-ninety
title: A study whose sandbox deadline is 90 minutes
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Look at the page that is open in the browser, then stop and say what it is for.
execution:
  target: e2b-desktop
  timeoutMs: 4800000
YAML
hx study check check-ninety >"$work/logs/check-ninety.out" 2>"$work/logs/check-ninety.err"
ck_exit=$?
hx study check check-ninety --json >"$work/logs/check-ninety.json" 2>"$work/logs/check-ninety-json.err"
rm -f "$project/humanish/studies/check-ninety.yaml"
if [ "$ck_exit" = 2 ] && grep -q '^- fail plan: .*derives a 90m sandbox deadline, and a sandbox may not live longer than 60m\.' "$work/logs/check-ninety.out" &&
  grep -qF "set HUMANISH_E2B_MAX_SANDBOX_MINUTES to 90 or more." "$work/logs/check-ninety.out"; then
  record "study check: a 90-minute sandbox deadline fails the plan row" PASS "exit 2, '- fail plan' naming the 90m deadline and the setting" "#1733"
else
  record "study check: a 90-minute sandbox deadline fails the plan row" FAIL "exit $ck_exit, '$(grep -m1 'plan\|derives' "$work/logs/check-ninety.out" | cut -c1-120)'; see logs/check-ninety*" "#1733"
fi

# 20cc. A library dry run of a local-app study on the in-process route records
# subject.source local-app in run.json, the result and each participant's subject, and verify
# reads the run (#1733, #1716). 0.117.0 recorded app-url.
cat >"$lib/local-app.mjs" <<'JS'
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStudy, runStudy, verifyRun } from "humanish";
const cwd = mkdtempSync(join(process.env.LOCAL_APP_DIR, "run-"));
const parsed = parseStudy({
  schema: "humanish.study.v3",
  id: "local-app-dry",
  route: "computer-use",
  subject: { source: "local-app", appUrl: "http://localhost:5173/" },
  actor: { type: "openai-computer-use", persona: "first-time-visitor", mission: "Look around and stop." },
  review: { analysis: false },
});
if (!parsed.ok) throw new Error(parsed.error.message);
const outcome = await runStudy(parsed.config, {
  cwd,
  dryRun: true,
  env: {},
  inProcess: { executor: async () => { throw new Error("a dry run creates no executor"); } },
  createProvider: async () => { throw new Error("a dry run creates no provider"); },
});
const { result } = outcome;
const runJson = JSON.parse(readFileSync(join(cwd, ".humanish/runs", result.runId, "run.json"), "utf8"));
const verified = await verifyRun(cwd, result.runId);
console.log([
  `ok=${result.ok}`,
  `runjson=${runJson.subject?.source}`,
  `result=${result.subject?.source}`,
  `lanes=${(result.lanes ?? []).map((lane) => lane.subject?.source).join("+")}`,
  `verifyFailed=${verified.checks.filter((check) => !check.ok).length}`,
].join(" "));
JS
mkdir -p "$work/local-app"
local_app=$(cd "$lib" && timeout 120 "${run_env[@]}" LOCAL_APP_DIR="$work/local-app" node local-app.mjs 2>"$work/logs/local-app.err")
echo "$local_app" >"$work/logs/local-app.out"
if [ "$local_app" = "ok=true runjson=local-app result=local-app lanes=local-app verifyFailed=0" ]; then
  record "library: a local-app in-process dry run records subject.source local-app" PASS "run.json, result and lanes local-app; verify 0 failed checks" "#1733, #1716"
else
  record "library: a local-app in-process dry run records subject.source local-app" FAIL "'${local_app}'; see logs/local-app.*" "#1733, #1716"
fi

# 20cd. verify names where the public-safety scan stopped in its own sentence (#1733, #1691), on
# 20br's run with its entry limit plus one more files under extras/many/. 0.117.0 counted the folder as a file it
# could not read: "extras/many/ (the scan stops after 10000 entries)".
if grep -qF "The public-safety scan stopped at its limit of ${br_limit} files and folders while listing extras/many/, so it read nothing listed after that point." "$work/logs/bounded-many-verify.txt" &&
  ! grep -qF "(the scan stops after 10000 entries)" "$work/logs/bounded-many-verify.txt"; then
  record "verify: the entry-limit stop in its own sentence" PASS "stopped at its limit of ${br_limit} files and folders while listing extras/many/" "#1733, #1691"
else
  record "verify: the entry-limit stop in its own sentence" FAIL "'$(grep -ho 'UNSCANNED_ARTIFACT:[^.]*' "$work/logs/bounded-many-verify.txt" | head -n 1 | cut -c1-160)'; see logs/bounded-many-verify.txt" "#1733, #1691"
fi

# 20ce-20ci: 0.119.0 (#1742, #1745). Participants arriving on a live run, the budget skip, the
# cohort analysis of a live run and a wait for a slot need a live run, which this check does not
# make.

arrive_study() { # id, participants lines
  cat >"$project/humanish/studies/$1.yaml" <<YAML
schema: humanish.study.v3
id: $1
title: Participants who arrive over time
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Look at the page that is open in the browser, then stop and say what it is for.
execution:
  target: e2b-desktop
  timeoutMs: 600000
participants:
$2
YAML
}

# 20ce. Participants arriving over time (#1745): two support agents from the start and six
# customers from the second minute, five minutes apart. `study check` prints the schedule row, a
# dry run's plan prints the schedule line, and run.json records each participant's arrival offset.
# 0.118.0 refuses startAfterMs and startEveryMs as unknown fields.
arrive_study arrive "  - id: support-agent
    count: 2
  - id: customer
    count: 6
    startAfterMs: 120000
    startEveryMs: 300000"
hx study check arrive >"$work/logs/arrive-check.out" 2>"$work/logs/arrive-check.err"
ar_check=$?
hx run arrive --dry-run --run-id arrive --no-open >"$work/logs/arrive-run.out" 2>"$work/logs/arrive-run.err"
ar_run=$?
ar_offsets=$(json_field "$project/.humanish/runs/arrive/run.json" '(d.simulations||[]).map((s)=>s.arrival&&s.arrival.startAfterMs).join(",")')
rm -f "$project/humanish/studies/arrive.yaml"
ar_sched="the first participant starts at +0s and the last at +27m; at most 4 run at once when every session uses its 10m budget."
if [ "$ar_check" = 0 ] && grep -qxF -e "- ok schedule: $ar_sched" "$work/logs/arrive-check.out" &&
  [ "$ar_run" = 0 ] && grep -qxF "  schedule: $ar_sched" "$work/logs/arrive-run.err" &&
  [ "$ar_offsets" = "0,0,120000,420000,720000,1020000,1320000,1620000" ]; then
  record "study: startAfterMs and startEveryMs schedule" PASS "study check and the plan: first +0s, last +27m, at most 4 at once; run.json offsets 0 to 1620000" "#1745"
else
  record "study: startAfterMs and startEveryMs schedule" FAIL "check exit $ar_check, run exit $ar_run, offsets '${ar_offsets}', '$(grep -ho 'schedule[^;]*\|Unknown study field[^.]*' "$work/logs/arrive-check.out" "$work/logs/arrive-run.err" | head -n 1 | cut -c1-120)'; see logs/arrive-*" "#1745"
fi

# 20cf. Start refusals (#1745): a start past 24 hours, a group whose last member passes 24 hours,
# startEveryMs without count, and a start on a study of one participant. Each fails study check
# with HUMANISH_STUDY_INVALID. 0.118.0 refuses all four as unknown fields.
arrive_study start-big "  - id: a
  - id: b
    startAfterMs: 86400001"
arrive_study start-past "  - id: wave
    count: 3
    startAfterMs: 86000000
    startEveryMs: 300000"
arrive_study start-nocount "  - id: a
  - id: b
    startEveryMs: 1000"
arrive_study start-one "  - id: solo
    startAfterMs: 1000"
sr_ok=0
sr_seen=""
for sr in \
  "start-big|participants[1].startAfterMs must be a whole number of milliseconds from 0 to 86400000 (24 hours)" \
  "start-past|participants[0] starts its last member, wave-03, 86600000 ms after the run starts its participants, and a start must be at most 86400000 ms (24 hours)." \
  "start-nocount|participants[1].startEveryMs spreads a group's members over time, so it needs \`count\` on the same entry." \
  "start-one|\`startAfterMs\` sets when a participant starts relative to the others, so it needs two or more participants, and this study has one."; do
  sr_id=${sr%%|*}
  sr_text=${sr#*|}
  hx study check "$sr_id" >"$work/logs/$sr_id.out" 2>"$work/logs/$sr_id.err"
  sr_exit=$?
  rm -f "$project/humanish/studies/$sr_id.yaml"
  if [ "$sr_exit" = 2 ] && grep -qF -e "$sr_text" "$work/logs/$sr_id.out" "$work/logs/$sr_id.err" &&
    grep -q '^code: HUMANISH_STUDY_INVALID' "$work/logs/$sr_id.out" "$work/logs/$sr_id.err"; then
    sr_ok=$((sr_ok + 1))
  fi
  sr_seen="$sr_seen $sr_id:$sr_exit"
done
if [ "$sr_ok" = 4 ]; then
  record "study: out-of-range starts refused" PASS "86400001, a member at 86600000, startEveryMs without count, a start on one participant: exit 2, HUMANISH_STUDY_INVALID" "#1745"
else
  record "study: out-of-range starts refused" FAIL "$sr_ok of 4 matched;$sr_seen; see logs/start-*" "#1745"
fi

# 20cg. A start 3 hours in (#1745): on computer use each desktop is created at its start, so the
# plan admits it; a provisioned shared world serves the app until the last participant ends, so
# its subject sandbox would need 230 minutes and the plan refuses it at the 60-minute ceiling,
# naming the setting. 0.118.0 refuses both as unknown fields.
arrive_study late-cu "  - id: early
  - id: late
    startAfterMs: 10800000"
cat >"$project/humanish/studies/late-sw.yaml" <<'YAML'
schema: humanish.study.v3
id: late-sw
title: A provisioned shared world whose second member starts 3 hours in
route: shared-world
mode: live
subject:
  source: clone
  exposure: synthetic
  repos:
    - example-org/collab-app
  serve:
    install: pnpm install
    start: pnpm start -H 0.0.0.0
    url: http://127.0.0.1:3000/
  state:
    checkpoint:
      - name: notes-count
        command: psql query notes
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    Look at the page that is open and say what it is for, then stop.
participants:
  - id: early
  - id: late
    startAfterMs: 10800000
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx run late-cu --dry-run --no-open >"$work/logs/late-cu.out" 2>"$work/logs/late-cu.err"
lc_exit=$?
hx run late-sw --dry-run --no-open >"$work/logs/late-sw.out" 2>"$work/logs/late-sw.err"
ls_exit=$?
rm -f "$project/humanish/studies/late-cu.yaml" "$project/humanish/studies/late-sw.yaml"
if [ "$lc_exit" = 0 ] && grep -qxF "  schedule: the first participant starts at +0s and the last at +3h; at most 1 run at once when every session uses its 10m budget." "$work/logs/late-cu.err" &&
  [ "$ls_exit" = 2 ] && grep -qF "The subject sandbox, which serves the app until every participant ends, then needs a 230m deadline" "$work/logs/late-sw.err" &&
  grep -qF "set HUMANISH_E2B_MAX_SANDBOX_MINUTES to 230 or more." "$work/logs/late-sw.err" && grep -q '^code: HUMANISH_SHARED_WORLD_INVALID' "$work/logs/late-sw.err"; then
  record "run: a 3-hour start plans on computer use, refused on a provisioned shared world" PASS "computer use exit 0, last at +3h; shared world exit 2, a 230m subject deadline, HUMANISH_SHARED_WORLD_INVALID" "#1745"
else
  record "run: a 3-hour start plans on computer use, refused on a provisioned shared world" FAIL "computer use exit $lc_exit, shared world exit $ls_exit '$(grep -ho 'needs a [0-9]*m deadline\|Unknown study field[^.]*' "$work/logs/late-sw.out" "$work/logs/late-sw.err" | head -n 1)'; see logs/late-*" "#1745"
fi

# 20ch. The analysis line of 17 participants (#1742): at the default $10 cap (20bz) `study check
# --json` gives the range for 2 cohort requests and one merge request; at a $0.50 cap it says
# admission refuses them even with no evidence and gives analysis.refusedFromUsd. 0.118.0 says
# automatic analysis will not run for more than 16.
crowd_study crowd-17-cap 17 "review:
  analysis:
    maxCostUsd: 0.5"
crowd_study crowd-17-json 17 ""
hx study check crowd-17-cap >"$work/logs/crowd-17-cap.out" 2>"$work/logs/crowd-17-cap.err"
cc17_exit=$?
hx study check crowd-17-cap --json >"$work/logs/crowd-17-cap.json" 2>>"$work/logs/crowd-17-cap.err"
ccj17=$(json_field "$work/logs/crowd-17-cap.json" 'd.analysis && [d.analysis.participants, d.analysis.refusedFromUsd, d.analysis.expectedCostUsd === undefined].join(" ")')
hx study check crowd-17-json --json >"$work/logs/crowd-17-json.json" 2>"$work/logs/crowd-17-json.err"
cj17_exit=$?
cj17=$(json_field "$work/logs/crowd-17-json.json" 'd.analysis && [d.analysis.participants, d.analysis.expectedCostUsd.low.toFixed(2), d.analysis.expectedCostUsd.high.toFixed(2), d.analysis.refusedFromUsd === undefined].join(" ")')
rm -f "$project/humanish/studies/crowd-17-cap.yaml" "$project/humanish/studies/crowd-17-json.yaml"
if [ "$cc17_exit" = 0 ] && grep -qF 'After live runs: explicit analysis · gpt-6.1-sol at medium effort · refused before it starts for 17 participants in 2 cohort requests of at most 16 participants and one merge request even with no evidence (expected $0.63)' "$work/logs/crowd-17-cap.out" &&
  [ "$ccj17" = "17 0.631421 true" ] && [ "$cj17_exit" = 0 ] && [ "$cj17" = "17 0.92 2.14 true" ]; then
  record "study check: 17 participants analysed in 2 cohort requests and a merge request" PASS "default cap: expected \$0.92 to \$2.14 for 2 cohort requests and one merge request; cap 0.50: refusedFromUsd 0.631421" "#1742"
else
  record "study check: 17 participants analysed in 2 cohort requests and a merge request" FAIL "cap 3 exit $cc17_exit '$(grep -ho 'After live runs[^·]*·[^·]*·[^·]*' "$work/logs/crowd-17-cap.out" | head -n 1 | cut -c1-160)'; json exit $cj17_exit '${cj17}'; see logs/crowd-17-*" "#1742"
fi

# 20ci. analyze --dry-run --json reports admission.requests (#1742): 1 on 20t's live scripted run,
# and 3 on 20bz's 17-participant dry run marked live and complete, whose human dry run names the
# cohort and merge requests in its worst case. 0.118.0 has no requests field and reads 16 of the 17.
hx analyze --run "$off_run" --dry-run --max-cost 3 --json >"$work/logs/requests-one.json" 2>"$work/logs/requests-one.err"
rq1_exit=$?
rq1=$(json_field "$work/logs/requests-one.json" 'd.admission && d.admission.requests')
(cd "$project" && node -e '
const fs = require("fs"), path = require("path");
const root = path.join(process.cwd(), ".humanish", "runs", "crowd-17");
const bundle = JSON.parse(fs.readFileSync(path.join(root, "run.json"), "utf8"));
bundle.mode = "live";
for (const stream of bundle.streams) stream.status = "complete";
fs.writeFileSync(path.join(root, "run.json"), JSON.stringify(bundle) + "\n");
fs.rmSync(path.join(root, "status.json"), { force: true });
console.log(bundle.streams.length);') >"$work/logs/requests-cohort-mark.out" 2>&1
hx analyze --run crowd-17 --dry-run --max-cost 30 --json >"$work/logs/requests-cohort.json" 2>"$work/logs/requests-cohort.err"
rq3_exit=$?
rq3=$(json_field "$work/logs/requests-cohort.json" 'd.admission && [d.admission.requests, d.admission.allowed, d.admission.estimatedCostUsd < d.admission.worstCaseCostUsd].join(" ")')
hx analyze --run crowd-17 --dry-run --max-cost 30 >"$work/logs/requests-cohort.out" 2>>"$work/logs/requests-cohort.err"
if [ "$rq1_exit" = 0 ] && [ "$rq1" = 1 ] && [ "$rq3_exit" = 0 ] && [ "$rq3" = "3 true true" ] &&
  grep -qF "if every request (2 cohort requests of at most 16 participants and one merge request) writes its whole 32768-token output allowance" "$work/logs/requests-cohort.out"; then
  record "analyze --json: admission.requests" PASS "1 on the scripted run; 3 on 17 participants, the worst case naming 2 cohort requests and one merge request" "#1742"
else
  record "analyze --json: admission.requests" FAIL "scripted exit $rq1_exit requests '${rq1}'; 17 participants ($(cat "$work/logs/requests-cohort-mark.out")) exit $rq3_exit '${rq3}'; see logs/requests-*" "#1742"
fi

# 20cj. A study warning that quotes a sandbox URL is redacted before the run records it (#1748,
# fixes #1747): a dry run whose participant instruction names an e2b inbox URL other than the
# subject's prints the script-like warning with the URL on the terminal, finishes, verifies
# share_ready, and no run file holds the URL. 0.118.0 records the warning unredacted, grades the
# run blocked and fails the dry run.
cat >"$project/humanish/studies/warn-instr.yaml" <<'YAML'
schema: humanish.study.v3
id: warn-instr
title: A participant instruction that names a sandbox URL other than the subject's
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  persona: synthetic-new-user
  mission: >-
    You want to see whether this app could help you plan your week.
participants:
  - id: reader
    instruction: When the code arrives, read it at https://3000-isbxpostpublishwarn01.e2b.app/inbox and sign in.
  - id: other
execution:
  target: e2b-desktop
  timeoutMs: 600000
YAML
hx run warn-instr --dry-run --run-id warn-instr --no-open >"$work/logs/warn-instr.out" 2>"$work/logs/warn-instr.err"
wi_run=$?
hx verify --run warn-instr --json >"$work/logs/warn-instr-verify.json" 2>"$work/logs/warn-instr-verify.err"
wi_grade=$(json_field "$work/logs/warn-instr-verify.json" 'd.shareSafety && d.shareSafety.status')
wi_files=$(grep -rl 'isbxpostpublishwarn01' "$project/.humanish/runs/warn-instr" 2>/dev/null | wc -l | tr -d ' ')
wi_term=$(grep -c 'isbxpostpublishwarn01' "$work/logs/warn-instr.err")
rm -f "$project/humanish/studies/warn-instr.yaml"
if [ "$wi_run" = 0 ] && [ "$wi_grade" = share_ready ] && [ "$wi_files" = 0 ] && [ "$wi_term" -ge 1 ] &&
  grep -qF "warning: participants[0].instruction reads like a script" "$work/logs/warn-instr.err"; then
  record "run: a warning quoting a non-subject sandbox URL is redacted in the bundle" PASS "dry run exit 0, share_ready, URL in 0 run files, warning with the URL on the terminal" "#1748, #1747"
else
  record "run: a warning quoting a non-subject sandbox URL is redacted in the bundle" FAIL "dry run exit $wi_run, grade '${wi_grade}', URL in $wi_files run files, $wi_term terminal lines; see logs/warn-instr*" "#1748, #1747"
fi

# 20ck-20cl: 0.120.1 (#1744, #1753). A live run's participant list past 16, its closing messages
# cut at 160 characters, the Observer's status counts and persona filter, and an automatic
# analysis from a Bun process need a live run or a browser, which this check does not use.

# 20ck. `watch --dry-run` of 16 and 40 participants (#1744): 16 print one line each, as before;
# 40 print one count line by status and a `not listed:` line in place of 40 participant lines, and
# no warning prints twice in the run's block. `watch` then prints the Observer's block ("humanish
# observer rendered"), which repeats the run-level warnings on 0.119.0 and 0.120.1 alike, so the
# check stops at that line. 0.119.0 prints 40 participant lines.
crowd_study crowd-16w 16 ""
crowd_study crowd-40w 40 ""
hx watch crowd-16w --dry-run --detach --no-open >"$work/logs/watch-16.out" 2>"$work/logs/watch-16.err"
w16_exit=$?
hx watch crowd-40w --dry-run --detach --no-open >"$work/logs/watch-40.out" 2>"$work/logs/watch-40.err"
w40_exit=$?
rm -f "$project/humanish/studies/crowd-16w.yaml" "$project/humanish/studies/crowd-40w.yaml"
w16_lines=$(grep -c '^participant ' "$work/logs/watch-16.out")
w40_lines=$(grep -c '^participant ' "$work/logs/watch-40.out")
w40_out=$(wc -l <"$work/logs/watch-40.out" | tr -d ' ')
w40_dupes=$(sed '/^humanish observer rendered$/,$d' "$work/logs/watch-40.out" | grep '^warning: ' | sort | uniq -d | wc -l | tr -d ' ')
if [ "$w16_exit" = 0 ] && [ "$w16_lines" = 16 ] && [ "$w40_exit" = 0 ] && [ "$w40_lines" = 0 ] && [ "$w40_dupes" = 0 ] &&
  grep -qxF "participants: 40 · 40 dry run, nothing ran live" "$work/logs/watch-40.out" &&
  grep -qxF "not listed: 40 participants. The Observer shows each one." "$work/logs/watch-40.out"; then
  record "watch --dry-run: 40 participants in a count line and not listed" PASS "16: 16 participant lines; 40: 0 participant lines, the count line and not listed, $w40_out stdout lines, no repeated warning in the run block" "#1744"
else
  record "watch --dry-run: 40 participants in a count line and not listed" FAIL "16 exit $w16_exit, $w16_lines participant lines; 40 exit $w40_exit, $w40_lines participant lines, $w40_out stdout lines, $w40_dupes repeated warnings in the run block; see logs/watch-*" "#1744"
fi

# 20cl. The analysis provider under Bun (#1753, fixes #1752). Under Bun, `undici` is Bun's built-in
# module, whose Agent has no destroy(). The installed package's provider (dist/analysis/provider.js,
# which the package does not export) with an injected fake fetch returns `completed` for a 200 with
# a captured Responses body and `provider_http_error` for an HTTP 500, under Bun and under Node.
# 0.119.0 throws `TypeError: dispatcher.destroy is not a function` on both under Bun. Needs bun on
# PATH or at ~/.bun/bin/bun; no request leaves the process.
bun_bin=$(command -v bun || true)
[ -n "$bun_bin" ] || bun_bin="$HOME/.bun/bin/bun"
cat >"$lib/provider-fake-fetch.mjs" <<'JS'
import path from "node:path";
import { pathToFileURL } from "node:url";
const file = path.join(process.cwd(), "node_modules/humanish/dist/analysis/provider.js");
const { createAnalysisProvider } = await import(pathToFileURL(file).href);
const body = {
  id: "synthetic-analysis-response",
  status: "completed",
  output: [{ id: "synthetic-item-0", type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", annotations: [], text: JSON.stringify({ summary: "The synthetic task was saved." }) }] }],
  usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1240 },
};
const request = {
  model: "gpt-5.6-sol",
  instructions: "Review retained evidence only.",
  evidence: "Synthetic evidence.",
  images: [],
  schema: { type: "object", additionalProperties: false, properties: { summary: { type: "string" } }, required: ["summary"] },
  maxOutputTokens: 8192,
  timeoutMs: 1000,
};
const parts = [];
for (const [name, status, text] of [["200", 200, JSON.stringify(body)], ["500", 500, "{}"]]) {
  try {
    const r = await createAnalysisProvider({ apiKey: "synthetic-key", fetchFn: async () => new Response(text, { status }) })(request);
    parts.push(`${name}:${r.status}:${r.errorCode ?? "none"}:${r.dispatched}`);
  } catch (error) {
    parts.push(`${name}:threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}
console.log(parts.join(" "));
JS
pv_bun=$(cd "$lib" && timeout 120 "${run_env[@]}" "$bun_bin" provider-fake-fetch.mjs 2>"$work/logs/provider-bun.err" | tail -n 1)
pv_node=$(cd "$lib" && timeout 120 "${run_env[@]}" node provider-fake-fetch.mjs 2>"$work/logs/provider-node.err" | tail -n 1)
pv_want="200:completed:none:true 500:failed:provider_http_error:true"
if [ "$pv_bun" = "$pv_want" ] && [ "$pv_node" = "$pv_want" ]; then
  record "analysis provider under Bun with a fake fetch" PASS "Bun $("$bun_bin" --version 2>/dev/null) and Node: completed for 200, provider_http_error for 500" "#1753, #1752"
else
  record "analysis provider under Bun with a fake fetch" FAIL "bun '${pv_bun}', node '${pv_node}'; see logs/provider-*" "#1753, #1752"
fi

# 21. Sandbox ids stay in sandbox-receipts.ndjson (#1548). A dry run creates no sandbox,
# so this writes a receipt with a synthetic id into check 4's run dir, which no later check reads.
# Its pass is the one a live run's check uses: every receipt id, grepped in every other
# file and in the command output, has zero hits.
raw_id="isynthverifysbx0000001"
raw_digest=$(printf '%s' "$raw_id" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>process.stdout.write(require("crypto").createHash("sha256").update(s).digest("hex").slice(0,16)))')
node -e 'process.stdout.write(JSON.stringify({ at: "2026-10-03T00:00:00.000Z", laneId: "lane-01", provider: "e2b", sandboxId: process.argv[1] }) + "\n")' "$raw_id" >"$run_dir/sandbox-receipts.ndjson"
raw_elsewhere() { grep -rlF "$raw_id" "$1" --exclude=sandbox-receipts.ndjson 2>/dev/null | head -n 3 | tr '\n' ' '; }
hx verify --run "$run_id" --json >"$work/logs/sbx-verify-receipt.json" 2>"$work/logs/sbx-verify-receipt.err"
sbx_share=$(json_field "$work/logs/sbx-verify-receipt.json" 'd.shareSafety && d.shareSafety.status')
sbx_hits=$(raw_elsewhere "$run_dir")
if [ "$sbx_share" = share_ready ] && [ -z "$sbx_hits" ] && ! grep -qF "$raw_id" "$work/logs/sbx-verify-receipt.json"; then
  record "sandbox id only in receipts: verify share_ready" PASS "id in sandbox-receipts.ndjson only" "#1548"
else
  record "sandbox id only in receipts: verify share_ready" FAIL "shareSafety '${sbx_share}', other files: '${sbx_hits}'; see logs/sbx-verify-receipt.json" "#1548"
fi
# No Observer server hands out sandbox-receipts.ndjson or status.json (#1564). The run is
# share_ready here, so `observe --all --safe` admits it: run.json answers 200, the two local-only
# files 404 under any spelling. The server binds loopback and is stopped after the requests.
safe_port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
(cd "$project" && timeout 90 "${run_env[@]}" npx -y --package "$spec" humanish observe --all --safe --port "$safe_port" --no-open </dev/null >"$work/logs/observe-safe.out" 2>&1) 2>/dev/null &
safe_pid=$!
for _ in $(seq 1 120); do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$safe_port/" && break; sleep 0.5; done
safe_codes=""
for f in sandbox-receipts.ndjson SANDBOX-RECEIPTS.NDJSON observer/../sandbox-receipts.ndjson status.json run.json; do
  safe_codes="$safe_codes $f=$(curl -s --path-as-is -o "$work/logs/observe-safe.body" -w '%{http_code}' --max-time 10 "http://127.0.0.1:$safe_port/_humanish/runs/$run_id/$f")"
  if grep -qF "$raw_id" "$work/logs/observe-safe.body" 2>/dev/null; then safe_codes="$safe_codes(raw id served)"; fi
done
pkill -TERM -P "$safe_pid" 2>/dev/null
wait "$safe_pid" 2>/dev/null
if [ "$safe_codes" = " sandbox-receipts.ndjson=404 SANDBOX-RECEIPTS.NDJSON=404 observer/../sandbox-receipts.ndjson=404 status.json=404 run.json=200" ]; then
  record "observe --all --safe: receipts and status.json answer 404" PASS "receipts 404 (3 spellings), status.json 404, run.json 200" "#1564"
else
  record "observe --all --safe: receipts and status.json answer 404" FAIL "${safe_codes}; see logs/observe-safe.out" "#1564"
fi
# A pre-0.110 run: the same id raw in run.json providerResources.
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.providerResources=[{schema:"humanish.provider-resource.v1",provider:"e2b-desktop",kind:"sandbox",id:process.argv[2],owner:"humanish",status:"killed",laneId:"lane-01"}];fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$run_dir/run.json" "$raw_id"
hx verify --run "$run_id" --json >"$work/logs/sbx-verify-raw.json" 2>"$work/logs/sbx-verify-raw.err"
sbx_raw_share=$(json_field "$work/logs/sbx-verify-raw.json" 'd.shareSafety && d.shareSafety.status')
if [ "$sbx_raw_share" = local_only ] && grep -q RAW_SANDBOX_ID "$work/logs/sbx-verify-raw.json"; then
  record "raw sandbox id in run.json: verify local_only RAW_SANDBOX_ID" PASS "local_only, RAW_SANDBOX_ID" "#1548"
else
  record "raw sandbox id in run.json: verify local_only RAW_SANDBOX_ID" FAIL "shareSafety '${sbx_raw_share}'; see logs/sbx-verify-raw.json" "#1548"
fi
# cleanup is reclaim --check from 0.110.1 (#1557): its result names each receipt's sandbox in
# outcomes[] by marker and digest. With no E2B key the check fails, so the state is unknown.
hx_e2b cleanup --run "$run_id" --json >"$work/logs/sbx-cleanup.json" 2>"$work/logs/sbx-cleanup.err"
sbx_cleanup=$(json_field "$work/logs/sbx-cleanup.json" '(d.outcomes || []).map((o) => o.sandboxId + " " + o.sandboxIdDigest + " " + o.source).join(",")')
if [ "$sbx_cleanup" = "[redacted-sandbox-id] $raw_digest receipt" ] && ! grep -qF "$raw_id" "$work/logs/sbx-cleanup.json" "$work/logs/sbx-cleanup.err"; then
  record "cleanup --json (reclaim --check): marker and digest, no raw id" PASS "[redacted-sandbox-id] $raw_digest, source receipt" "#1548, #1557"
else
  record "cleanup --json (reclaim --check): marker and digest, no raw id" FAIL "outcomes '${sbx_cleanup}'; see logs/sbx-cleanup.*" "#1548, #1557"
fi
# Without an E2B key, the SDK's error names the dashboard link; redacted output keeps it (#1562).
# 0.110.1 printed it as [REDACTED_SECRET].
if grep -qF "https://e2b.dev/dashboard?tab=keys" "$work/logs/sbx-cleanup.json" &&
  ! grep -qF "[REDACTED_SECRET]" "$work/logs/sbx-cleanup.json"; then
  record "reclaim --check without a key: E2B dashboard link kept" PASS "https://e2b.dev/dashboard?tab=keys, no [REDACTED_SECRET]" "#1562"
else
  record "reclaim --check without a key: E2B dashboard link kept" FAIL "see logs/sbx-cleanup.json" "#1562"
fi
# With a malformed E2B key, E2B's API answers 401 with a docs link; redacted output keeps it
# (#1568). 0.110.2 printed it as [REDACTED_SECRET]. The key is synthetic, and E2B refuses it before
# anything is created.
(cd "$project" && timeout 120 "${run_env[@]}" E2B_API_KEY=e2b_synthetic-malformed-key npx -y --package "$spec" --package @e2b/desktop humanish reclaim --check --run "$run_id" --json) >"$work/logs/sbx-401.json" 2>"$work/logs/sbx-401.err"
if grep -qF "https://docs.e2b.dev/api-key" "$work/logs/sbx-401.json" && ! grep -qF "[REDACTED_SECRET]" "$work/logs/sbx-401.json" &&
  ! grep -qF "$raw_id" "$work/logs/sbx-401.json" "$work/logs/sbx-401.err"; then
  record "reclaim --check with a malformed E2B key: docs link kept" PASS "https://docs.e2b.dev/api-key, no [REDACTED_SECRET], no raw id" "#1568"
else
  record "reclaim --check with a malformed E2B key: docs link kept" FAIL "see logs/sbx-401.json" "#1568"
fi
# A cleanup.json in 0.109.1's shape, written by 0.109.1 itself, with the raw id in resources[].id: the
# file 0.109.1's export copied unredacted. A hand-written one fails verify. 0.109.1 refuses a
# humanish.run-bundle.v2 run (0.123.0), so the file goes into a v1 run that 0.122.0 makes, with the
# same receipt and the same providerResources entry, which is where 0.109.1 reads the sandbox from.
# The release under test exports that run, as it would a run kept from before.
legacy_id=sbx-legacy-v1
legacy_dir="$project/.humanish/runs/$legacy_id"
(cd "$project" && timeout 600 "${run_env[@]}" npx -y --package humanish@0.122.0 humanish run first-run --run-id "$legacy_id" --no-open --json) >"$work/logs/sbx-legacy-run.json" 2>"$work/logs/sbx-legacy-run.err"
cp "$run_dir/sandbox-receipts.ndjson" "$legacy_dir/sandbox-receipts.ndjson"
node -e 'const fs=require("fs");const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f,"utf8"));d.providerResources=[{schema:"humanish.provider-resource.v1",provider:"e2b-desktop",kind:"sandbox",id:process.argv[2],owner:"humanish",status:"killed",laneId:"lane-01"}];fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")' "$legacy_dir/run.json" "$raw_id"
(cd "$project" && timeout 600 "${run_env[@]}" npx -y --package humanish@0.109.1 humanish cleanup --run "$legacy_id" --json) >"$work/logs/sbx-cleanup-0109.json" 2>"$work/logs/sbx-cleanup-0109.err"
hx export --run "$legacy_id" --format bundle --redact-screenshots --out "$work/export" --json >"$work/logs/sbx-export.json" 2>"$work/logs/sbx-export.err"
sbx_export_exit=$?
sbx_export_hits=$(grep -rlF "$raw_id" "$work/export" 2>/dev/null | head -n 3 | tr '\n' ' ')
if [ "$sbx_export_exit" = 0 ] && [ -d "$work/export" ] && [ -z "$sbx_export_hits" ] &&
  [ "$(json_field "$legacy_dir/run.json" 'd.schema')" = humanish.run-bundle.v1 ] &&
  grep -qF "$raw_id" "$legacy_dir/cleanup.json" &&
  ! grep -qF "$raw_id" "$work/logs/sbx-export.json" "$work/logs/sbx-export.err"; then
  record "export --format bundle: no raw sandbox id, 0.109.1 cleanup.json included" PASS "no hits in the bundle or its output" "#1544, #1548"
else
  record "export --format bundle: no raw sandbox id, 0.109.1 cleanup.json included" FAIL "exit $sbx_export_exit, hits '${sbx_export_hits}'; see logs/sbx-export.*" "#1544, #1548"
fi

# 22. Files the package ships, as unpkg serves them.
[ "$registry" = no ] || for file in examples/participant/run.mjs examples/scorer/scorer.mjs ARCHITECTURE.md docs/contracts/errors.md; do
  code=$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 60 "https://unpkg.com/humanish@$version/$file" 2>/dev/null)
  depends="on main"
  if [ "$code" = 200 ]; then
    record "unpkg $file" PASS "200" "$depends"
  else
    record "unpkg $file" FAIL "${code:-no response}" "$depends"
  fi
done

echo "$spec packed check, $(date -u +'%Y-%m-%d %H:%M') UTC. Logs: $work/logs"
echo ""
echo "| # | Check | Result | Detail | Depends on |"
echo "| --- | --- | --- | --- | --- |"
printf '%s\n' "${rows[@]}"
echo ""
if [ "$failures" = 0 ]; then
  echo "All ${#rows[@]} checks passed."
else
  echo "$failures of ${#rows[@]} checks failed."
fi
[ "$failures" = 0 ]
