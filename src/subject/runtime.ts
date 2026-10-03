// Provide the runtime a subject's serve pipeline needs, instead of failing at exit 127.
//
// The stock E2B `desktop` template ships python3 and curl but no Node. So the in-sandbox comms
// catch runs on python3, the terminal route bootstraps Node explicitly, and this module provides
// Node for the computer-use clone/local-tree route. Without it, any study whose `serve.install`
// runs npm or pnpm dies with `pnpm: command not found` after its sandbox is created and paid for.
//
// That failure is invisible up front: `study show` is clean, the plan prints normally, the sandbox
// provisions, and the first signal is a shell exit code attributed to "subject install failed".
// Nobody can debug that from the outside.
//
// The harness provides the runtime instead of warning about it. An adopter writing a study for a Node app should not have to
// know which binaries the template happens to carry. That is the harness's job, and the terminal
// route already treats it that way. Detection is conservative and the bootstrap is skipped whenever
// a runtime is already present, so a custom template that ships Node pays nothing.

/** Package managers and runtimes whose absence on the stock template breaks a serve pipeline. */
const NODE_COMMANDS = ["npm", "npx", "pnpm", "yarn", "bun", "node", "vite", "next", "tsx"];

/**
 * Does this serve pipeline need a Node runtime? Matches a bare command word at a token boundary, so
 * `npm install` and `sudo -n npm ci` count while `my-npm-wrapper` or a path containing "node" does
 * not. Being wrong in the permissive direction only costs a skipped bootstrap probe; being wrong in
 * the strict direction costs a paid sandbox and a cryptic exit 127.
 */
export function needsNodeRuntime(commands: readonly (string | undefined)[]): boolean {
  const pattern = new RegExp(`(^|[\\s;&|(])(${NODE_COMMANDS.join("|")})([\\s;&|)]|$)`);
  return commands.some((command) => (command ? pattern.test(command) : false));
}

/**
 * Package managers that need their own install step after Node exists. npm and npx arrive with
 * Node; pnpm, yarn and bun do not, and `corepack enable` is the supported way to get the first two
 * without a second network fetch.
 */
export function corepackCommandFor(commands: readonly (string | undefined)[]): string | undefined {
  const joined = commands.filter((c): c is string => Boolean(c)).join("\n");
  const wantsPnpm = /(^|[\s;&|(])pnpm([\s;&|)]|$)/.test(joined);
  const wantsYarn = /(^|[\s;&|(])yarn([\s;&|)]|$)/.test(joined);
  if (!wantsPnpm && !wantsYarn) return undefined;
  // Probe first for the same reason as above: a template that already has it pays nothing.
  const binary = wantsPnpm ? "pnpm" : "yarn";
  return [
    `if command -v ${binary} >/dev/null 2>&1; then`,
    `  echo "humanish: ${binary} already present; skipping corepack";`,
    "else",
    "  sudo -n corepack enable >/dev/null 2>&1 || true;",
    `  corepack prepare ${binary}@latest --activate 2>/dev/null || sudo -n npm install -g ${binary};`,
    "fi",
  ].join("\n");
}
