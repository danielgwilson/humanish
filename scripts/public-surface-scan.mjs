#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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

const privateResiduePatterns = [
  ["absolute_local_user_path", /\/Users\/[A-Za-z0-9._-]+\//g],
  ["local_git_path", /\blocal_git\b/g],
  ["stale_internal_docs_path", /\bdocs\/(?:goals|operations|ramp)\b/g],
  ["stale_internal_context_name", /\b(?:terminal-product|private hosted feedback|upstream|tui-sim)\b/gi],
  ...((process.env.MIMETIC_PUBLIC_DENYLIST_PATTERN ?? "")
    .split("\n")
    .map((pattern, index) => pattern.trim() ? [`custom_private_residue_${index + 1}`, new RegExp(pattern, "g")] : null)
    .filter(Boolean))
];

function trackedFiles() {
  const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  return raw.toString("utf8").split("\0").filter(Boolean);
}

function reachableCommitEmails() {
  try {
    const raw = execFileSync("git", ["log", "--all", "--format=%ae%n%ce"], { encoding: "utf8" });
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

function lineNumberFor(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

const findings = [];

const githubNoreplyEmail = /^(?:noreply@github\.com|(?:github-actions\[bot\]|\d+\+[A-Za-z0-9-]+)@users\.noreply\.github\.com)$/;
for (const email of reachableCommitEmails()) {
  if (!githubNoreplyEmail.test(email)) {
    findings.push({
      file: "<git-history>",
      line: 0,
      name: "non_noreply_commit_email",
      value: email
    });
  }
}

for (const file of trackedFiles()) {
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
}

if (findings.length > 0) {
  console.error("public-surface scan failed");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.name}: ${finding.value}`);
  }
  process.exit(1);
}

console.log(`public-surface scan ok: ${trackedFiles().filter((file) => !shouldSkip(file)).length} candidate text files checked`);
