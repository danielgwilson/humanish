# OSS Lab POC

Date: 2026-06-01

Status: implemented as an experimental lab command.

## Decision

`mimetic lab oss` is the disposable outside-world proof loop for Mimetic.

It shallow clones lightweight public GitHub repositories, applies Mimetic setup
inside those throwaway clones, runs the synthetic four-lane proof path, verifies
the generated bundle, records git-status evidence, writes an ignored report, and
removes the cloned repos by default.

## Command

```bash
mimetic lab oss
mimetic lab oss --limit 1
mimetic lab oss --repo developit/mitt --repo lukeed/clsx --json
mimetic lab oss --limit 1 --keep
```

Local dogfood shortcut:

```bash
pnpm mimetic:lab:oss
```

## Default Targets

The default public targets are intentionally small JavaScript packages:

- `developit/mitt`
- `lukeed/clsx`
- `sindresorhus/is-plain-obj`
- `ai/nanoid`

The command accepts repeated `--repo owner/repo` values. It does not accept
arbitrary URLs, local paths, tokens, SSH remotes, or private GitHub references.

## Runtime Layout

The lab writes only ignored runtime state:

```text
.mimetic/
  lab/oss/<run-id>/
    report.json
    report.md
  tmp/oss-lab/<run-id>/
    repos...      # removed by default
```

Each cloned repo receives disposable uncommitted changes:

- `mimetic/` source starter files;
- `.mimetic/` runtime state;
- `.gitignore` updates;
- `package.json` script updates;
- synthetic run/Observer evidence under the clone's ignored `.mimetic/`.

The clone is removed unless `--keep` is passed. The host report remains under
ignored `.mimetic/lab/oss/<run-id>/`.

## Safety Rules

- Public GitHub `owner/repo` slugs only.
- No credential prompts; `GIT_TERMINAL_PROMPT=0` is set for clone calls.
- No package install in target repos.
- No commits, pushes, branches, tags, GitHub API mutation, provider spend,
  deploys, or issue filing.
- No real user data, PII, PHI, raw private transcripts, secrets, or private
  screenshots.

## What This Proves

The lab proves the first-run Mimetic package contract against arbitrary public
JavaScript repositories:

- setup can patch real package.json files without committing;
- generated `mimetic/` source can coexist with external repo layout;
- ignored `.mimetic/` runtime proof can be generated;
- the Observer can render from those disposable proofs;
- verification passes before the clone is discarded.

It does not prove live product behavior yet. Live browser actors, app-specific
scenario synthesis, OpenAI/E2B actors, and Codex TUI/App Server sessions remain
future capabilities.
