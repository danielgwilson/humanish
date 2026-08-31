#!/usr/bin/env node
// Meet the release candidate before anyone else does.
//
// `pnpm release:check` proves the code is internally consistent. It cannot tell you whether a
// person landing on this build can get anywhere with it — and that gap is not theoretical: 0.56.0
// passed every check and shipped a regression that hid a run's price exactly when someone was
// deciding whether to set up keys. A synthetic participant found it hours later. So the honest
// last gate before a tag is to run the product's own first-contact study against the CANDIDATE.
//
// It installs the PACKED TARBALL, not `humanish@latest`. Installing latest would measure the last
// release, which is the one artifact we already know about.
//
// This spends money and needs keys, so it is NOT part of release:check and never runs in CI. It is
// a deliberate act by a maintainer with a terminal. The lab's own caps hold product spend to $0;
// what it costs is the agent's tokens (about a dollar) plus a few sandbox-minutes.

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const LAB_ID = "release-dogfood";
const labPath = path.join(cwd, ".humanish", "labs", `${LAB_ID}.yaml`);

function fail(message) {
  console.error(`release:dogfood — ${message}`);
  process.exit(1);
}

for (const name of ["OPENAI_API_KEY"]) {
  if (!process.env[name] || process.env[name].trim().length === 0) {
    fail(`${name} is not set. This gate drives a real agent in a real sandbox; there is no offline mode.`);
  }
}
if (!process.env.E2B_API_KEY) {
  fail("E2B_API_KEY is not set. The participant needs a machine to work on.");
}

const version = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")).version;
console.log(`release:dogfood — packing ${version}`);
execFileSync("npm", ["pack", "--silent"], { cwd, stdio: ["ignore", "ignore", "inherit"] });
const tarball = (await readdir(cwd)).find((f) => f.startsWith("humanish-") && f.endsWith(".tgz"));
if (!tarball) fail("npm pack produced no tarball.");

// The committed first-contact fixture, with two changes: it goes live, and the candidate is put on
// the machine for it. Everything else — the mission that names no command, the caps, the
// deny-by-default credential policy — is the fixture's, unedited.
//
// ONE HONEST DIFFERENCE from the committed study, worth knowing when you read the report: the
// fixture has the participant DISCOVER and install humanish from its public surfaces, which would
// install whatever npm is serving — the last release, the one artifact we already know about. A
// pre-release gate has to meet the candidate, so this pre-installs it. The discovery half is not
// lost, it just lives in the committed fixture, which anyone can run for free as a dry run.
const fixture = await readFile(path.join(cwd, "humanish", "labs", "first-contact.yaml"), "utf8");
const productBlock = "  product:\n    name: humanish\n";
if (!fixture.includes(productBlock)) {
  fail("first-contact.yaml has changed shape — this gate rewrites its product block and cannot any more.");
}
let lab = fixture
  .replace("id: first-contact", `id: ${LAB_ID}`)
  .replace("  mode: dry-run # committed fixture stays contract-only", "  mode: live")
  .replace(
    productBlock,
    `${productBlock}    upload: ${tarball}\n    install: >-\n      sudo -n npm install -g "$HUMANISH_PRODUCT_UPLOAD"\n      && humanish init --yes\n`
  );

// THE MISSION HAS TO CHANGE, and the first version of this gate missed it. first-contact tells the
// participant to FIND and install humanish from its public surfaces — so it did exactly that:
// `npm install --save-dev humanish` from the registry, then `npx humanish`, which used the
// published release and never touched the candidate we had just installed for it. The gate spent a
// dollar telling us the LAST release worked. So the gate's copy says plainly that the build under
// test is already here and must not be fetched.
const missionAnchor = "    mission: >-\n";
if (!lab.includes(missionAnchor)) fail("first-contact.yaml has changed shape — cannot rewrite its mission.");
lab = lab.replace(
  missionAnchor,
  missionAnchor
    + "      The build you are evaluating is ALREADY INSTALLED on this machine as `humanish`, and it is\n"
    + "      a release candidate that is NOT on npm. Use the installed `humanish` command directly.\n"
    + "      Do NOT run `npm install humanish`, `npx humanish`, or otherwise fetch it from a registry —\n"
    + "      that would test a different build than the one under test.\n"
);

await mkdir(path.dirname(labPath), { recursive: true });
await writeFile(labPath, lab, "utf8");

console.log(`release:dogfood — sending a participant to meet humanish@${version} (product spend capped at $0)`);
let raw = "";
try {
  raw = execFileSync("node", ["dist/cli.js", "run", LAB_ID, "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"]
  });
} catch (error) {
  raw = error.stdout ?? "";
} finally {
  await rm(path.join(cwd, tarball), { force: true });
}

const start = raw.indexOf("{");
if (start < 0) fail("the run produced no JSON result.");
let result;
try {
  result = JSON.parse(raw.slice(start));
} catch {
  fail("the run's JSON result could not be parsed.");
}

const session = result.session ?? {};
console.log("");
console.log(`  verdict:  ${session.status ?? "unknown"} (${session.completionReason ?? "no reason recorded"})`);
console.log(`  run:      ${result.runId ?? "not created"}`);
console.log(`  no-spend: ${result.noSpend?.satisfied === true ? "satisfied" : "NOT satisfied"}`);
console.log("");

// Read the report. The verdict is a marker the participant sets; the paragraph underneath it is
// the actual finding, and a gate that only checks the marker throws away the reason it exists.
console.log("  What the participant said — read this before you tag:");
console.log("  " + "-".repeat(70));
const transcript = path.join(cwd, ".humanish", "runs", result.runId ?? "", "terminal-transcript.txt");
try {
  const messages = (await readFile(transcript, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event) => event?.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text);
  const last = messages.at(-1) ?? "(the participant said nothing)";
  console.log(last.split("\n").map((line) => `  ${line}`).join("\n"));
} catch {
  console.log("  (no transcript on disk — the run did not get far enough to report)");
}
console.log("  " + "-".repeat(70));
console.log("");

// VERIFY THE GATE TESTED THE CANDIDATE. Assuming it did is how the first version of this script
// passed while measuring the previous release: the participant is free to install whatever it
// likes, and the only proof it used ours is its own transcript.
try {
  const seen = await readFile(transcript, "utf8");
  const exercised = [...seen.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((match) => match[0]);
  const sawCandidate = exercised.includes(version);
  const others = [...new Set(exercised.filter((v) => v !== version && /^0\.\d+\.\d+$/.test(v)))];
  if (!sawCandidate) {
    fail(
      `the participant never exercised ${version}.`
      + (others.length > 0 ? ` It used ${others.join(", ")} instead — it fetched a published build.` : "")
      + " The gate cannot vouch for this candidate."
    );
  }
  if (others.length > 0) {
    console.log(`  note: other humanish versions also appear in the transcript (${others.join(", ")}).`);
  }
} catch (error) {
  fail(`could not read the transcript to confirm which build was exercised: ${String(error).slice(0, 160)}`);
}

if (result.ok !== true || session.status !== "passed") {
  fail(`the participant could not get there on this build. Do not tag ${version} until you know why.`);
}
if (result.noSpend?.satisfied !== true) {
  fail("the no-spend proof was not satisfied — the run spent where it declared it would not.");
}
console.log(`release:dogfood ok — a participant met humanish@${version} and got where it was going.`);
