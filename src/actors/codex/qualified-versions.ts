/**
 * Codex CLI releases the restricted launcher admits, per host, oldest first. Each qualified
 * release needs a receipt under docs/goals/computer-use-actor/receipts/ that meets
 * docs/architecture/restricted-codex-analysis.md ("Admitting a Codex CLI release"). Removing a
 * release stops new launches; saved bundles stay readable through the separate reader lists in
 * src/actors/contract.ts.
 *
 * A release string is a compatibility check, not binary attestation: the launcher compares what
 * `codex --version`, initialize and thread start report, and a modified binary can report any
 * of them.
 */
export const QUALIFIED_CODEX_CLI_VERSIONS = {
  "linux-x64": ["0.154.0", "0.157.1", "0.159.2", "0.159.3"],
  "darwin-arm64": ["0.154.0"],
} as const;

/**
 * The pre-existing admission, not a qualification. Hosted participants on these hosts ran
 * 0.154.0 while it was the only admitted release, and they keep it; no qualification has run
 * on either host, and no later release is admitted there.
 */
export const PREEXISTING_CODEX_CLI_ADMISSIONS = {
  "linux-arm64": ["0.154.0"],
  "darwin-x64": ["0.154.0"],
} as const;

type QualifiedHost = keyof typeof QUALIFIED_CODEX_CLI_VERSIONS;
type PreexistingHost = keyof typeof PREEXISTING_CODEX_CLI_ADMISSIONS;
export type CodexHost = QualifiedHost | PreexistingHost;
export type AdmittedCodexCliVersion =
  | (typeof QUALIFIED_CODEX_CLI_VERSIONS)[QualifiedHost][number]
  | (typeof PREEXISTING_CODEX_CLI_ADMISSIONS)[PreexistingHost][number];

const HOST_LABELS: Record<CodexHost, string> = {
  "linux-x64": "Linux x64",
  "darwin-arm64": "macOS arm64",
  "linux-arm64": "Linux arm64",
  "darwin-x64": "macOS x64",
};

export function codexHost(platform: NodeJS.Platform, arch: string): CodexHost | undefined {
  const host = `${platform}-${arch}`;
  return Object.hasOwn(QUALIFIED_CODEX_CLI_VERSIONS, host) ||
    Object.hasOwn(PREEXISTING_CODEX_CLI_ADMISSIONS, host)
    ? (host as CodexHost)
    : undefined;
}

/** Releases that passed qualification on this host; the pre-existing admission is excluded. */
export function qualifiedCodexCliVersions(
  platform: NodeJS.Platform,
  arch: string,
): readonly AdmittedCodexCliVersion[] {
  const host = codexHost(platform, arch);
  return host !== undefined && Object.hasOwn(QUALIFIED_CODEX_CLI_VERSIONS, host)
    ? QUALIFIED_CODEX_CLI_VERSIONS[host as QualifiedHost]
    : [];
}

/** Everything the launcher starts on this host: qualified releases or the pre-existing one. */
export function admittedCodexCliVersions(
  platform: NodeJS.Platform,
  arch: string,
): readonly AdmittedCodexCliVersion[] {
  const host = codexHost(platform, arch);
  if (host === undefined) return [];
  return Object.hasOwn(QUALIFIED_CODEX_CLI_VERSIONS, host)
    ? QUALIFIED_CODEX_CLI_VERSIONS[host as QualifiedHost]
    : PREEXISTING_CODEX_CLI_ADMISSIONS[host as PreexistingHost];
}

/** What a declaration names before the installed CLI is detected: the host's newest release. */
export function defaultCodexCliVersion(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AdmittedCodexCliVersion {
  return (
    admittedCodexCliVersions(platform, arch).at(-1) ??
    QUALIFIED_CODEX_CLI_VERSIONS["linux-x64"].at(-1)!
  );
}

/** The version from `codex --version` output (`codex-cli 0.157.1`); any other shape is undefined. */
export function parseCodexCliVersion(stdout: string): string | undefined {
  return /^codex-cli ([0-9][0-9A-Za-z.+-]{0,63})$/.exec(stdout.trim())?.[1];
}

function describeHost(host: CodexHost): string {
  return Object.hasOwn(QUALIFIED_CODEX_CLI_VERSIONS, host)
    ? QUALIFIED_CODEX_CLI_VERSIONS[host as QualifiedHost].join(", ")
    : `${PREEXISTING_CODEX_CLI_ADMISSIONS[host as PreexistingHost].join(", ")} (pre-existing admission, not qualified)`;
}

/**
 * doctor's recovery for an unadmitted CLI: the release it found, what this host admits, and the
 * exact command that installs the newest admitted release.
 */
export function codexVersionRecovery(
  detected: string | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const found =
    detected === undefined
      ? "The installed Codex CLI did not report a recognizable version"
      : `Found Codex CLI ${detected}`;
  const install = `npm install -g @openai/codex@${defaultCodexCliVersion(platform, arch)}`;
  return `${found}; ${describeQualifiedCodexCliVersions(platform, arch)}. Install the newest with \`${install}\`, then sign in with a ChatGPT account (\`codex login\`).`;
}

/** For refusal messages: the admitted releases on this host, or every host when it has none. */
export function describeQualifiedCodexCliVersions(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const host = codexHost(platform, arch);
  if (host !== undefined) return `${HOST_LABELS[host]} accepts Codex CLI ${describeHost(host)}`;
  return (Object.keys(HOST_LABELS) as CodexHost[])
    .map((key) => `${HOST_LABELS[key]}: ${describeHost(key)}`)
    .join("; ");
}
