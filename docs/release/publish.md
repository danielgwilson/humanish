# Publish a release

The maintainer approves each release. Only the tag-gated publish workflow runs `npm publish`;
no agent runs it locally.

## Check the candidate

Run both checks on the release commit:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm release:dogfood
```

`pnpm release:check` is the gate CI's test job runs: `pnpm check`, `pnpm api:proof`,
`pnpm public-surface:scan`, `pnpm skill:check` and `npm pack --dry-run`.

`pnpm release:dogfood` packs the candidate, installs the tarball in a fresh project and sends one
participant through the first-contact study against it. It needs provider keys and costs about a
dollar of agent tokens; the study's own caps hold product spend to $0. CI never runs it. Read what
the participant said before you tag.

`pnpm public-surface:scan` scans tracked files and the npm dry-run payload, including the built
`dist/`. It fails on common secret tokens, absolute local user paths, local workspace paths,
unapproved commit email metadata, known private upstream system names, and binary assets missing
from its SHA-256 allowlist. It also fails on any value at a sandbox-id key (`sandboxId`,
`subjectSandboxId`, `providerResources[].id`) other than `[redacted-sandbox-id]`, whatever the id
looks like; under `tests/`, a value with a `fake-` or `synthetic-` prefix passes.

The tarball must not contain `.env*`, `.humanish/`, run bundles, private screenshots, raw
transcripts, `.npmrc`, tests, fixtures, operations notes or local runtime caches. Every shipped
doc is synthetic and public-safe. An image keeps its approved checksum on the scanner allowlist.

## Pick the version

humanish stays on `0.x` until the maintainer decides to release `1.0.0`; authority to merge and
publish does not include that decision. Version components are integers: the minor after `0.99.0`
is `0.100.0`, and a patch on it is `0.99.1`. A patch carries compatible fixes. A minor carries
features and pre-1.0 breaking changes, each with its migration in the release notes. Do not run
`npm version major`. See [SemVer](https://semver.org/).

## Open the release pull request

1. Set the version: `npm version minor --no-git-tag-version`, or `patch`.
2. Move the body of CHANGELOG.md's Unreleased section into the release notes. The CHANGELOG entry
   keeps a title, the opening paragraph and a link to the GitHub release, under an empty
   Unreleased heading.
3. Run `pnpm docs:generate`, which writes the version into `site/content/docs/cli.mdx`.
4. Run the two checks above on that commit, then open the pull request.

## Tag and publish

After the release pull request merges:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
VERSION="$(node -p "require('./package.json').version")"
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

The publish workflow runs on a `v*` tag. It fails unless the tag commit is an ancestor of
`origin/main` and the tag name matches `package.json`'s version, so a tag on a local commit that
never merged publishes nothing. The GitHub Release for the tag carries the full notes, and its
opening paragraph is the CHANGELOG entry.

## Keep Trusted Publishing bound to the repository

npm Trusted Publishing binds the package to these GitHub Actions fields. Check them before each tag:

- provider: GitHub Actions
- repository owner: `danielgwilson`
- repository name: `humanish`
- workflow filename: `publish.yml`
- environment: blank
- registry: npm public registry

`.github/workflows/publish.yml` sets `permissions.id-token: write` for OIDC and
`permissions.contents: read`, sets up Node 24 with the npm registry URL, and runs
`npm publish --access public`. It holds no long-lived npm token.

The binding names the exact repository and workflow path. After a repository rename, do these in
order:

1. Rename the GitHub repository.
2. Point the npm Trusted Publisher at the new repository name.
3. Merge the release commit, then tag.

A tag pushed before steps 1 and 2 fails OIDC authentication, because the repository claim does not
match, or fails provenance validation, because `package.json`'s `repository.url` names the old
repository.
