// How to add the optional @e2b/desktop peer depends on where humanish itself is installed: Node
// resolves the peer from humanish's own directory, not from the project a command runs in. Advice
// for the wrong place installs a copy Node never reads, and `npm i` in a directory whose manifest
// does not declare what its node_modules holds prunes it, so a command names only a project whose
// package.json declares humanish, or npm's or pnpm's global directory.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Manager = "npm" | "pnpm";

/** Where the running humanish is installed, read from its own file's real path. */
export type HumanishInstall =
  /** The nearest package.json declaring humanish: the working directory's, or `up` levels above. */
  | { kind: "project"; up: number; manager: Manager }
  /** A one-shot runner's cache: `npx humanish` or `pnpm dlx humanish`. */
  | { kind: "one-shot"; unmanagedCwd: boolean }
  /** The global directory npm installs to from here, or pnpm's global directory. */
  | { kind: "global"; manager: Manager }
  /** A source checkout of humanish, run with node or tsx. */
  | { kind: "checkout" }
  /** Anywhere else, such as another project or a global prefix npm is not configured for here. */
  | { kind: "other"; unmanagedCwd: boolean };

export interface InstallContext {
  cwd: string;
  /** The directory npm's global installs go to from this environment. */
  npmGlobalRoot: string;
  /** Whether the package.json in `directory` declares humanish as a dependency. */
  declaresHumanish: (directory: string) => boolean;
  /** Whether `npm i` from `directory` installs into a node_modules no package.json declares. */
  unmanaged: (directory: string) => boolean;
}

const NODE_MODULES = `${sep}node_modules${sep}`;

/** The install `modulePath` belongs to. */
export function classifyHumanishInstall(
  modulePath: string,
  context: InstallContext,
): HumanishInstall {
  const { cwd } = context;
  const segments = modulePath.split(sep);
  if (segments.includes("_npx") || segments.includes("dlx"))
    return { kind: "one-shot", unmanagedCwd: context.unmanaged(cwd) };
  if (modulePath.includes(`${sep}pnpm${sep}global${sep}`))
    return { kind: "global", manager: "pnpm" };
  const at = modulePath.indexOf(NODE_MODULES);
  if (at < 0) return { kind: "checkout" };
  // The first node_modules is the project's; pnpm keeps humanish's files deeper, in .pnpm.
  const root = modulePath.slice(0, at);
  if (root === context.npmGlobalRoot) return { kind: "global", manager: "npm" };
  if (cwd === root || cwd.startsWith(`${root}${sep}`)) {
    const manager = modulePath.includes(`${NODE_MODULES}.pnpm${sep}`) ? "pnpm" : "npm";
    // A workspace member declares humanish in its own package.json, and the root may not.
    for (let directory = cwd, up = 0; ; directory = dirname(directory), up += 1) {
      if (context.declaresHumanish(directory)) return { kind: "project", up, manager };
      if (directory === root) break;
    }
  }
  return { kind: "other", unmanagedCwd: context.unmanaged(cwd) };
}

/** The `prefix` an npmrc file sets, with `~` and `$HOME` expanded; undefined when it sets none. */
function npmrcPrefix(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const value = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(text)?.[1];
  if (value === undefined) return undefined;
  return value
    .replace(/^~(?=$|[\\/])/, homedir())
    .replace(/\$\{?HOME\}?/g, homedir())
    .replace(/^"(.*)"$/, "$1");
}

/**
 * The global root npm installs to from this environment, by npm's own order: the prefix in the
 * environment, then the user, global and built-in npmrc files (Homebrew sets it in the built-in
 * one), then the prefix the Node binary implies.
 */
function npmGlobalRoot(): string {
  const windows = process.platform === "win32";
  const nodePrefix = windows ? dirname(process.execPath) : dirname(dirname(process.execPath));
  const prefix =
    process.env.npm_config_prefix ||
    process.env.NPM_CONFIG_PREFIX ||
    npmrcPrefix(process.env.NPM_CONFIG_USERCONFIG || join(homedir(), ".npmrc")) ||
    npmrcPrefix(process.env.NPM_CONFIG_GLOBALCONFIG || join(nodePrefix, "etc", "npmrc")) ||
    npmrcPrefix(
      windows
        ? join(nodePrefix, "node_modules", "npm", "npmrc")
        : join(nodePrefix, "lib", "node_modules", "npm", "npmrc"),
    ) ||
    nodePrefix;
  return windows ? prefix : join(prefix, "lib");
}

function declaresHumanish(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
      const declared = manifest[field];
      return typeof declared === "object" && declared !== null && "humanish" in declared;
    });
  } catch {
    return false;
  }
}

/**
 * Whether `npm i` from `directory` would install into a node_modules no package.json declares: npm
 * installs into the nearest directory, this one or above, that holds either.
 */
function unmanaged(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, "package.json"))) return false;
    if (existsSync(join(current, "node_modules"))) return true;
    if (dirname(current) === current) return false;
  }
}

/** The running humanish's install, from this file's real path. */
export function humanishInstall(cwd = process.cwd()): HumanishInstall {
  return classifyHumanishInstall(fileURLToPath(import.meta.url), {
    cwd,
    npmGlobalRoot: npmGlobalRoot(),
    declaresHumanish,
    unmanaged,
  });
}

/**
 * Where this humanish is installed, the command that puts `spec` (`@e2b/desktop`, or a version of
 * it) where it will resolve, and that command as one or two sentences of advice.
 */
export function desktopPeerAdvice(
  install: HumanishInstall,
  spec = "@e2b/desktop",
): { where: string; command: string; advice: string } {
  const both = `npm i -D humanish ${spec}`;
  const relativeTo = "Node resolves the peer relative to humanish itself, so";
  switch (install.kind) {
    case "project": {
      // A directory option, not `cd`: one command, and no `&&` for Windows PowerShell 5.1.
      const ups = Array.from({ length: install.up }, () => "..").join("/");
      const command =
        install.manager === "pnpm"
          ? `pnpm add -D ${ups ? `--dir ${ups} ` : ""}${spec}`
          : `npm i -D ${ups ? `--prefix ${ups} ` : ""}${spec}`;
      const place = ups ? "the project above this directory" : "this project";
      return {
        where: "",
        command,
        advice: `Install it beside humanish in ${place}: \`${command}\`.`,
      };
    }
    case "global": {
      const command = install.manager === "pnpm" ? `pnpm add -g ${spec}` : `npm i -g ${spec}`;
      return {
        where: ", and humanish is installed globally",
        command,
        advice:
          `${relativeTo} install it globally too: \`${command}\`. That reaches humanish while ` +
          "the global directory is still the one it was installed in.",
      };
    }
    case "checkout":
      return {
        where: ", and humanish is running from a source checkout",
        command: "pnpm install",
        advice:
          spec === "@e2b/desktop"
            ? "Run `pnpm install` in the humanish checkout, which installs it as a dev dependency."
            : `Set ${spec} in the humanish checkout's package.json, then run \`pnpm install\` there.`,
      };
    case "one-shot":
    case "other": {
      const where =
        install.kind === "one-shot"
          ? ", and humanish is running from an npx or pnpm dlx cache"
          : ", and humanish is installed outside this project";
      const run = `\`${both}\` then \`npx humanish run <study>\``;
      return {
        where,
        command: both,
        advice: install.unmanagedCwd
          ? `${relativeTo} it has to be installed with humanish. From here npm would install into a node_modules folder that no package.json declares, and \`npm i\` would remove what it holds. In your project's directory, run ${run}.`
          : `${relativeTo} a copy installed here is not found. Install both into this project and run that copy: ${run}.`,
      };
    }
  }
}
