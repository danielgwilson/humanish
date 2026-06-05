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
  ["anthropic_api_key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["e2b_api_key", /\be2b_[A-Za-z0-9]{16,}\b/g],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
  ["stripe_secret_key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ["huggingface_token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["jwt_like_token", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["db_connection_with_credentials", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@/\s]+:[^@/\s]+@\S+/g],
  ["npm_auth_token", /_authToken\s*=\s*[A-Za-z0-9._~+\/=-]{20,}/g],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}\b/g]
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
  ["provider_sandbox_id", /\b(?:killed sandbox|Provider cleanup killed sandbox|sandbox id|sandbox ID|sandbox:)\s+`?(?!\[redacted-sandbox-id\])[a-z0-9]{18,}`?/gi],
  ["stale_internal_docs_path", new RegExp(`\\bdocs/(?:${staleInternalDocDirs.join("|")})\\b`, "g")],
  ["stale_internal_context_name", new RegExp(`\\b(?:${staleInternalContextNames.join("|")})\\b`, "gi")],
  ...((process.env.MIMETIC_PUBLIC_DENYLIST_PATTERN ?? "")
    .split("\n")
    .map((pattern, index) => pattern.trim() ? [`custom_private_residue_${index + 1}`, new RegExp(pattern, "g")] : null)
    .filter(Boolean))
];

// PHI/PII detection. Labeled patterns keep false positives low in a repo full of
// numbers; bare SSN is specific. Email is allowlisted by safe domain so synthetic
// fixtures and the maintainer's own address do not trip the gate.
const piiPatterns = [
  ["us_ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["labeled_phone_number", /\b(?:phone|tel|telephone|mobile|cell|fax)\b[\s:=#]{0,3}\+?\d[\d().\s-]{7,}\d/gi],
  ["labeled_medical_record_number", /\b(?:mrn|medical[\s_-]?record(?:[\s_-]?(?:number|no|#))?|patient[\s_-]?id)\b[\s:=#]{0,3}[A-Za-z]*\d{3,}/gi],
  ["labeled_date_of_birth", /\b(?:dob|date[\s_-]?of[\s_-]?birth)\b[\s:=#]{0,3}\d/gi]
];

const emailAddress = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const allowedEmailDomains = new Set([
  "example.com",
  "example.test",
  "example.org",
  "example.net",
  "danielgwilson.com",
  "users.noreply.github.com",
  "github.com",
  "npmjs.com"
]);

const approvedBinaryAssets = new Map([
  ["docs/assets/mimetic-oss-lab-observer.png", "fad58feb832facd0b1a6828585936d07d5e766d0a1a09c39fea7ee3b5d3f23d7"]
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

  for (const [name, regex] of [...secretPatterns, ...privateResiduePatterns, ...piiPatterns]) {
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

  emailAddress.lastIndex = 0;
  for (const match of text.matchAll(emailAddress)) {
    const email = match[0].toLowerCase();
    const domain = email.slice(email.indexOf("@") + 1);
    if (approvedPublicCommitEmails.has(email) || allowedEmailDomains.has(domain)) continue;
    findings.push({
      file,
      line: lineNumberFor(text, match.index ?? 0),
      name: "unapproved_email_address",
      value: email
    });
  }

  scannedTextFiles += 1;
}

if (scannedTextFiles === 0 && verifiedBinaryAssets === 0) {
  findings.push({
    file: "<scan>",
    line: 0,
    name: "no_files_scanned",
    value: "scan inspected zero files; aborting (possible environment failure)"
  });
}

if (findings.length > 0) {
  console.error("public-surface scan failed");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.name}: ${finding.value}`);
  }
  process.exit(1);
}

console.log(`public-surface scan ok: ${scannedTextFiles} candidate text files checked, ${verifiedBinaryAssets} binary assets verified`);
