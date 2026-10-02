import path from "node:path";
import { RECORDED_CODEX_CLI_FLOOR, isRecordedCodexCliVersion } from "../contract.js";

/**
 * Which Codex CLI releases the restricted launcher starts: every stable `MAJOR.MINOR.PATCH`
 * release from RECORDED_CODEX_CLI_FLOOR (0.154.0, the oldest known to work) on, except the
 * refused ones. There is no ceiling, so a new release runs the day it ships; a release that breaks
 * humanish is a bug, fixed by refusing it here until humanish handles it. Saved bundles read any
 * stable release from the same floor, refused or not (src/actors/contract.ts).
 *
 * A release string is a compatibility check, not binary attestation: the launcher compares what
 * `codex --version`, initialize and thread start report, and a modified binary can report any
 * of them. Each launch also checks the release's app-server schema (protocol-compat.ts).
 */
export const REFUSED_CODEX_CLI_VERSIONS: readonly {
  readonly version: string;
  readonly reason: string;
  readonly issue: string;
}[] = [];

/**
 * Releases `pnpm codex:qualify` passed on Linux x64, oldest first. They gate nothing: the newest is
 * the default a declaration names before detection, the install target and the "last tested"
 * hint, and the list is the qualifier's baseline.
 */
export const TESTED_CODEX_CLI_VERSIONS = [
  "0.154.0",
  "0.157.1",
  "0.159.2",
  "0.159.3",
  "0.160.0",
] as const;

/**
 * The run warning for a hosted (operator-mode) participant on a release not in
 * TESTED_CODEX_CLI_VERSIONS, or undefined. No qualifier ran that release in operator mode, so its
 * evidence rests on what each launch checks (open-admission design, answer C).
 */
export function untestedOperatorReleaseWarning(
  cliVersion: string | undefined,
  operator: boolean,
): string | undefined {
  if (!operator || cliVersion === undefined) return undefined;
  if ((TESTED_CODEX_CLI_VERSIONS as readonly string[]).includes(cliVersion)) return undefined;
  return `Codex CLI ${cliVersion} has not been tested with humanish; this hosted participant's evidence rests on the checks each launch makes.`;
}

/** Why the launcher refuses a release, or undefined when it starts it. */
export type CodexCliRefusal =
  | { readonly reason: "unrecognized" }
  | { readonly reason: "prerelease" | "below_floor"; readonly version: string }
  | {
      readonly reason: "refused";
      readonly version: string;
      readonly detail: string;
      readonly issue: string;
    };

const CORE = "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)";

/**
 * Why the launcher refuses a release: not a plain `MAJOR.MINOR.PATCH` (or longer than the 64
 * characters parseCodexCliVersion reads), a prerelease (`-` after the core), older than the floor,
 * or refused.
 */
export function codexCliRefusal(version: string | undefined): CodexCliRefusal | undefined {
  if (version === undefined || version.length > 64) return { reason: "unrecognized" };
  if (new RegExp(`^${CORE}-[0-9A-Za-z.-]+(?:\\+[0-9A-Za-z.-]+)?$`).test(version))
    return { reason: "prerelease", version };
  if (!new RegExp(`^${CORE}$`).test(version)) return { reason: "unrecognized" };
  if (!isRecordedCodexCliVersion(version)) return { reason: "below_floor", version };
  const refused = REFUSED_CODEX_CLI_VERSIONS.find((entry) => entry.version === version);
  return refused === undefined
    ? undefined
    : { reason: "refused", version, detail: refused.reason, issue: refused.issue };
}

/** Whether the launcher starts this release. */
export const admitsCodexCliVersion = (version: string): boolean =>
  codexCliRefusal(version) === undefined;

/**
 * Hosts where isolated launches run (the Codex-account analyst and local-browser participants).
 * Operator launches run on every host with a native npm build (restrictedCodexNpmTarget).
 */
export const supportsIsolatedCodex = (platform: NodeJS.Platform, arch: string): boolean =>
  (platform === "linux" && arch === "x64") || (platform === "darwin" && arch === "arm64");

/** What a declaration names before the installed CLI is detected: the newest tested release. */
export function defaultCodexCliVersion(): string {
  return TESTED_CODEX_CLI_VERSIONS.at(-1)!;
}

/** The version from `codex --version` output (`codex-cli 0.157.1`); any other shape is undefined. */
export function parseCodexCliVersion(stdout: string): string | undefined {
  return /^codex-cli ([0-9][0-9A-Za-z.+-]{0,63})$/.exec(stdout.trim())?.[1];
}

/** Why a release is refused, as a clause; the admission rule when it is not refused. */
function refusalClause(detected: string | undefined): string {
  const refusal = codexCliRefusal(detected);
  switch (refusal?.reason) {
    case "unrecognized":
      return `it is not a plain MAJOR.MINOR.PATCH release; ${describeCodexCliAdmission()}`;
    case "prerelease":
      return "it is a prerelease, and humanish runs stable releases";
    case "below_floor":
      return `it is older than ${RECORDED_CODEX_CLI_FLOOR}, the oldest release humanish supports`;
    case "refused":
      return `humanish refuses it: ${refusal.detail} (${refusal.issue})`;
    default:
      return describeCodexCliAdmission();
  }
}

/**
 * doctor's recovery for a refused CLI: the release it found and where, why it is refused, and how
 * to replace that binary with the last tested release.
 */
export function codexVersionRecovery(
  detected: string | undefined,
  installation?: CodexInstallation,
): string {
  const found =
    detected === undefined
      ? "The installed Codex CLI did not report a recognizable version"
      : `Found Codex CLI ${detected}`;
  const where = installation === undefined ? "" : ` at \`${installation.path}\``;
  return `${found}${where}; ${refusalClause(detected)}. ${codexInstallAdvice(installation)} Then sign in with a ChatGPT account (\`codex login\`).`;
}

/**
 * Where the `codex` humanish found was installed, which decides the command that replaces it.
 * `path` is the file on `PATH`.
 */
export type CodexInstallation =
  | { readonly kind: "project"; readonly path: string; readonly project: string }
  | { readonly kind: "global"; readonly path: string }
  | { readonly kind: "other"; readonly path: string };

const inside = (file: string, directory: string): boolean =>
  file.startsWith(`${directory}${path.sep}`);

/**
 * Classifies the `codex` on `PATH` by the file it resolves to. A project's node_modules/.bin/codex
 * resolving into that project's @openai/codex is project-local, so `npx` runs it before any global
 * install. One inside npm's global prefix (`npm prefix -g`) is global. Anything else, such as
 * Homebrew or a standalone download, is other.
 */
export function classifyCodexInstallation(
  found: { path: string; resolved: string },
  npmGlobalPrefix: string | undefined,
): CodexInstallation {
  const bin = path.dirname(found.path);
  const modules = path.dirname(bin);
  if (
    path.basename(bin) === ".bin" &&
    path.basename(modules) === "node_modules" &&
    inside(found.resolved, path.join(modules, "@openai", "codex"))
  )
    return { kind: "project", path: found.path, project: path.dirname(modules) };
  if (
    npmGlobalPrefix !== undefined &&
    (found.path === path.join(npmGlobalPrefix, "bin", "codex") ||
      inside(found.resolved, path.join(npmGlobalPrefix, "lib", "node_modules", "@openai", "codex")))
  )
    return { kind: "global", path: found.path };
  return { kind: "other", path: found.path };
}

/**
 * The command that installs the last tested Codex CLI where it replaces the one humanish found:
 * in its project for a project-local install, otherwise npm's global install.
 */
function codexInstallCommand(installation?: CodexInstallation): string {
  const version = defaultCodexCliVersion();
  return installation?.kind === "project"
    ? `npm install -D @openai/codex@${version}`
    : `npm install -g @openai/codex@${version}`;
}

/** One sentence: how to put the last tested Codex CLI in place of the one humanish found. */
export function codexInstallAdvice(installation: CodexInstallation | undefined): string {
  const command = codexInstallCommand(installation);
  switch (installation?.kind) {
    case undefined:
      return `Install the last tested release with \`${command}\`.`;
    case "global":
      return `Replace it with \`${command}\`.`;
    case "project":
      return `It is installed in this project: run \`${command}\` in \`${installation.project}\`, or \`npm uninstall @openai/codex\` there to use the global Codex.`;
    case "other":
      return `Update it with the tool that installed it, or put Codex ${defaultCodexCliVersion()} first on PATH.`;
  }
}

/** For refusal messages: which releases the launcher starts, and the last tested one. */
export function describeCodexCliAdmission(): string {
  const refused = REFUSED_CODEX_CLI_VERSIONS.map((entry) => entry.version);
  const except = refused.length === 0 ? "" : ` except ${refused.join(", ")}`;
  return `humanish runs stable Codex CLI releases from ${RECORDED_CODEX_CLI_FLOOR}${except} (last tested: ${defaultCodexCliVersion()})`;
}
