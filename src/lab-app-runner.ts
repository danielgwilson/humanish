export const LAB_APP_RUNNER_PLAN_SCHEMA = "humanish.lab-app-runner-plan.v1";

export type LabAppFramework = "next" | "vite" | "generic" | "none";
export type LabPackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type LabInstallMode = "run" | "skip" | "when-missing";
export type LabSurfaceKind = "desktop" | "mobile";

export interface LabPackageJsonMetadata {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
}

export interface LabAppRunnerMetadata {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  hasNodeModules?: boolean;
  lockfiles?: string[];
  packageJson?: LabPackageJsonMetadata;
  packageManager?: string;
  preferredPort?: number;
  readinessIntervalMs?: number;
  readinessTimeoutMs?: number;
  scripts?: Record<string, string>;
}

export interface LabAppRunnerInstallPlan {
  command: string;
  mode: LabInstallMode;
  reason: string;
}

export interface LabAppRunnerDevServerPlan {
  command: string;
  framework: Exclude<LabAppFramework, "none">;
  port: number;
  reason: string;
  scriptName: string;
  url: string;
}

export interface LabAppRunnerReadinessPlan {
  command: string;
  intervalMs: number;
  timeoutMs: number;
  url: string;
}

export interface LabAppSurface {
  command: string;
  id: LabSurfaceKind;
  label: string;
  url: string;
  viewport: {
    deviceScaleFactor: number;
    height: number;
    isMobile: boolean;
    width: number;
  };
}

export interface LabAppRunnerShellPlan {
  commands: string[];
  script: string;
}

export interface LabAppRunnerPlan {
  devServer?: LabAppRunnerDevServerPlan;
  framework: LabAppFramework;
  install: LabAppRunnerInstallPlan;
  ok: boolean;
  packageManager: LabPackageManager;
  readiness?: LabAppRunnerReadinessPlan;
  schema: typeof LAB_APP_RUNNER_PLAN_SCHEMA;
  shell: LabAppRunnerShellPlan;
  surfaces: LabAppSurface[];
  warnings: string[];
}

interface ScriptCandidate {
  framework: Exclude<LabAppFramework, "none">;
  name: string;
  reason: string;
  rawCommand: string;
}

const DEFAULT_PORTS: Record<Exclude<LabAppFramework, "none">, number> = {
  generic: 3000,
  next: 3000,
  vite: 5173
};

const RUNNABLE_SCRIPT_NAMES = ["dev", "start", "serve", "preview"];
const SAFE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9:_-]+$/;

export function buildLabAppRunnerPlan(metadata: LabAppRunnerMetadata): LabAppRunnerPlan {
  const packageManager = detectPackageManager(metadata);
  const scripts = collectStringMap(metadata.packageJson?.scripts, metadata.scripts);
  const dependencies = collectStringMap(metadata.packageJson?.dependencies, metadata.dependencies);
  const devDependencies = collectStringMap(metadata.packageJson?.devDependencies, metadata.devDependencies);
  const install = buildInstallPlan(packageManager, metadata);
  const candidate = selectScriptCandidate({ dependencies, devDependencies, scripts });
  const warnings: string[] = [];

  if (!candidate) {
    warnings.push("No runnable app script was detected; desktop and mobile app surfaces were not planned.");
    const shell = renderLabAppRunnerShell({
      install,
      packageManager
    });
    return {
      schema: LAB_APP_RUNNER_PLAN_SCHEMA,
      ok: false,
      framework: "none",
      install,
      packageManager,
      shell,
      surfaces: [],
      warnings
    };
  }

  const port = selectPort(metadata.preferredPort, candidate.rawCommand, DEFAULT_PORTS[candidate.framework]);
  const url = `http://127.0.0.1:${port}`;
  const devServer: LabAppRunnerDevServerPlan = {
    command: buildStartCommand(packageManager, candidate, candidate.rawCommand),
    framework: candidate.framework,
    port,
    reason: candidate.reason,
    scriptName: candidate.name,
    url
  };
  const readiness: LabAppRunnerReadinessPlan = {
    command: `wait_for_http "$APP_URL" ${readinessTimeoutMs(metadata)} ${readinessIntervalMs(metadata)}`,
    intervalMs: readinessIntervalMs(metadata),
    timeoutMs: readinessTimeoutMs(metadata),
    url
  };
  const surfaces = buildSurfaces(url);
  const shell = renderLabAppRunnerShell({
    devServer,
    install,
    packageManager,
    readiness,
    surfaces
  });

  return {
    schema: LAB_APP_RUNNER_PLAN_SCHEMA,
    ok: true,
    devServer,
    framework: candidate.framework,
    install,
    packageManager,
    readiness,
    shell,
    surfaces,
    warnings
  };
}

export function renderLabAppRunnerShell(args: {
  devServer?: LabAppRunnerDevServerPlan;
  install: LabAppRunnerInstallPlan;
  packageManager: LabPackageManager;
  readiness?: LabAppRunnerReadinessPlan;
  surfaces?: LabAppSurface[];
}): LabAppRunnerShellPlan {
  const commands = [
    ...installCommands(args.install),
    ...(args.devServer ? [args.devServer.command] : []),
    ...(args.readiness ? [args.readiness.command] : []),
    ...(args.surfaces ?? []).map((surface) => surface.command)
  ];

  return {
    commands,
    script: [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      "export HUMANISH_PUBLIC_SAFE=1",
      `APP_PORT="\${APP_PORT:-${args.devServer?.port ?? DEFAULT_PORTS.generic}}"`,
      "APP_HOST=\"${APP_HOST:-0.0.0.0}\"",
      "APP_URL=\"${APP_URL:-http://127.0.0.1:${APP_PORT}}\"",
      "APP_RUNNER_LOG=\"${APP_RUNNER_LOG:-humanish-app-runner.log}\"",
      "",
      renderWaitFunction(),
      "",
      renderOpenFunction(),
      "",
      ...renderInstallShell(args.install),
      "",
      ...(args.devServer && args.readiness && args.surfaces
        ? [
            "echo \"== starting app server ==\"",
            `${args.devServer.command} > "$APP_RUNNER_LOG" 2>&1 &`,
            "APP_RUNNER_PID=$!",
            args.readiness.command,
            ...args.surfaces.map((surface) => surface.command),
            "wait \"$APP_RUNNER_PID\""
          ]
        : [
            "echo \"No runnable app script detected; skipping app surface launch.\"",
            "exit 2"
          ])
    ].join("\n")
  };
}

function detectPackageManager(metadata: LabAppRunnerMetadata): LabPackageManager {
  const hint = firstNonEmpty(metadata.packageManager, metadata.packageJson?.packageManager);
  const lockfiles = new Set((metadata.lockfiles ?? []).map((lockfile) => lockfile.trim()));

  if (hint?.startsWith("pnpm@") || lockfiles.has("pnpm-lock.yaml")) return "pnpm";
  if (hint?.startsWith("yarn@") || lockfiles.has("yarn.lock")) return "yarn";
  if (hint?.startsWith("bun@") || lockfiles.has("bun.lock") || lockfiles.has("bun.lockb")) return "bun";
  return "npm";
}

function buildInstallPlan(packageManager: LabPackageManager, metadata: LabAppRunnerMetadata): LabAppRunnerInstallPlan {
  const command = installCommand(packageManager, metadata.lockfiles ?? []);
  if (metadata.hasNodeModules === true) {
    return {
      command,
      mode: "skip",
      reason: "node_modules is already present."
    };
  }
  if (metadata.hasNodeModules === false) {
    return {
      command,
      mode: "run",
      reason: "node_modules is missing."
    };
  }
  return {
    command,
    mode: "when-missing",
    reason: "Install only if node_modules is absent at bootstrap time."
  };
}

function installCommand(packageManager: LabPackageManager, lockfiles: string[]): string {
  const locks = new Set(lockfiles);
  switch (packageManager) {
    case "pnpm":
      return locks.has("pnpm-lock.yaml")
        ? "pnpm install --frozen-lockfile --ignore-scripts"
        : "pnpm install --ignore-scripts";
    case "yarn":
      return locks.has("yarn.lock")
        ? "yarn install --frozen-lockfile --ignore-scripts"
        : "yarn install --ignore-scripts";
    case "bun":
      return locks.has("bun.lock") || locks.has("bun.lockb")
        ? "bun install --frozen-lockfile"
        : "bun install";
    case "npm":
      return locks.has("package-lock.json") || locks.has("npm-shrinkwrap.json")
        ? "npm ci --ignore-scripts --no-audit --no-fund"
        : "npm install --ignore-scripts --no-audit --no-fund";
  }
}

function selectScriptCandidate(args: {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}): ScriptCandidate | null {
  const allDependencies = { ...args.dependencies, ...args.devDependencies };
  const scriptEntries = runnableScriptEntries(args.scripts);

  const nextByCommand = scriptEntries.find((entry) => /\bnext\s+(dev|start)\b/.test(entry.command));
  if (nextByCommand) {
    return {
      framework: "next",
      name: nextByCommand.name,
      rawCommand: nextByCommand.command,
      reason: `Selected ${nextByCommand.name} because it matches Next.js app startup.`
    };
  }

  const viteByCommand = scriptEntries.find((entry) => /\bvite(\s|$)/.test(entry.command));
  if (viteByCommand) {
    return {
      framework: "vite",
      name: viteByCommand.name,
      rawCommand: viteByCommand.command,
      reason: `Selected ${viteByCommand.name} because it matches Vite app startup.`
    };
  }

  if (Object.prototype.hasOwnProperty.call(allDependencies, "next")) {
    const script = scriptEntries.find((entry) => entry.name === "dev" || entry.name === "start") ?? scriptEntries[0];
    if (script) {
      return {
        framework: "next",
        name: script.name,
        rawCommand: script.command,
        reason: `Selected ${script.name} because package metadata includes Next.js.`
      };
    }
  }

  if (Object.prototype.hasOwnProperty.call(allDependencies, "vite")) {
    const script = scriptEntries.find((entry) => entry.name === "dev" || entry.name === "start") ?? scriptEntries[0];
    if (script) {
      return {
        framework: "vite",
        name: script.name,
        rawCommand: script.command,
        reason: `Selected ${script.name} because package metadata includes Vite.`
      };
    }
  }

  const generic = scriptEntries.find((entry) => entry.name === "dev")
    ?? scriptEntries.find((entry) => entry.name === "start")
    ?? scriptEntries[0];
  if (!generic) {
    return null;
  }

  return {
    framework: "generic",
    name: generic.name,
    rawCommand: generic.command,
    reason: `Selected ${generic.name} because it is a common runnable app script.`
  };
}

function runnableScriptEntries(scripts: Record<string, string>): Array<{ command: string; name: string }> {
  const entries: Array<{ command: string; name: string }> = [];
  for (const name of RUNNABLE_SCRIPT_NAMES) {
    const command = scripts[name]?.trim();
    if (!command || !SAFE_SCRIPT_NAME_PATTERN.test(name)) {
      continue;
    }
    entries.push({ command, name });
  }
  return entries;
}

function selectPort(preferredPort: number | undefined, rawCommand: string, defaultPort: number): number {
  if (isValidPort(preferredPort)) return preferredPort;
  const scriptPort = extractPort(rawCommand);
  if (scriptPort) return scriptPort;
  return defaultPort;
}

function extractPort(rawCommand: string): number | null {
  const matches = [
    /(?:^|\s)(?:--port|-p)\s+([0-9]{2,5})(?:\s|$)/,
    /(?:^|\s)PORT=([0-9]{2,5})(?:\s|$)/
  ];
  for (const pattern of matches) {
    const value = pattern.exec(rawCommand)?.[1];
    const port = value ? Number(value) : NaN;
    if (isValidPort(port)) return port;
  }
  return null;
}

function buildStartCommand(
  packageManager: LabPackageManager,
  candidate: ScriptCandidate,
  rawCommand: string
): string {
  const runCommand = `${packageManager} run ${candidate.name}`;
  const envPrefix = 'HOST="$APP_HOST" PORT="$APP_PORT"';
  const extraArgs = frameworkArgs(candidate.framework, rawCommand);
  return `${envPrefix} ${runCommand}${extraArgs.length > 0 ? ` ${scriptArgumentSeparator(packageManager)}${extraArgs.join(" ")}` : ""}`;
}

function scriptArgumentSeparator(packageManager: LabPackageManager): string {
  return packageManager === "pnpm" ? "" : "-- ";
}

function frameworkArgs(framework: Exclude<LabAppFramework, "none">, rawCommand: string): string[] {
  if (framework === "generic") {
    return [];
  }

  const args: string[] = [];
  if (!hasHost(rawCommand)) {
    args.push(framework === "next" ? "--hostname" : "--host", '"$APP_HOST"');
  }
  if (!hasPort(rawCommand)) {
    args.push("--port", '"$APP_PORT"');
  }
  return args;
}

function hasHost(rawCommand: string): boolean {
  return /(?:^|\s)(?:--host|--hostname|-H)(?:\s|=)/.test(rawCommand) || /(?:^|\s)HOST=/.test(rawCommand);
}

function hasPort(rawCommand: string): boolean {
  return /(?:^|\s)(?:--port|-p)(?:\s|=)/.test(rawCommand) || /(?:^|\s)PORT=/.test(rawCommand);
}

function buildSurfaces(url: string): LabAppSurface[] {
  return [
    {
      command: 'open_lab_surface "$APP_URL" desktop 1440 960',
      id: "desktop",
      label: "Desktop app surface",
      url,
      viewport: {
        deviceScaleFactor: 1,
        height: 960,
        isMobile: false,
        width: 1440
      }
    },
    {
      command: 'open_lab_surface "$APP_URL" mobile 390 844',
      id: "mobile",
      label: "Mobile app surface",
      url,
      viewport: {
        deviceScaleFactor: 2,
        height: 844,
        isMobile: true,
        width: 390
      }
    }
  ];
}

function installCommands(install: LabAppRunnerInstallPlan): string[] {
  if (install.mode === "skip") return [];
  return [install.command];
}

function renderInstallShell(install: LabAppRunnerInstallPlan): string[] {
  switch (install.mode) {
    case "skip":
      return ["echo \"== dependencies already present; skipping install ==\""];
    case "run":
      return [
        "echo \"== installing dependencies ==\"",
        install.command
      ];
    case "when-missing":
      return [
        "if [ ! -d node_modules ]; then",
        "  echo \"== installing dependencies ==\"",
        `  ${install.command}`,
        "else",
        "  echo \"== dependencies already present; skipping install ==\"",
        "fi"
      ];
  }
}

function renderWaitFunction(): string {
  return `wait_for_http() {
  local url="$1"
  local timeout_ms="$2"
  local interval_ms="$3"
  node - "$url" "$timeout_ms" "$interval_ms" <<'NODE'
const [url, timeoutArg, intervalArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const intervalMs = Number(intervalArg);
const startedAt = Date.now();

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 5_000));
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

while (Date.now() - startedAt <= timeoutMs) {
  if (await probe()) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
console.error("Timed out waiting for HTTP readiness.");
process.exit(1);
NODE
}`;
}

function renderOpenFunction(): string {
  return `open_lab_surface() {
  local url="$1"
  local profile="$2"
  local width="$3"
  local height="$4"
  if command -v google-chrome >/dev/null 2>&1; then
    nohup google-chrome --no-first-run --no-default-browser-check --disable-default-apps --user-data-dir=".humanish-lab-\${profile}-chrome" --window-size="\${width},\${height}" "$url" >/dev/null 2>&1 &
  elif command -v firefox >/dev/null 2>&1; then
    nohup firefox --width "$width" --height "$height" "$url" >/dev/null 2>&1 &
  else
    echo "browser_open=skipped surface=$profile url=$url"
  fi
}`;
}

function readinessTimeoutMs(metadata: LabAppRunnerMetadata): number {
  return positiveInt(metadata.readinessTimeoutMs, 120_000);
}

function readinessIntervalMs(metadata: LabAppRunnerMetadata): number {
  return positiveInt(metadata.readinessIntervalMs, 1_000);
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isValidPort(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function collectStringMap(
  first: Record<string, string> | undefined,
  second: Record<string, string> | undefined
): Record<string, string> {
  return {
    ...(first ?? {}),
    ...(second ?? {})
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}
