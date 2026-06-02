# Open-Source Release Readiness

Date: 2026-06-02

Status: public repository candidate after reviewed history cleanup. Actual
`npm publish` remains a human release action and must not be run by an agent
without explicit approval in the current context.

Use [`docs/release/public-readiness-standard.md`](public-readiness-standard.md)
as the public-cleanliness policy. The standard distinguishes real blockers such
as secrets, PHI, private source, private screenshots, and raw credentials from
acceptable public metadata such as maintainer-approved public commit email.

## Package State

- Package name: `mimetic-cli`
- Version: `0.1.3`
- Binary: `mimetic`
- License: MIT
- Repository: `https://github.com/danielgwilson/mimetic-cli`
- npm access: public via `publishConfig.access`
- npm contents: compiled `dist`, public docs directories, including ramp and
  current-goal docs, `skills/`,
  `README.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and
  `package.json`
- GitHub Actions publish workflow: `.github/workflows/publish.yml`
- optional live E2B peer: `@e2b/desktop`

`prepack` runs the TypeScript build so a clean checkout can produce a usable
tarball with `npm pack` or `npm publish`.

## Skill State

The installable agent skill lives at:

```text
skills/mimetic-cli/SKILL.md
```

This matches skills.sh discovery for `skills/<name>/SKILL.md`. The required
frontmatter fields are present:

```yaml
name: mimetic-cli
description: ...
```

Verification command:

```bash
DISABLE_TELEMETRY=1 npx skills add . --list
```

Expected install command after the repository is public:

```bash
npx skills add danielgwilson/mimetic-cli --skill mimetic-cli
```

## Public Boundary

Release work must not include PII, PHI, secrets, keys, tokens, raw private
transcripts, private screenshots, raw customer data, raw patient data, private
source snippets, or generated run bundles.

Allowed examples are synthetic or redacted only.

## GitHub Visibility Gate

The current tree and reachable Git history are the public surface being
hardened here. The repository must not be made public until these checks pass
from a fresh clone:

- only the intended `main` branch is reachable;
- no stale release tags point at pre-cleanup source;
- history scans have no private upstream system names, absolute maintainer paths,
  secret patterns, or generated runtime bundles;
- reachable commit author and committer emails are GitHub noreply-style
  addresses or explicitly approved public maintainer emails;
- GitHub issues, PRs, labels, and project fields have been scanned or rewritten
  for public-safe language.

GitHub may still retain unreachable object caches or historical Actions logs
internally. Treat those as residual platform-cache risk and delete old workflow
runs before public launch if a stricter surface is required.

History-check shape used during this audit:

```bash
git rev-list --all | xargs -n 32 git grep -n -I -i -e '<private-source-name>' -e '<absolute-local-path-marker>' -e '<workspace-path-marker>'
git rev-list --all | xargs -n 32 git grep -n -I -E 'sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}'
```

## Required Gates

Run these before any public release candidate:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm public-surface:scan
pnpm skill:check
pnpm pack:dry-run
git diff --check
```

`pnpm public-surface:scan` scans tracked files plus the npm dry-run payload,
including built `dist/` output. It fails on common secret tokens, absolute local
user paths, local workspace paths, unapproved durable commit email metadata,
known private upstream system names, and binary public assets that are not
explicitly allowlisted by SHA-256.

## Tarball Inspection

Use:

```bash
pnpm pack:dry-run
```

`pnpm pack:dry-run` delegates to `npm pack --dry-run` after `prepack` builds
`dist`.

The tarball must not include `.env*`, `.mimetic/`, generated run bundles,
private screenshots, raw transcripts, `.npmrc`, tests, fixtures, internal
operations notes, local runtime caches, or private operator packets. Public
`docs/ramp/`, `docs/goals/`, and repo-local `AGENTS.md` files are allowed when
they are synthetic, durable, and public-safe. Public image assets must remain on
the scanner allowlist and keep their approved checksum.

## Publish Procedure

Only after maintainer approval:

```bash
pnpm release:check && npm publish --access public
```

No agent should run that command without explicit human approval in the current
thread. That approval must come from the maintainer responsible for the release.

## Trusted Publishing Setup

The npm package page exists. Trusted Publishing should be configured for GitHub
Actions before cutting the next tag:

- provider: GitHub Actions
- repository owner: `danielgwilson`
- repository name: `mimetic-cli`
- workflow filename: `publish.yml`
- environment: blank
- registry: npm public registry

The workflow uses:

- `permissions.id-token: write` for OIDC;
- `permissions.contents: read`;
- `actions/checkout@v6`;
- `actions/setup-node@v6` with Node 24 and npm registry URL;
- `npm publish --access public`;
- no long-lived npm token secret.

Future automated release flow after trusted publishing is configured:

```bash
pnpm release:check
npm version patch -m "Release %s"
git push origin main --tags
```

The publish job is tag-gated and only publishes when running on a `v*` tag.
