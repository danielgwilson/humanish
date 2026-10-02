// Qualify a Codex CLI release for the restricted launcher against an already-qualified baseline.
// Procedure: docs/architecture/restricted-codex-analysis.md, "Testing a Codex CLI release".
// Usage: pnpm codex:qualify <version> [--baseline <version>] [--live] [--out <dir>]
// Offline checks install both releases from npm and use a loopback provider: no model, no account.
// --live adds readiness, one analyst turn and two cancellations with the existing ChatGPT login.
// Linux only: process events come from strace, so on any other host qualification fails closed.
//
// Threat model. This is a drift detector. It catches a new vendor release that, in these
// scenarios, executes a program, connects to a destination or writes a file the baseline release
// did not, and it fails closed when the harness itself cannot see (a failed trace, sampler read
// or parse). A binary built to evade it is out of scope. Named limits, none of which it inspects:
// - io_uring: a ring's operations bypass the traced syscalls. io_uring_setup is traced and any
//   ring fails qualification, but what a ring would do is not seen.
// - Writes on connected sockets: write, writev and send without an address on a socket that is
//   already connected are not traced. The connect is, and the sampler lists held remotes.
// - SCM_RIGHTS: descriptors passed over a unix socket are not followed.
// - DNS payloads: a query to the resolver compares by destination, not by what it asks.
// - /proc/<pid>/ and the random suffixes of Codex's temporary names compare as patterns, so any
//   pid and any suffix match; snapshots keep how many entries share a pattern.
// - Paths inside a new mount namespace (bubblewrap's sandbox) compare as written, not as host
//   paths; work a process does in memory and writes through inherited descriptors are unseen.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  TESTED_CODEX_CLI_VERSIONS,
  parseCodexCliVersion,
} from "../src/actors/codex/codex-admission.ts";
import { restrictedCodexConfig } from "../src/actors/codex/restricted-policy.ts";
import { restrictedCodexNpmTarget } from "../src/actors/codex/restricted-executable.ts";
import { runLoopbackProbe, summarizeProbe } from "./lib/codex-loopback-probe.mjs";
import {
  PROBE_SCENARIOS,
  featureChecks,
  probeChecks,
  protocolChecks,
  selectBaseline,
} from "./lib/codex-qualify-checks.ts";
import { fileChecks, networkChecks, prepChecks } from "./lib/codex-qualify-io-checks.ts";
import { snapshot } from "./lib/file-snapshot.ts";
import { PATH_PATTERNS, findStrace, parseTrace, tracedCommand } from "./lib/strace.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { baseline: { type: "string" }, live: { type: "boolean" }, out: { type: "string" } },
});
const say = (line = "") => process.stdout.write(`${line}\n`);
const candidateVersion = positionals[0];
if (!candidateVersion || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(candidateVersion)) {
  say("Usage: pnpm codex:qualify <version> [--baseline <version>] [--live] [--out <dir>]");
  process.exit(2);
}
const host = `${process.platform}-${process.arch}`;
const target = restrictedCodexNpmTarget(process.platform, process.arch);
// TESTED_CODEX_CLI_VERSIONS is a Linux x64 list, and the live phases run isolated mode, which
// only Linux x64 and Apple Silicon support; refuse before installing anything.
if (!target || host !== "linux-x64") {
  say(
    `codex:qualify tests Linux x64 only (TESTED_CODEX_CLI_VERSIONS is its list); this host is ${process.platform}/${process.arch}.`,
  );
  process.exit(2);
}
// Both refusals come before anything is installed.
const strace = findStrace();
if (process.platform !== "linux" || !strace) {
  say(
    `codex:qualify qualifies Linux hosts only: its process checks trace every exec with strace -f, ` +
      `and ${process.platform === "linux" ? "strace is not on PATH" : `${process.platform} has no strace`}. ` +
      `Qualification fails closed here, and TESTED_CODEX_CLI_VERSIONS stays as it is.`,
  );
  process.exit(1);
}
const tested = TESTED_CODEX_CLI_VERSIONS;
const selected = selectBaseline(candidateVersion, tested, values.baseline);
if ("error" in selected) {
  say(selected.error);
  process.exit(2);
}
const baselineVersion = selected.baseline;
const out = path.resolve(values.out ?? `.humanish/codex-qualify/${candidateVersion}-${Date.now()}`);
mkdirSync(out, { recursive: true });

function install(version) {
  const prefix = path.join(out, `npm-${version}`);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "--no-save",
      `@openai/codex@${version}`,
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const modules = path.join(prefix, "node_modules", "@openai");
  const binary = [
    path.join(modules, target.packageName, "vendor", target.triple, "bin", "codex"),
    path.join(
      modules,
      "codex",
      "node_modules",
      "@openai",
      target.packageName,
      "vendor",
      target.triple,
      "bin",
      "codex",
    ),
    path.join(modules, "codex", "vendor", target.triple, "bin", "codex"),
  ].find((candidate) => existsSync(candidate));
  if (!binary) throw new Error(`no native ${target.triple} binary in @openai/codex@${version}`);
  const release = { version, binary };
  const reported = parseCodexCliVersion(
    inIsolatedHome(undefined, (env) => runTraced(release, "--version", ["--version"], env, [])),
  );
  if (reported !== version) throw new Error(`@openai/codex@${version} reports ${reported}`);
  const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  return { version, binary, sha256 };
}

// Every invocation of either binary runs under strace; these hold the preparatory commands' traces.
const prepTraces = {};
function runTraced(release, name, args, env, rewrites) {
  const traceDir = mkdtempSync(path.join(tmpdir(), "humanish-qualify-prep-"));
  const traceFile = path.join(traceDir, "strace.txt");
  const home = env.CODEX_HOME;
  const preexisting = [
    "<codex-home>",
    ...Object.keys(snapshot(home)).map((entry) => `<codex-home>/${entry}`),
  ];
  const command = tracedCommand(strace, traceFile, release.binary, args);
  try {
    const stdout = execFileSync(command.file, command.args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = parseTrace(
      readFileSync(traceFile, "utf8"),
      release.binary,
      [
        { label: "<codex-home>", path: home },
        ...rewrites,
        { label: "<codex>", path: path.dirname(path.dirname(release.binary)) },
      ],
      new Map(),
      process.cwd(),
    );
    (prepTraces[release.version] ??= {})[name] = {
      ok: parsed.error === null,
      survived: false,
      ...parsed,
      preexisting,
    };
    return stdout;
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
}

function inIsolatedHome(configToml, action) {
  const home = mkdtempSync(path.join(tmpdir(), "humanish-qualify-home-"));
  try {
    if (configToml !== undefined) writeFileSync(path.join(home, "config.toml"), configToml);
    return action({ ...process.env, HOME: home, CODEX_HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const PROTOCOL_FILES = [
  "v1/InitializeParams",
  "v2/ConfigReadResponse",
  "v2/GetAccountResponse",
  "v2/ListMcpServerStatusResponse",
  "v2/ThreadStartParams",
  "v2/ThreadStartResponse",
  "v2/TurnStartParams",
  "v2/TurnStartResponse",
  "v2/TurnStartedNotification",
  "v2/TurnCompletedNotification",
  "v2/ItemStartedNotification",
  "v2/ItemCompletedNotification",
  "v2/RawResponseItemCompletedNotification",
  "DynamicToolCallParams",
];
function protocol(release) {
  // The canonical path, since strace prints the path the kernel resolved for each open.
  const dir = path.join(realpathSync(out), `schema-${release.version}`);
  inIsolatedHome(undefined, (env) =>
    runTraced(
      release,
      "generate-json-schema",
      ["app-server", "generate-json-schema", "--experimental", "--out", dir],
      env,
      [{ label: "<schema-out>", path: dir }],
    ),
  );
  const read = (name) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8"));
  const kinds = (schema, key, field) =>
    (key ? schema.definitions[key].oneOf : schema.oneOf)
      .map((entry) => entry.properties[field].enum[0])
      .sort();
  return {
    threadItems: kinds(read("v2/ItemCompletedNotification"), "ThreadItem", "type"),
    responseItems: kinds(read("v2/RawResponseItemCompletedNotification"), "ResponseItem", "type"),
    serverRequests: kinds(read("ServerRequest"), null, "method"),
    serverNotifications: kinds(read("ServerNotification"), null, "method"),
    files: Object.fromEntries(PROTOCOL_FILES.map((name) => [name, JSON.stringify(read(name))])),
  };
}

function features(release, mode) {
  const config = restrictedCodexConfig("gpt-6-astra", {
    participantCodeMode: mode === "participant",
  });
  const text = inIsolatedHome(config.toml, (env) =>
    runTraced(release, `features list (${mode})`, ["features", "list"], env, []),
  );
  const table = {};
  for (const line of text.split("\n")) {
    const match = /^(\S+)\s+(.+?)\s+(true|false)$/.exec(line.trim());
    if (match) table[match[1]] = { stage: match[2], enabled: match[3] === "true" };
  }
  const pinned = Object.keys(config.overrides)
    .filter((key) => key.startsWith("features."))
    .map((key) => key.slice("features.".length));
  return { table, pinned };
}

async function probes(release, mode) {
  const results = {};
  for (const scenario of PROBE_SCENARIOS) {
    const participant = scenario === "participant" || scenario === "escape";
    const config = restrictedCodexConfig("gpt-6-astra", { participantCodeMode: participant });
    results[scenario] = summarizeProbe(
      await runLoopbackProbe({ binary: release.binary, scenario, ...config }),
    );
    say(`  ${mode} ${release.version} ${scenario}: turn ${results[scenario].turn}`);
  }
  return results;
}

function report(checks) {
  let failed = 0;
  for (const { check, pass, detail } of checks) {
    if (!pass) failed++;
    const shown = typeof detail === "string" ? detail : JSON.stringify(detail);
    // A failure prints its whole detail, including raw and normalized argv for an added exec.
    say(
      `${pass ? "PASS" : "FAIL"}  ${check}${shown && shown !== "[]" ? `\n      ${pass ? shown.slice(0, 2000) : shown}` : ""}`,
    );
  }
  return failed;
}

say(
  `Qualifying Codex CLI ${candidateVersion} against ${baselineVersion} on ${host}. Evidence: ${out}`,
);
say("This qualifies Linux only: every launch of either binary runs under strace -f.");
say(
  "It is a drift detector for honest vendor releases; a binary built to evade it is out of scope (limits: see the script header).",
);
say("Events compare exactly after these rewrites and nothing else:");
say("  <codex-home>          = the launch's private CODEX_HOME");
say("  <operator-codex-home> = the operator's Codex home (live operator-mode participant)");
say("  <probe>, <work>       = the offline probe's and a live launch's private directory");
say("  <schema-out>          = the schema generator's output directory");
say("  <codex>               = the release's native vendor directory");
say(`  file and socket paths only: ${PATH_PATTERNS.map((entry) => entry.label).join(", ")}`);
say("  addresses: <loopback> = the offline provider; live <chatgpt.com> and <resolver> are listed");
say("  Exec argv (argv[0] included) gets the literal rewrites only. A successful open compares");
say("  on the path the kernel reported (-yy); a `..` path the kernel did not resolve fails.");
say("  Skipped from file comparison, judged in order on each operation's outcome: an open that");
say("  resolved to a known-database -journal/-wal/-shm file, or its unlink; a file created with");
say(
  "  O_EXCL whose last successful operation is an unlink; a successful removal, with no `..`, of",
);
say("  a path an earlier operation of the run created in its own directory; and schema-generator");
say("  writes with no `..` that resolved inside the schema output directory.");
const releases = [install(baselineVersion), install(candidateVersion)];
for (const release of releases) say(`  ${release.version} native sha256 ${release.sha256}`);
const [base, cand] = releases;
const evidence = {
  host,
  baseline: base,
  candidate: cand,
  alreadyTested: tested.some((version) => version === candidateVersion),
};
evidence.protocol = { baseline: protocol(base), candidate: protocol(cand) };
evidence.features = {
  baseline: { analyst: features(base, "analyst"), participant: features(base, "participant") },
  candidate: { analyst: features(cand, "analyst"), participant: features(cand, "participant") },
};
say("Running loopback probes (about a minute each):");
evidence.probes = {
  baseline: await probes(base, "baseline"),
  candidate: await probes(cand, "candidate"),
};
evidence.prep = { baseline: prepTraces[base.version], candidate: prepTraces[cand.version] };
const checks = [
  ...protocolChecks(evidence.protocol.baseline, evidence.protocol.candidate),
  ...featureChecks(evidence.features.baseline, evidence.features.candidate),
  ...prepChecks(evidence.prep.baseline, evidence.prep.candidate),
  ...probeChecks(evidence.probes.baseline, evidence.probes.candidate),
  ...networkChecks(evidence.probes.baseline, evidence.probes.candidate),
  ...fileChecks(evidence.probes.baseline, evidence.probes.candidate),
];
if (values.live) {
  const { collectLive, daemonSockets, liveOutcomeChecks } =
    await import("./lib/codex-qualify-live.mjs");
  const { liveChecks } = await import("./lib/codex-qualify-io-checks.ts");
  say("Running live phases with the existing ChatGPT login, baseline first:");
  const live = { baseline: await collectLive(base, say), candidate: await collectLive(cand, say) };
  for (const [role, entry] of Object.entries(live))
    say(`  ${role} address labels: ${JSON.stringify(entry.labels)}`);
  evidence.live = live;
  const baselineOutcomes = liveOutcomeChecks(base, live.baseline.results);
  checks.push(
    ...liveChecks(live.baseline.observed, live.candidate.observed, daemonSockets()),
    {
      check: "live: the baseline's phases reached the same outcomes (so its launches compare)",
      pass: baselineOutcomes.every((entry) => entry.pass),
      detail: baselineOutcomes.filter((entry) => !entry.pass).map((entry) => entry.check),
    },
    ...liveOutcomeChecks(cand, live.candidate.results),
  );
}
evidence.checks = checks;
writeFileSync(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
const failed = report(checks);
say();
say(
  failed === 0
    ? `All ${checks.length} checks passed. ${values.live ? "Run" : "Run again with --live, then run"} a hosted study (see the doc section), add ${candidateVersion} to TESTED_CODEX_CLI_VERSIONS, and write a dated receipt. Launch admission does not change.`
    : `${failed} check(s) failed. Do not add ${candidateVersion} to TESTED_CODEX_CLI_VERSIONS; report what differs, and if it breaks humanish, add it to REFUSED_CODEX_CLI_VERSIONS with the issue.`,
);
process.exitCode = failed === 0 ? 0 : 1;
