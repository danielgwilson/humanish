// Provider-key discovery (#436): resolve the keys a live run needs through each vendor's
// native chain instead of demanding a per-repo --env-file that operators hand-copy keys into.
//
// The chain, per key, FILL-ONLY (a rung never overrides anything already present):
//   1. process env — including whatever --env-file just loaded (explicit always wins);
//   2. `.humanish/local/provider.env` — the project-local overlay this CLI's own --help
//      examples document;
//   3. the OWNING vendor's native store, where one exists:
//        E2B_API_KEY  <- ~/.e2b/config.json (written by `e2b auth login`);
//        GH_TOKEN     <- `gh auth token` (the gh CLI's credential chain);
//   4. the humanish user-level store `$XDG_CONFIG_HOME/humanish/keys.env`, written only by
//      `humanish keys set` (0600, prompted or --stdin) — the fallback for vendors that ship
//      no machine chain of their own (OpenAI, Anthropic).
//
// Every fill is ANNOUNCED by key name + source, never by value. The subject app's own
// `.env`/`.env.local` are NEVER read — those hold product credentials, a different class
// (#11); this module only reads humanish-owned files and vendor-owned stores.
// `HUMANISH_STRICT_KEYS=1` disables every rung below process env (the pre-#436 behavior).

import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { loadEnvFile } from "./env-file.js";

export const KEY_RESOLUTION_SCHEMA = "humanish.key-resolution.v1";

/** The ONLY names implicit discovery may fill (and `humanish keys set` may store). Everything
 *  else in an overlay/store file is ignored-and-named: a repo-planted NODE_OPTIONS/LD_PRELOAD
 *  must never enter process env off a file the operator did not explicitly pass (an explicit
 *  --env-file remains the operator's own full-file load). Red-team finding, #436. */
export const KNOWN_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "E2B_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CODEX_API_KEY"
] as const;
const PROVIDER_KEY_SET = new Set<string>(KNOWN_PROVIDER_KEYS);

/** `humanish keys set <vendor>` aliases; a raw ENV_NAME is also accepted. */
export const KEY_VENDOR_ALIASES: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  e2b: "E2B_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  github: "GH_TOKEN"
};

export interface ResolvedKeyFill {
  name: string;
  /** Human-readable source label (a path or command name) — never a value. */
  source: string;
}

export interface KeyResolutionDeps {
  /** Injectable for tests: run `gh auth token`-style probes. Resolves to trimmed single-line
   *  stdout, or null on any failure (missing binary, non-zero exit, empty/multi-line output). */
  execText?: (command: string, args: string[], timeoutMs: number) => Promise<string | null>;
  homeDir?: string;
}

export const PROJECT_OVERLAY_RELATIVE = path.join(".humanish", "local", "provider.env");

export function userKeyStorePath(env: NodeJS.ProcessEnv, deps: KeyResolutionDeps = {}): string {
  const home = deps.homeDir ?? homedir();
  const declared = env.XDG_CONFIG_HOME?.trim();
  // The XDG spec: a relative XDG_CONFIG_HOME MUST be ignored. Honoring one would make the
  // key store cwd-relative — `humanish keys set` would write a secret into the current repo.
  const configHome = declared !== undefined && declared !== "" && path.isAbsolute(declared) ? declared : path.join(home, ".config");
  return path.join(configHome, "humanish", "keys.env");
}

function e2bConfigPath(deps: KeyResolutionDeps): string {
  return path.join(deps.homeDir ?? homedir(), ".e2b", "config.json");
}

/** Default exec: bounded, quiet, stdin closed; null on ANY failure. Never throws. */
function defaultExecText(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const settle = (value: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // best effort
      }
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(null);
        return;
      }
      const trimmed = out.trim();
      settle(trimmed.length > 0 && !trimmed.includes("\n") ? trimmed : null);
    });
  });
}

/** Read the E2B team key from the e2b CLI's own config. Defensive on shape: accept the
 *  documented `teamApiKey`, fall back to `apiKey`; anything else is a miss, never an error. */
function readE2bConfigKey(deps: KeyResolutionDeps): string | null {
  try {
    const raw = readFileSync(e2bConfigPath(deps), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    for (const field of ["teamApiKey", "apiKey"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** Refuse to READ a store through a symlink: a repo-local overlay that is secretly a link to
 *  an unrelated file is exactly the retargeting shape the artifact paths refuse elsewhere. */
function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Fill missing provider keys into `env` from the discovery chain, announcing each fill as
 * `NAME from SOURCE`. Returns the fills. Opt-out: HUMANISH_STRICT_KEYS=1 returns [] untouched.
 */
export async function discoverProviderKeys(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  announce: (line: string) => void;
  deps?: KeyResolutionDeps;
}): Promise<ResolvedKeyFill[]> {
  const { cwd, env, announce } = args;
  const deps = args.deps ?? {};
  if (env.HUMANISH_STRICT_KEYS?.trim() === "1") return [];
  const fills: ResolvedKeyFill[] = [];
  const ignored: string[] = [];
  // Fill-only means PRESENCE wins, including an explicitly-set empty value: an operator who
  // exported OPENAI_API_KEY="" said "off", and a rung that "fixes" that has overridden them
  // (red-team finding). Only a truly-unset name is fillable.
  const fillable = (name: string): boolean => env[name] === undefined;
  const fill = (name: string, value: string, source: string): void => {
    env[name] = value;
    fills.push({ name, source });
  };

  // Rung 2: the documented project-local overlay. Parsed ATOMICALLY against a scratch env so a
  // file loadEnvFile rejects can never half-apply (red-team finding: earlier lines used to land
  // in env unannounced before the parse error aborted). Only allowlisted provider names cross
  // from the file into the real env.
  const overlayPath = path.resolve(cwd, PROJECT_OVERLAY_RELATIVE);
  if (isRegularFile(overlayPath) && !dirIsSymlink(overlayPath)) {
    const scratch: NodeJS.ProcessEnv = {};
    const overlay = await loadEnvFile(cwd, PROJECT_OVERLAY_RELATIVE, scratch);
    if (overlay.ok) {
      for (const name of overlay.loaded) {
        const value = scratch[name];
        if (value === undefined || !fillable(name)) continue;
        if (!PROVIDER_KEY_SET.has(name)) {
          ignored.push(`${name} (${PROJECT_OVERLAY_RELATIVE})`);
          continue;
        }
        fill(name, value, PROJECT_OVERLAY_RELATIVE);
      }
    }
  }

  // Rung 3a: the e2b CLI's own login store.
  if (fillable("E2B_API_KEY")) {
    const teamKey = readE2bConfigKey(deps);
    if (teamKey !== null) fill("E2B_API_KEY", teamKey, "~/.e2b/config.json (e2b auth login)");
  }

  // Rung 3b: the gh CLI's credential chain. Only consulted when NEITHER GitHub env name is
  // present; fills GH_TOKEN (the name humanish reads first).
  if (fillable("GH_TOKEN") && fillable("GITHUB_TOKEN")) {
    const exec = deps.execText ?? defaultExecText;
    const token = await exec("gh", ["auth", "token"], 3_000);
    if (token !== null) fill("GH_TOKEN", token, "gh auth token");
  }

  // Rung 4: the humanish user-level store — read with the SAME lenient parser `keys set`/`list`
  // use, so one hand-mangled line degrades to that line alone instead of silently voiding the
  // whole store (red-team finding: the strict parser disagreed with the store's own reader).
  const storePath = userKeyStorePath(env, deps);
  if (isRegularFile(storePath) && !dirIsSymlink(storePath)) {
    for (const [name, value] of readStoreEntries(storePath)) {
      if (!fillable(name)) continue;
      if (!PROVIDER_KEY_SET.has(name)) {
        ignored.push(`${name} (${storeLabel(env, deps)})`);
        continue;
      }
      fill(name, value, storeLabel(env, deps));
    }
  }

  for (const fill_ of fills) announce(`humanish keys: ${fill_.name} from ${fill_.source}`);
  for (const name of ignored) announce(`humanish keys: ignored non-provider name ${name} — implicit discovery fills provider keys only; pass the file via --env-file to load everything in it`);
  return fills;
}

/** True when the file's PARENT directory is (or traverses) a symlink at its last component —
 *  the dir-level retarget that defeats a file-level lstat check (red-team finding). */
function dirIsSymlink(filePath: string): boolean {
  try {
    return lstatSync(path.dirname(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

function storeLabel(env: NodeJS.ProcessEnv, deps: KeyResolutionDeps): string {
  const home = deps.homeDir ?? homedir();
  return userKeyStorePath(env, deps).replace(home, "~");
}

export interface KeySourceProbe {
  name: string;
  /** The source that supplies the key right now, or null when missing everywhere. */
  source: string | null;
  /** The command/path that would fill it when missing. */
  hint: string;
}

/** The nearest fill instruction for a missing key — used by doctor rows and appended to
 *  *_KEYS_MISSING errors so the failure names the fix, not just the absence (#436). */
export function missingKeyHint(name: string): string {
  switch (name) {
    case "E2B_API_KEY":
      return "run `e2b auth login`, or `humanish keys set e2b`";
    case "GH_TOKEN":
    case "GITHUB_TOKEN":
      return "run `gh auth login`, or `humanish keys set github`";
    case "OPENAI_API_KEY":
      return "run `humanish keys set openai`";
    case "ANTHROPIC_API_KEY":
      return "run `humanish keys set anthropic`";
    default:
      return `run \`humanish keys set ${name}\``;
  }
}

/** One shared suffix for *_KEYS_MISSING messages: where discovery looked, and what fills each
 *  missing key. Pure text; never values. */
export function describeMissingKeys(names: string[], env: NodeJS.ProcessEnv): string {
  const hints = names.map((name) => `${name}: ${missingKeyHint(name)}`).join("; ");
  const strict = env.HUMANISH_STRICT_KEYS?.trim() === "1";
  const chain = strict
    ? "key discovery is disabled (HUMANISH_STRICT_KEYS=1); only process env and --env-file are read"
    : `also checked ${PROJECT_OVERLAY_RELATIVE}, ~/.e2b/config.json, gh auth token, and ${path.join("~", ".config", "humanish", "keys.env")}`;
  return `${chain}. Fill: ${hints}.`;
}

/**
 * Non-mutating probe for doctor: report, per key, the source that currently supplies it.
 * Runs the same chain against a scratch copy of env so nothing observable changes.
 */
export async function probeKeySources(
  names: readonly string[],
  args: { cwd: string; env: NodeJS.ProcessEnv; deps?: KeyResolutionDeps }
): Promise<KeySourceProbe[]> {
  const scratch: NodeJS.ProcessEnv = { ...args.env };
  const fills = await discoverProviderKeys({
    cwd: args.cwd,
    env: scratch,
    announce: () => {},
    ...(args.deps === undefined ? {} : { deps: args.deps })
  });
  const bySource = new Map(fills.map((fill) => [fill.name, fill.source]));
  return names.map((name) => {
    const inEnv = args.env[name] !== undefined && args.env[name]?.trim() !== "";
    // GH_TOKEN and GITHUB_TOKEN are one credential with two spellings; a doctor row that says
    // "missing" while GITHUB_TOKEN sits in the env would be wrong (red-team nit).
    const aliasInEnv = name === "GH_TOKEN" && args.env.GITHUB_TOKEN !== undefined && args.env.GITHUB_TOKEN.trim() !== "";
    const source = inEnv ? "process env" : aliasInEnv ? "process env (GITHUB_TOKEN)" : (bySource.get(name) ?? null);
    return { name, source, hint: missingKeyHint(name) };
  });
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve a `humanish keys set` target: a vendor alias or a raw env name. Null = invalid. */
export function resolveKeyName(vendorOrName: string): string | null {
  const alias = KEY_VENDOR_ALIASES[vendorOrName.toLowerCase()];
  if (alias !== undefined) return alias;
  return ENV_NAME.test(vendorOrName) ? vendorOrName : null;
}

/** Write one key into the user store (0700 dir, 0600 file). Only allowlisted provider names
 *  are storable (the store feeds implicit discovery — an arbitrary-name store would be an env
 *  injection vector with extra steps). The value must be a single non-empty line that
 *  round-trips the store's own parser byte-identically, and the write refuses symlinks at the
 *  file AND its parent directory (red-team findings). */
export function setUserKey(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv,
  deps: KeyResolutionDeps = {}
): { path: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\r|\n/.test(trimmed)) {
    throw new Error("The key value must be a single non-empty line.");
  }
  if (!ENV_NAME.test(name)) {
    throw new Error(`Not a valid env name: ${name}`);
  }
  if (!PROVIDER_KEY_SET.has(name)) {
    throw new Error(
      `The store holds provider keys only (${[...PROVIDER_KEY_SET].join(", ")}). For anything else, use an explicit --env-file.`
    );
  }
  const storePath = userKeyStorePath(env, deps);
  const dir = path.dirname(storePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlinked store directory: ${dir}`);
  }
  if (existsSync(storePath) && !lstatSync(storePath).isFile()) {
    throw new Error(`Refusing to write the store: ${storePath} is not a regular file.`);
  }
  const entries = readStoreEntries(storePath);
  entries.set(name, trimmed);
  // The written line must read back byte-identically through the store's own parser: a value
  // that parses differently (an embedded '#', a leading quote the env parser would strip)
  // would silently resolve to a DIFFERENT secret on the next run.
  const roundTrip = parseStoreLine(`${name}=${trimmed}`);
  if (roundTrip === null || roundTrip[0] !== name || roundTrip[1] !== trimmed) {
    throw new Error("The value does not round-trip the store format (avoid leading quotes and '#'); pass it via --env-file instead.");
  }
  writeStore(storePath, entries);
  return { path: storePath };
}

/** Remove one key from the user store. Returns whether it was present. */
export function unsetUserKey(name: string, env: NodeJS.ProcessEnv, deps: KeyResolutionDeps = {}): boolean {
  const storePath = userKeyStorePath(env, deps);
  if (!isRegularFile(storePath) || dirIsSymlink(storePath)) return false;
  const entries = readStoreEntries(storePath);
  const had = entries.delete(name);
  if (had) writeStore(storePath, entries);
  return had;
}

/** The names (never values) currently in the user store. */
export function listUserKeys(env: NodeJS.ProcessEnv, deps: KeyResolutionDeps = {}): string[] {
  const storePath = userKeyStorePath(env, deps);
  if (!isRegularFile(storePath) || dirIsSymlink(storePath)) return [];
  return [...readStoreEntries(storePath).keys()];
}

function readStoreEntries(storePath: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(storePath)) return entries;
  const text = readFileSync(storePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseStoreLine(line);
    if (parsed !== null) entries.set(parsed[0], parsed[1]);
  }
  return entries;
}

function writeStore(storePath: string, entries: Map<string, string>): void {
  const body = [...entries.entries()].map(([name, value]) => `${name}=${value}`).join("\n");
  const text = body.length > 0 ? `${body}\n` : "";
  // O_NOFOLLOW: a symlinked keys.env must never carry the write to its target (red-team
  // reproduced writing a secret through the link into an attacker-chosen file).
  const fd = openSync(storePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0, "utf8");
  } finally {
    closeSync(fd);
  }
  // mkdir/open modes are masked by umask; enforce the final bits explicitly.
  chmodSync(storePath, 0o600);
}

/** The store's line grammar, shared by read and the set-time round-trip check. */
function parseStoreLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const separator = trimmed.indexOf("=");
  if (separator <= 0) return null;
  const name = trimmed.slice(0, separator).trim();
  if (!ENV_NAME.test(name)) return null;
  return [name, trimmed.slice(separator + 1).trim()];
}
