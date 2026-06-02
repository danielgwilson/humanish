#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const skippedPaths = new Set([
  "pnpm-lock.yaml",
  "scripts/public-surface-scan.mjs"
]);

const skippedExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".pdf",
  ".tgz"
]);

const secretPatterns = [
  ["openai_secret_key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["jwt_like_token", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g]
];

const staleInternalDocDirs = ["operations"];
const staleInternalContextNames = [
  ["agent", "product"].join("-"),
  ["private", "factory"].join("-"),
  ["source", "system"].join("-"),
  ["tbrowser", "sim"].join("-")
];

const privateResiduePatterns = [
  ["absolute_local_user_path", /\/Users\/[A-Za-z0-9._-]+\//g],
  ["local_git_path", /\blocal_git\b/g],
  ["stale_internal_docs_path", new RegExp(`\\bdocs/(?:${staleInternalDocDirs.join("|")})\\b`, "g")],
  ["stale_internal_context_name", new RegExp(`\\b(?:${staleInternalContextNames.join("|")})\\b`, "gi")],
  ...((process.env.MIMETIC_PUBLIC_DENYLIST_PATTERN ?? "")
    .split("\n")
    .map((pattern, index) => pattern.trim() ? [`custom_private_residue_${index + 1}`, new RegExp(pattern, "g")] : null)
    .filter(Boolean))
];

const approvedBinaryAssets = new Map([
  ["docs/assets/mimetic-oss-lab-observer.png", "5891e05c6aa1d74ffde63485ce3752a6e1c5206f049b5adedefa195980b8c232"]
]);
const approvedPublicCommitEmails = new Set([
  "daniel@danielgwilson.com",
  ...(process.env.MIMETIC_PUBLIC_COMMIT_EMAIL_ALLOWLIST ?? "")
    .split("\n")
    .map((email) => email.trim())
    .filter(Boolean)
]);

const findings = [];

function trackedFiles() {
  const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  return raw.toString("utf8").split("\0").filter(Boolean);
}

function packageFiles() {
  try {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
    const packages = JSON.parse(raw);
    if (!Array.isArray(packages)) {
      findings.push({
        file: "<npm-pack>",
        line: 0,
        name: "package_payload_unreadable",
        value: "npm pack --dry-run --json did not return an array"
      });
      return [];
    }
    return packages.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.files)) return [];
      return entry.files
        .map((file) => file && typeof file === "object" && typeof file.path === "string" ? file.path : null)
        .filter(Boolean);
    });
  } catch (error) {
    findings.push({
      file: "<npm-pack>",
      line: 0,
      name: "package_payload_unreadable",
      value: error instanceof Error ? error.message.slice(0, 160) : "unknown error"
    });
    return [];
  }
}

function publicSurfaceFiles() {
  return [...new Set([...trackedFiles(), ...packageFiles()])].sort();
}

function gitRefExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function reachableCommitEmails() {
  const ref = (process.env.GITHUB_REF ?? "").startsWith("refs/pull/") && gitRefExists("HEAD^2")
    ? "HEAD^2"
    : "--all";
  try {
    const raw = execFileSync("git", ["log", ref, "--format=%ae%n%ce"], { encoding: "utf8" });
    return [...new Set(raw.split("\n").map((line) => line.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function shouldSkip(file) {
  if (skippedPaths.has(file)) return true;
  const lower = file.toLowerCase();
  return [...skippedExtensions].some((extension) => lower.endsWith(extension));
}

function isBinaryAsset(file) {
  const lower = file.toLowerCase();
  return [...skippedExtensions].some((extension) => lower.endsWith(extension));
}

function lineNumberFor(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

const githubNoreplyEmail = /^(?:noreply@github\.com|(?:github-actions\[bot\]|\d+\+[A-Za-z0-9-]+)@users\.noreply\.github\.com)$/;
for (const email of reachableCommitEmails()) {
  if (!githubNoreplyEmail.test(email) && !approvedPublicCommitEmails.has(email)) {
    findings.push({
      file: "<git-history>",
      line: 0,
      name: "unapproved_commit_email",
      value: email
    });
  }
}

let scannedTextFiles = 0;
let verifiedBinaryAssets = 0;
const files = publicSurfaceFiles();

for (const file of files) {
  if (isBinaryAsset(file)) {
    const approvedSha256 = approvedBinaryAssets.get(file);
    if (!approvedSha256) {
      findings.push({
        file,
        line: 0,
        name: "unapproved_binary_asset",
        value: "binary public asset must be explicitly allowlisted with sha256"
      });
      continue;
    }
    try {
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (sha256 !== approvedSha256) {
        findings.push({
          file,
          line: 0,
          name: "approved_binary_asset_hash_mismatch",
          value: sha256
        });
      } else {
        verifiedBinaryAssets += 1;
      }
    } catch {
      findings.push({
        file,
        line: 0,
        name: "approved_binary_asset_missing",
        value: approvedSha256
      });
    }
    continue;
  }

  if (shouldSkip(file)) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const [name, regex] of [...secretPatterns, ...privateResiduePatterns]) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      findings.push({
        file,
        line: lineNumberFor(text, match.index ?? 0),
        name,
        value: match[0].slice(0, 80)
      });
    }
  }

  scannedTextFiles += 1;
}

if (findings.length > 0) {
  console.error("public-surface scan failed");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.name}: ${finding.value}`);
  }
  process.exit(1);
}

console.log(`public-surface scan ok: ${scannedTextFiles} candidate text files checked, ${verifiedBinaryAssets} binary assets verified`);
