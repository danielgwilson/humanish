import { describe, expect, it } from "vitest";

import {
  OSS_REMOTE_TELEMETRY_SCHEMA,
  buildOssRemoteTelemetry,
  parseOssRemoteCompletion,
  redactOssRemoteTelemetryText,
  sanitizeOssRemoteTelemetryUrl
} from "../src/oss-remote-telemetry.js";

describe("OSS remote telemetry", () => {
  it("models passed completion JSON from public-safe remote evidence", () => {
    const telemetry = buildOssRemoteTelemetry({
      checkedAt: "2026-06-03T10:00:00.000Z",
      completionJson: JSON.stringify({
        completedAt: "2026-06-03T10:01:00.000Z",
        exitCode: 0,
        logTail: "npx mimetic verify --run latest\nnested verify passed",
        nestedObserverPresent: true,
        nestedVerifyStatus: "passed",
        reason: "Nested Mimetic proof completed and nested Observer path was checked.",
        status: "passed"
      }),
      nestedObserverPath: "/home/user/repo/.mimetic/runs/nested/observer/index.html",
      streamUrl: "https://stream.example/e2b"
    });

    expect(telemetry.schema).toBe(OSS_REMOTE_TELEMETRY_SCHEMA);
    expect(telemetry.status).toBe("passed");
    expect(telemetry.completion).toMatchObject({
      checkedAt: "2026-06-03T10:01:00.000Z",
      exitCode: 0,
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      present: true,
      status: "passed"
    });
    expect(telemetry.nestedObserver).toEqual({
      path: "[redacted-remote-path]",
      presence: "present"
    });
    expect(telemetry.actor.state).toBe("passed");
  });

  it("models failed completion JSON without green-lane inference", () => {
    const completion = parseOssRemoteCompletion({
      completedAt: "2026-06-03T10:02:00.000Z",
      exitCode: 1,
      logTail: "npx mimetic verify --run latest\nverification failed",
      nestedObserverPresent: false,
      nestedVerifyStatus: "failed",
      reason: "Bootstrap exited before nested Mimetic proof completed.",
      status: "failed"
    });

    expect(completion).toMatchObject({
      checkedAt: "2026-06-03T10:02:00.000Z",
      exitCode: 1,
      nestedObserverPresent: false,
      nestedVerifyPassed: false,
      present: true,
      status: "failed"
    });
    expect(completion.logTail).toContain("verification failed");

    const telemetry = buildOssRemoteTelemetry({
      checkedAt: "2026-06-03T10:03:00.000Z",
      completionJson: {
        exitCode: 1,
        nestedObserverPresent: false,
        nestedVerifyStatus: "failed",
        reason: "Bootstrap exited before nested Mimetic proof completed.",
        status: "failed"
      },
      processStateText: "pid=1234 exited with exit code 1"
    });

    expect(telemetry.status).toBe("failed");
    expect(telemetry.process.state).toBe("exited");
    expect(telemetry.nestedObserver.presence).toBe("missing");
  });

  it("models missing completion while retaining sanitized fallback log tail", () => {
    const fakeOpenAIKey = ["sk", "testsecretvalue1234567890"].join("-");
    const telemetry = buildOssRemoteTelemetry({
      checkedAt: "2026-06-03T10:04:00.000Z",
      completionJson: null,
      logTail: `bootstrap still running\nOPENAI_API_KEY=${fakeOpenAIKey}`,
      processStateText: "pid=4242 state=R running"
    });

    expect(telemetry.completion).toMatchObject({
      checkedAt: "2026-06-03T10:04:00.000Z",
      present: false,
      status: "missing"
    });
    expect(telemetry.completion.logTail).toContain("[redacted-openai-key]");
    expect(telemetry.status).toBe("running");
    expect(telemetry.redaction.fields).toContain("logTail");
  });

  it("classifies suspended actor process evidence as blocked telemetry", () => {
    const telemetry = buildOssRemoteTelemetry({
      actorStateText: "codex actor suspended after SIGTSTP",
      checkedAt: "2026-06-03T10:05:00.000Z",
      processStateText: "PID STAT COMMAND\n1234 T+ codex"
    });

    expect(telemetry.process.state).toBe("suspended");
    expect(telemetry.actor.state).toBe("suspended");
    expect(telemetry.status).toBe("blocked");
    expect(telemetry.actor.summary).toContain("suspended");
  });

  it("classifies a running app server from URL and status text", () => {
    const telemetry = buildOssRemoteTelemetry({
      appStatusText: "HTTP/1.1 200 OK - Vite ready at http://127.0.0.1:5173",
      appUrl: "http://127.0.0.1:5173",
      checkedAt: "2026-06-03T10:06:00.000Z"
    });

    expect(telemetry.app).toMatchObject({
      status: "running",
      url: "http://127.0.0.1:5173"
    });
    expect(telemetry.status).toBe("running");
  });

  it("redacts provider tokens and auth-like stream URL params", () => {
    const fakeBearer = ["Bearer", "abcdefghijklmnopqrstuvwxyz123456"].join(" ");
    const fakeE2bAuth = ["e2b", "authsecret123456789"].join("_");
    const fakeE2bKey = ["e2b", "secretvalue1234567890"].join("_");
    const fakeGitHubToken = ["ghp", "secretgithubtoken123456"].join("_");
    const fakeGitHubPat = ["github", "pat", "secretgithubtoken1234567890"].join("_");
    const fakeOpenAIKey = ["sk", "secretopenaitoken1234567890"].join("-");
    const fakeOpenAIProjectKey = ["sk", "proj", "secretopenaitoken1234567890"].join("-");
    const streamUrl = `https://stream.e2b.dev/sandbox?authKey=${fakeE2bAuth}&token=${fakeGitHubToken}&viewOnly=true&resize=scale`;
    const telemetry = buildOssRemoteTelemetry({
      actorStateText: fakeBearer,
      appStatusText: `OPENAI_API_KEY=${fakeOpenAIProjectKey}`,
      appUrl: `https://app.example.test/callback?access_token=${fakeOpenAIKey}&ok=1`,
      checkedAt: "2026-06-03T10:07:00.000Z",
      completionJson: {
        logTail: `GH_TOKEN=${fakeGitHubPat}\nE2B_API_KEY=${fakeE2bKey}`,
        reason: `used ${fakeGitHubToken} and ${fakeOpenAIKey}`,
        status: "blocked"
      },
      streamUrl
    });

    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain("secretopenaitoken");
    expect(serialized).not.toContain("secretgithubtoken");
    expect(serialized).not.toContain("secretvalue");
    expect(serialized).toContain("[redacted-openai-key]");
    expect(serialized).toContain("[redacted-github-token]");
    expect(serialized).toContain("[redacted-e2b-key]");
    expect(telemetry.stream.url).toBe("https://stream.e2b.dev/sandbox?authKey=[redacted-url-param]&token=[redacted-url-param]&viewOnly=true&resize=scale");
    expect(telemetry.app.url).toBe("https://app.example.test/callback?access_token=[redacted-url-param]&ok=1");
    expect(telemetry.redaction.redacted).toBe(true);
    expect(telemetry.redaction.fields).toEqual([
      "actorStateText",
      "appStatusText",
      "appUrl",
      "streamUrl"
    ]);

    expect(redactOssRemoteTelemetryText(`E2B_API_KEY=${fakeE2bKey}`)).toContain("[redacted-e2b-key]");
    expect(sanitizeOssRemoteTelemetryUrl(streamUrl)).toContain("authKey=[redacted-url-param]");
  });

  it("redacts remote sandbox filesystem paths from public-safe telemetry", () => {
    const text = "project=/home/user/repo-01 bootstrap=/home/user/.mimetic-oss-lab/repo-01/bootstrap.sh package=/tmp/mimetic-cli-0.1.8.tgz";
    const redacted = redactOssRemoteTelemetryText(text);

    expect(redacted).toContain("[redacted-remote-path]");
    expect(redacted).not.toContain("/home/user");
    expect(redacted).not.toContain("/tmp/mimetic-cli");
  });

  it("does not redact Codex approval flags as provider tokens", () => {
    const text = "codex exec --ask-for-approval never";
    expect(redactOssRemoteTelemetryText(text)).toBe(text);
  });
});
