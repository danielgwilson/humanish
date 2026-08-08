// Provide the runtime a subject's serve pipeline needs, instead of failing at exit 127 (#371).
//
// The stock E2B `desktop` template ships python3 and curl but NO Node. That fact has now been
// rediscovered three times: the in-sandbox comms catch was rewritten from node to python3 in 0.29.0
// for exactly this reason, the terminal lane bootstraps Node explicitly, and the computer-use
// clone/local-tree route did neither — so any lab whose `serve.install` runs npm or pnpm died with
// `pnpm: command not found` AFTER a sandbox had been created and paid for.
//
// It failed invisibly up front: `lab inspect` was clean, the plan printed normally, the sandbox
// provisioned, and the first signal was a shell exit code attributed to "subject install failed".
// Nobody can debug that from the outside.
//
// The posture here is PROVIDE, not warn. An adopter writing a lab for a Node app should not have to
// know which binaries the template happens to carry — that is the harness's job, and the terminal
// lane already treats it that way. Detection is conservative and the bootstrap is skipped whenever
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

/** Major Node version installed when the template has none. Matches the terminal lane's choice. */
export const BOOTSTRAP_NODE_MAJOR = 22;

/**
 * The bootstrap command. Idempotent and cheap when Node is already present: it probes first and
 * exits 0 without touching apt, so a custom template that ships its own runtime is untouched.
 *
 * `sudo -n` (non-interactive) matches the terminal lane — the desktop user has passwordless sudo,
 * and failing fast is better than hanging on a password prompt nobody can answer.
 */
export function nodeBootstrapCommand(major: number = BOOTSTRAP_NODE_MAJOR): string {
  return [
    "if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then",
    '  echo "humanish: node $(node --version) already present; skipping bootstrap";',
    "else",
    `  curl -fsSL https://deb.nodesource.com/setup_${major}.x | sudo -n -E bash - &&`,
    "  sudo -n apt-get install -y nodejs;",
    "fi"
  ].join("\n");
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
    "fi"
  ].join("\n");
}
