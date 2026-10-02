// Node 22 remains a supported LTS line. Pin the official release and trusted archive hashes:
// https://nodejs.org/en/about/previous-releases
// https://nodejs.org/dist/v22.23.2/SHASUMS256.txt (checked 2026-09-05)
// A checksum fetched alongside the archive at runtime would not pin what we trust.
const NODE_BOOTSTRAP_VERSION = "22.23.2";

// npm normally derives its global prefix from the real Node executable. This distribution
// lives under /opt, while its public executables use /usr/local/bin. Set only a missing
// built-in default; npm's environment, CLI, user and global config still take precedence.
export const NODE_NPM_PREFIX_SCRIPT = [
  'const fs = require("node:fs");',
  "const file = process.argv[1];",
  'let existing = "";',
  'try { existing = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }',
  'if (!/^[\\t ]*prefix[\\t ]*=/m.test(existing)) fs.appendFileSync(file, "\\nprefix=/usr/local\\n");',
].join(" ");

/**
 * The bound on one Node bootstrap attempt. The archive download is one curl with a 90 s limit and
 * one retry inside 120 s; the rest is local. A step that outlives this is stuck, not slow.
 */
export const NODE_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

/**
 * Install Node from the pinned official archive when the desktop has no working Node >=20 and
 * npm. The terminal route, desktop CLI studies and the subject serve pipeline share it. It needs no
 * apt: every network call is one bounded curl, so a stalled mirror fails the step within minutes.
 */
export const NODE_BOOTSTRAP_COMMAND = [
  "set -eu",
  "# humanish node-bootstrap",
  "node_major=0",
  `if command -v node >/dev/null 2>&1; then node_major=$(node -e 'console.log(Number(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0); fi`,
  `if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ "$node_major" -ge 20 ] && npm --version >/dev/null 2>&1; then`,
  // An explicit exit under set -e runs the stock login shell's failing clear_console logout hook
  // and turns this successful fast path into exit 1. Finish the compound command naturally.
  "  :",
  "else",
  `case "$(uname -s):$(uname -m)" in`,
  `  Linux:x86_64) node_arch=x64; node_sha=b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a ;;`,
  `  Linux:aarch64|Linux:arm64) node_arch=arm64; node_sha=013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30 ;;`,
  `  *) echo 'humanish: the Node bootstrap requires a supported Linux x64/arm64 desktop or working Node >=20 and npm' >&2; exit 1 ;;`,
  "esac",
  "for prerequisite in curl sha256sum tar gzip mktemp sudo; do",
  `  command -v "$prerequisite" >/dev/null 2>&1 || { echo "humanish: the Node bootstrap requires $prerequisite" >&2; exit 1; }`,
  "done",
  `node_archive="node-v${NODE_BOOTSTRAP_VERSION}-linux-$node_arch.tar.gz"`,
  `node_target="/opt/humanish/node-v${NODE_BOOTSTRAP_VERSION}-linux-$node_arch"`,
  `node_temp=$(mktemp -d /tmp/humanish-node.XXXXXX)`,
  `trap 'rm -rf "$node_temp"' EXIT`,
  `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 90 --retry 1 --retry-max-time 120 --output "$node_temp/$node_archive" "https://nodejs.org/dist/v${NODE_BOOTSTRAP_VERSION}/$node_archive"`,
  `(cd "$node_temp" && printf '%s  %s\\n' "$node_sha" "$node_archive" | sha256sum --check --status) || { echo 'humanish: the Node archive checksum did not match the trusted release' >&2; exit 1; }`,
  // Only a verified official archive reaches privileged extraction. The versioned install is
  // root-owned; subsequent ordinary and sudo shells find it through standard /usr/local/bin.
  "sudo -n mkdir -p /opt/humanish /usr/local/bin",
  `sudo -n tar --extract --gzip --file "$node_temp/$node_archive" --directory /opt/humanish --no-same-owner`,
  "for executable in node npm npx; do",
  `  sudo -n ln -sfn "$node_target/bin/$executable" "/usr/local/bin/$executable"`,
  "done",
  // Keep global product executables on the existing ordinary/sudo PATH (#679). The new
  // versioned distribution is the only config we modify; no user/global npmrc or profile.
  `sudo -n "$node_target/bin/node" -e '${NODE_NPM_PREFIX_SCRIPT}' "$node_target/lib/node_modules/npm/npmrc"`,
  "hash -r",
  `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' && npm --version >/dev/null`,
  // Product installation already uses sudo; detect a template whose sudo PATH cannot see Node
  // rather than changing global PATH or permissions to make it look supported.
  `sudo -n node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' && sudo -n npm --version >/dev/null`,
  "fi",
].join("\n");
