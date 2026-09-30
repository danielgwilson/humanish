import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_SECTION_MARKER,
  agentsSection,
  firstRunGuidance,
  starterActorFor,
  type FirstRunEnvironment,
} from "../cli/first-run-path.js";
import { detectLocalAgents } from "../actors/local-agent/cli.js";
import { probeKeySources } from "../keys/key-resolution.js";

import {
  DEFAULT_LOCAL_BROWSER_STARTER,
  runtimeDirectories,
  starterFilesFor,
} from "./init-templates.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import { validateCwd } from "../run/project.js";
import { pathExists, readTextIfExists, validateInitProjectPaths } from "./init-paths.js";
import { planGitignore, planPackageJson, type PlannedWrite } from "./init-plan.js";

const INIT_RESPONSE_SCHEMA = "humanish.init-result.v1";

export interface InitOptions {
  cwd: string;
  dryRun?: boolean;
  yes?: boolean;
  /** Injected so a test can decide what credentials this machine appears to have. */
  env?: NodeJS.ProcessEnv;
  /** Configure the starter local-browser lab without making the operator edit YAML. */
  localBrowser?: { appUrl: string; mission?: string };
}

type InitMode = "dry-run" | "applied" | "needs-confirmation";

export interface InitChange {
  path: string;
  action: "create" | "mkdir" | "update" | "skip";
  target: "source" | "runtime" | "gitignore" | "package-json";
  reason: string;
}

export interface InitResult {
  schema: typeof INIT_RESPONSE_SCHEMA;
  ok: boolean;
  mode: InitMode;
  cwd: string;
  changes: InitChange[];
  warnings: string[];
  /**
   * The next one or two commands, already resolved against THIS machine's credentials. Present on
   * an applied init; absent on a dry-run or a failure, where there is no "next" yet.
   */
  nextSteps?: string[];
  error?: {
    code:
      | "HUMANISH_CONFIRMATION_REQUIRED"
      | "HUMANISH_INVALID_CWD"
      | "HUMANISH_INVALID_PACKAGE_JSON"
      | "HUMANISH_INVALID_LOCAL_BROWSER"
      | "HUMANISH_UNSAFE_PROJECT_PATH";
    message: string;
  };
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const requestedCwd = path.resolve(options.cwd);
  const mode = getMode(options);
  const warnings: string[] = [];
  const changes: InitChange[] = [];
  const writes: PlannedWrite[] = [];
  const dirs: Array<{ absolutePath: string; relativePath: string }> = [];
  const cwdCheck = await validateCwd(requestedCwd);

  if (cwdCheck) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: cwdCheck,
    };
  }
  const localBrowser = validateLocalBrowserStarter(options.localBrowser);
  if (!localBrowser.ok) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: { code: "HUMANISH_INVALID_LOCAL_BROWSER", message: localBrowser.message },
    };
  }
  const cwd = await realpath(requestedCwd);
  const preparedProjectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
  const initialPathCheck = await validateInitProjectPaths(cwd);
  if (initialPathCheck) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: initialPathCheck,
    };
  }

  // Leave instructions for the NEXT agent. AGENTS.md is the cross-vendor convention (agents.md) —
  // Codex, Claude Code, Cursor, Aider and others read it — and increasingly the thing that runs
  // `humanish init` is a coding agent doing setup on someone's behalf. Without this, the agent
  // that arrives tomorrow finds a humanish/ directory and no idea what to do with it.
  //
  // APPEND-ONLY and idempotent: an existing AGENTS.md is a file someone wrote, so humanish adds its
  // own section once and never rewrites theirs.
  {
    const agentsPath = "AGENTS.md";
    const existingAgents = await readTextIfExists(preparedProjectRoot, agentsPath);
    const section = agentsSection();
    if (existingAgents === null) {
      changes.push({
        path: agentsPath,
        action: "create",
        target: "source",
        reason: "how a coding agent runs humanish here",
      });
      writes.push({
        absolutePath: path.join(cwd, agentsPath),
        relativePath: agentsPath,
        contents: `# AGENTS.md\n${section}`,
        target: "source",
      });
    } else if (existingAgents.includes(AGENTS_SECTION_MARKER)) {
      changes.push({
        path: agentsPath,
        action: "skip",
        target: "source",
        reason: "humanish section already present",
      });
    } else {
      changes.push({
        path: agentsPath,
        action: "update",
        target: "source",
        reason: "append how a coding agent runs humanish",
      });
      writes.push({
        absolutePath: path.join(cwd, agentsPath),
        relativePath: agentsPath,
        contents: `${existingAgents.replace(/\s*$/, "")}\n${section}`,
        target: "source",
      });
    }
  }

  // The starter live lab is written for the brain this machine can actually use. Shipping it as
  // openai-computer-use on a machine with no provider key but a signed-in Codex would hand someone
  // a file that asks for a credential they were just told they do not need (#505).
  const machine = await firstRunEnvironment(options.env ?? process.env, requestedCwd);
  const starterActor = starterActorFor(machine);
  for (const file of starterFilesFor(starterActor, localBrowser.value)) {
    const absolutePath = path.join(cwd, file.path);
    const existing = await readTextIfExists(preparedProjectRoot, file.path);

    if (
      existing !== null &&
      options.localBrowser !== undefined &&
      file.path === "humanish/labs/local-browser.yaml"
    ) {
      warnings.push(
        "Skipped --local-browser/--local-mission: humanish/labs/local-browser.yaml already exists and init never overwrites it.",
      );
    }

    if (existing === null) {
      changes.push({
        path: file.path,
        action: "create",
        target: file.plane,
        reason: "public-safe starter file",
      });
      writes.push({
        absolutePath,
        relativePath: file.path,
        contents: file.contents,
        target: file.plane,
      });
    } else if (existing === file.contents) {
      changes.push({
        path: file.path,
        action: "skip",
        target: file.plane,
        reason: "already matches starter",
      });
    } else {
      changes.push({
        path: file.path,
        action: "skip",
        target: file.plane,
        reason: "existing file would not be overwritten",
      });
      warnings.push(
        `Skipped existing ${file.path}; humanish never overwrites user files during init.`,
      );
    }
  }

  for (const directory of runtimeDirectories) {
    const absolutePath = path.join(cwd, directory.path);
    const exists = await pathExists(preparedProjectRoot, directory.path);

    changes.push({
      path: directory.path,
      action: exists ? "skip" : "mkdir",
      target: directory.plane,
      reason: exists ? "already exists" : "ignored runtime directory",
    });

    if (!exists) {
      dirs.push({ absolutePath, relativePath: directory.path });
    }
  }

  const gitignorePlan = await planGitignore(preparedProjectRoot, cwd);
  changes.push(gitignorePlan.change);

  if (gitignorePlan.write) {
    writes.push(gitignorePlan.write);
  }

  const packagePlan = await planPackageJson(preparedProjectRoot, cwd);
  changes.push(packagePlan.change);
  warnings.push(...packagePlan.warnings);

  if (packagePlan.error) {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: packagePlan.error,
    };
  }

  if (packagePlan.write) {
    writes.push(packagePlan.write);
  }

  if (mode === "needs-confirmation") {
    return {
      schema: INIT_RESPONSE_SCHEMA,
      ok: false,
      mode,
      cwd: requestedCwd,
      changes,
      warnings,
      error: {
        code: "HUMANISH_CONFIRMATION_REQUIRED",
        message: "Re-run with --dry-run to inspect or --yes to apply safe generated changes.",
      },
    };
  }

  if (mode === "applied") {
    await assertPreparedSelectedOutputDirectory(preparedProjectRoot);
    const applyPathCheck = await validateInitProjectPaths(cwd);
    if (applyPathCheck) {
      return {
        schema: INIT_RESPONSE_SCHEMA,
        ok: false,
        mode,
        cwd: requestedCwd,
        changes,
        warnings,
        error: applyPathCheck,
      };
    }

    for (const directory of dirs) {
      await prepareContainedOutputDirectory(preparedProjectRoot, directory.relativePath);
    }

    for (const write of writes) {
      await writeContainedOutputFile(
        preparedProjectRoot,
        write.relativePath,
        write.contents,
        "utf8",
      );
    }
  }

  return {
    schema: INIT_RESPONSE_SCHEMA,
    ok: true,
    mode,
    cwd: requestedCwd,
    changes,
    warnings,
    // Resolved against THIS machine, because a next step that cannot work is worse than none.
    ...(mode === "applied" ? { nextSteps: firstRunGuidance(machine) } : {}),
  };
}

function validateLocalBrowserStarter(
  input: InitOptions["localBrowser"],
): { ok: true; value: { appUrl: string; mission: string } } | { ok: false; message: string } {
  const value = {
    appUrl: input?.appUrl.trim() || DEFAULT_LOCAL_BROWSER_STARTER.appUrl,
    mission: input?.mission?.trim() || DEFAULT_LOCAL_BROWSER_STARTER.mission,
  };
  let url: URL;
  try {
    url = new URL(value.appUrl);
  } catch {
    return {
      ok: false,
      message: "--local-browser must be a loopback HTTP(S) URL with an explicit port above 1023.",
    };
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password ||
    Number(url.port) < 1024
  ) {
    return {
      ok: false,
      message: "--local-browser must be a loopback HTTP(S) URL with an explicit port above 1023.",
    };
  }
  if (value.mission.length > 4_000)
    return { ok: false, message: "--local-mission must be 4,000 characters or fewer." };
  return { ok: true, value };
}

/**
 * What this machine can run, for the starter lab and the next steps. Local CLI status is
 * classified without returning its output or reading its credential file. Provider keys go
 * through the same discovery chain as every other command (process env, the project overlay,
 * `e2b auth login`, the `humanish keys set` store) and only their presence is read, never a value.
 * Local authentication status is not a fresh provider/account-validity test.
 */
async function firstRunEnvironment(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<FirstRunEnvironment> {
  const agents = await detectLocalAgents({ env }).catch(() => []);
  const keys = await probeKeySources(["OPENAI_API_KEY", "E2B_API_KEY"], {
    cwd,
    env,
    // The same home as os.homedir() for a real environment; a test's env picks its own. The gh
    // probe is skipped because init reads no GitHub credential.
    deps: { ...(env.HOME ? { homeDir: env.HOME } : {}), execText: async () => null },
  }).catch(() => []);
  const present = (name: string) => keys.some((key) => key.name === name && key.source !== null);
  let hasDesktopSdk = false;
  try {
    // Resolution from the PROJECT, not from wherever humanish itself lives.
    const { createRequire } = await import("node:module");
    createRequire(path.join(process.cwd(), "package.json")).resolve("@e2b/desktop");
    hasDesktopSdk = true;
  } catch {
    hasDesktopSdk = false;
  }
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(import.meta.url);
  return {
    installedInProject: here.startsWith(path.join(process.cwd(), "node_modules") + path.sep),
    hasDesktopSdk,
    hasE2bKey: present("E2B_API_KEY"),
    hasProviderKey: present("OPENAI_API_KEY"),
    localAgents: agents
      .filter((agent) => agent.authStatus === "authenticated")
      .map((agent) => agent.label),
    platform: process.platform,
    arch: process.arch,
  };
}

function getMode(options: InitOptions): InitMode {
  if (options.dryRun) {
    return "dry-run";
  }

  if (options.yes) {
    return "applied";
  }

  return "needs-confirmation";
}
