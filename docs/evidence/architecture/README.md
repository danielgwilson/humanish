# Architecture benchmark

`pnpm arch:bench` measures how much code sits behind each top-level folder's interface in `src/`,
which small modules fail the deletion test, how far tests reach past folder interfaces, which
injected-dependency seams have a single adapter, and how many folders a commit on main touches. The
terms come from Matt Pocock's
[codebase-design skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md)
and John Ousterhout's _A Philosophy of Software Design_: depth, seam, locality, the deletion test,
the interface as test surface and the two-adapter rule. Like `pnpm bench`, it is a report. Neither
`pnpm check` nor CI runs it, and no number has a target.

## Run it

From a checkout with history back to the `--since` date:

```bash
pnpm install --frozen-lockfile
git fetch origin
pnpm arch:bench                                   # tables in the terminal
pnpm arch:bench --json                            # the full result as JSON
pnpm arch:bench --out docs/evidence/architecture  # <date>-<head>.md and .json
```

| Flag              | Default       | Meaning                                                              |
| ----------------- | ------------- | -------------------------------------------------------------------- |
| `--since <date>`  | `2026-09-29`  | First day of the history window, from midnight UTC                   |
| `--ref <ref>`     | `origin/main` | The branch whose history is read; fetch it first                     |
| `--max-lines <n>` | 40            | Largest module, in code lines, that counts as a deletion-test candidate |
| `--json`          | off           | Print the result as JSON                                             |
| `--out <dir>`     | none          | Write the Markdown summary and the JSON result to this directory     |

A run takes about 15 seconds, needs no keys and makes no network calls.

The code side reads the project through TypeScript 7's compiler API, `typescript/unstable/sync`,
which drives the native compiler over a pipe. It opens `tsconfig.json` and measures every file
under `src/` and `tests/` in that project. Module specifiers resolve the way `tsc` resolves them,
and every import is followed to the declaration it reaches: through an index file, `export *`, a
renamed re-export, a namespace import or a dynamic import. Type-only imports count like value
imports. TypeScript marks this API unstable, so a TypeScript upgrade can break the bench;
`tests/scripts/lib/arch-bench.test.ts` runs it on a small in-memory project with known answers
and fails first.

## What each number means

### Depth per top-level src folder

A folder is a directory directly under `src/`. The six files directly in `src/` form `(root)`.

| Column                     | Definition                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| code lines                 | Lines with code on them. Blank lines and lines that hold only a comment are left out. Text inside a string or template literal is code, so a line of CSS in a template counts |
| interface symbols          | Distinct declarations that modules in other folders import from this folder's files. A name reached by two import paths counts once. A namespace import, `export *`, and a dynamic import whose names are not read in place count every export of the module they name |
| lines per symbol           | Code lines divided by interface symbols                                                                          |
| files other folders import | Files of the folder that a module in another folder names in an import                                           |
| importing folders          | Other folders that import any file of the folder                                                                 |

Imports from tests do not count toward a folder's interface.

Depth in the skill is leverage: the behavior a caller gets per unit of interface it has to learn.
Lines per symbol is the line ratio the skill lists under rejected framings, because padding an
implementation raises it. Read it as a pointer to folders worth a look. It counts a one-field type
and a function with ten options as one symbol each, and it sees only the type-level surface; the
skill's interface also includes ordering constraints, error modes and configuration. A folder can
hold several modules: `src/routes/` holds five routes.

### Deletion-test candidates

A candidate is a `src/` module with at most `--max-lines` code lines that exactly one other `src/`
module imports. Merging it into its importer changes no other module, so the deletion test is
cheapest to run on these. The test files that import it are listed because a merge moves their
target. The list names candidates for reading. A module that isolates a stable contract, or one a
script loads by path, can earn its keep at any size.

### The interface as test surface

- Share of `src/` modules tests import directly: the modules some file under `tests/` imports by
  any form, including dynamic imports and `import()` types, over all `src/` modules.
- `vi.mock` and `vi.doMock`: the test files with at least one call that replaces a `src/` module,
  and the number of those calls. A string specifier is resolved from the test file the way Node
  maps `.js` to `.ts`.
- Per folder: the files tests import, and of those, the files only modules in the same folder
  import. A file belongs to its folder's interface when a module in another folder imports it,
  when it declares something another folder imports through a re-export, or when no `src/` module
  imports it, as with `src/index.ts` and the guest entry points. A test that imports any other
  file of the folder reaches past the folder's interface.

The folder is the unit here. The skill allows internal seams that a module's own tests use, so a
test of `participant-model.ts` inside `src/routes/computer-use/` can be testing that route's
internal seam on purpose. The count shows where tests cross a folder boundary; each one needs
reading before it is called a problem. Helpers under `tests/helpers/` count as test files.

### Two-adapter rule

"One adapter means a hypothetical seam. Two adapters means a real one." The skill's companion page
on deepening names production plus test as the usual pair. The bench decides as follows.

A seam is an interface or type alias declared in `src/` that is a function type or has a
function-typed member, and that either has a name ending in `Deps`, `Dependencies`, `Provider`,
`Executor`, `Adapter` or `Substrate`, or annotates a function or constructor parameter in another
top-level folder with at least half of its members functions. The half rule leaves out option bags
that carry one callback.

An implementation site is one of these:

- a class that names the seam in `implements`;
- an object literal, arrow function or function expression the compiler types as the seam, as an
  interface that extends it or as an intersection that includes it. An object literal has to
  declare one of the seam's function members or spread in another object. One that spreads in a
  value already typed as the seam, or is itself spread into another literal, derives from an
  implementation counted elsewhere and is skipped, and so is `{}` as a default argument;
- an object literal with no named type that declares every required member and at least one
  function member, when the compiler finds it assignable to the seam;
- an `as` or `satisfies` cast of any other expression to the seam.

Each site counts once per seam, in `src/` or in `tests/`. The verdicts:

| Verdict                            | Meaning                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| one adapter                        | One site in `src/`, none in tests: a hypothetical seam by the rule    |
| production and test                | One site in `src/` and at least one in tests: two adapters             |
| two or more in `src/`              | At least two sites in `src/`                                          |
| no production implementation found | No site in `src/`                                                     |

A seam with no production site is one of three things: an override bag whose defaults live inside
the module (production code leaves `StudyDeps` at its `{}` default), a type that narrows another seam
(`DebriefingProvider`), or a production object built in a form the rule does not see.

Limits. Sites are not distinct adapters: fifteen literals in one test file count fifteen. An object
built without a type and passed later is found only when it declares every required member. A
literal that forwards a differently typed object still counts: two of `CuaParticipantDeps`' five
`src/` sites, in `src/routes/shared-world/handoff.ts`, spread `deps.runDeps` and override the app
URL and the callbacks. The name suffixes are this repo's conventions, and a seam named otherwise is found only
through the parameter rule.

### Locality

The history side reads `git log <ref> --since=<date>T00:00:00Z --name-status -M`. A commit touches a
top-level `src/` folder when it adds, changes, deletes or renames a file in it, and a rename
touches the folders of both its paths. Means are over the commits that touch `src/`. The second
row leaves out commits whose subject starts with Move, Rename, Refactor, Inline or Split. That
prefix is a convention, so a move with another subject stays in the second row.

Route folders follow the rules of the 2026-10-06 route duplication review: the four folders under
`src/routes/` and `src/routes/preview.ts`, plus the files each route held before the move into
`src/routes/`. As in that review, each commit's paths are the ones `git log --name-only -M` prints,
so a rename counts at its new path only, and the mean is over the commits that touched two or more
route folders.

The baseline is the review's 34 behavior commits, chosen by reading the commits since 2026-09-29
that touched two or more route folders. `scripts/lib/arch-bench-route-commits.json` lists them by
pull request and commit. The bench computes their mean from git: 3.09 route folders when they
landed. The review also replayed each change on main at `151eafea`, counting by reading the code
which route folders the same change would touch there. That mean, 2.35, is a recorded hand count;
the bench carries it from the same file and does not recompute it.

Limits. Main is squash-merged, so a commit is a pull request, and one pull request can bundle
several changes. A sweep with a plain subject, such as a formatting pass, counts as a wide change.
The window ends at the ref's tip, so runs on different days differ. The review counted commits
with git's default reading of `--since=2026-09-29`, which takes the time of day of the run, and
reported 689 commits at one time and 695 at another; this bench starts at midnight UTC.

## Store a result

`pnpm arch:bench --out docs/evidence/architecture` writes `<date>-<head>.md` and `.json`. Commit
both and add a row below. The name carries the HEAD that was measured. A dated result lists `src/`
paths as they were at that commit, so the doc path checks skip it
(`scripts/lib/doc-paths.ts`); this README is checked.

## Results

| Date       | Measured   | History                                 | src files | src code lines | src folders per commit, all and without moves | Route baseline, landed and replayed | Summary                          |
| ---------- | ---------- | --------------------------------------- | --------- | -------------- | --------------------------------------------- | ----------------------------------- | -------------------------------- |
| 2026-10-06 | `4664a07d` | `origin/main` at `eb74165f`, since 2026-09-29 | 431       | 88,897         | 2.74 and 2.58                                 | 3.09 and 2.35                       | [summary](2026-10-06-4664a07d.md) |
