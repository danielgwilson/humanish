// Live checks for `pnpm codex:qualify --live`: the real restricted launcher with the candidate
// binary and the existing ChatGPT login. One short analyst turn and two cancelled turns use account
// quota; readiness submits no turn. Output keeps codes, counts and statuses, never message text.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import {
  PARTICIPANT_FINAL_SCHEMA,
  participantToolSchema,
} from "../../src/actors/codex/restricted-participant-policy.ts";
import {
  checkRestrictedCodexSessionReadiness,
  createRestrictedCodexSession,
  runRestrictedCodexSession,
} from "../../src/actors/codex/restricted-session.ts";
import { privateWorkCheck, privateWorkDir } from "./codex-qualify-checks.ts";
import { snapshot } from "./file-snapshot.ts";
import {
  applyPathPatterns,
  findStrace,
  labelAddress,
  parseTrace,
  tracedCommand,
} from "./strace.ts";
import { observeProcesses } from "./process-observer.ts";

function rectangle() {
  const png = new PNG({ width: 96, height: 96 });
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      const inside = x >= 16 && x < 80 && y >= 28 && y < 68;
      png.data.set(inside ? [20, 60, 230, 255] : [255, 255, 255, 255], i);
    }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}
const analystRequest = (evidence, schema, signal) => ({
  model: "gpt-6-astra",
  instructions: "Analyze only supplied study evidence. Answer with the requested JSON object.",
  evidence,
  images: [{ evidenceId: "capture-1", dataUrl: rectangle() }],
  schema,
  maxOutputTokens: null,
  timeoutMs: 120_000,
  ...(signal ? { signal } : {}),
});

async function analystTurn(options) {
  const result = await runRestrictedCodexSession(
    analystRequest(
      "Report the rectangle's dominant color as one lowercase word and repeat the code BLUE-4821.",
      {
        type: "object",
        additionalProperties: false,
        required: ["color", "code"],
        properties: { color: { type: "string" }, code: { type: "string" } },
      },
    ),
    options,
  );
  return {
    status: result.status,
    errorCode: result.errorCode,
    usage: result.usage,
    usageComplete: result.usageComplete,
    answerMatches: result.output?.color === "blue" && result.output?.code === "BLUE-4821",
  };
}

async function analystCancellation(options) {
  const controller = new AbortController();
  let codexHome;
  let abortedAt = 0;
  const result = await runRestrictedCodexSession(
    analystRequest(
      "Report the rectangle color, repeat BLUE-4821 and describe the capture layout in about 150 words.",
      {
        type: "object",
        additionalProperties: false,
        required: ["color", "code", "summary"],
        properties: {
          color: { type: "string" },
          code: { type: "string" },
          summary: { type: "string" },
        },
      },
      controller.signal,
    ),
    {
      ...options,
      spawnFn: (file, args, settings) => {
        const child = options.spawnFn(file, args, settings);
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            if (line.includes('"codexHome"')) codexHome = JSON.parse(line).result?.codexHome;
            if (!abortedAt && line.includes('"item/agentMessage/delta"')) {
              abortedAt = performance.now();
              controller.abort();
            }
          }
        });
        return child;
      },
    },
  );
  return {
    status: result.status,
    errorCode: result.errorCode,
    dispatched: result.dispatched,
    usageComplete: result.usageComplete,
    abortedAfterDelta: abortedAt > 0,
    cancelToResultMs: abortedAt ? Math.round(performance.now() - abortedAt) : null,
    privateWorkRemoved: codexHome ? !existsSync(codexHome.replace(/\/home$/, "")) : null,
  };
}

async function participantCancellation(options) {
  const controller = new AbortController();
  let calls = 0;
  let lateCall = false;
  const session = createRestrictedCodexSession({
    ...options,
    participant: {
      authMode: "operator",
      reasoningEffort: "low",
      tool: {
        name: "humanish_ui",
        description:
          "Act on the participant's browser. In Code Mode use: const r = JSON.parse(await tools.humanish_ui({narration: '...', actions: [...]})); image(r.imageUrl).",
        inputSchema: participantToolSchema(false),
        async call() {
          if (controller.signal.aborted) lateCall = true;
          if (++calls === 1) setTimeout(() => controller.abort(), 300);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          return JSON.stringify({
            acknowledgments: [{ index: 0, status: "completed" }],
            imageUrl: rectangle(),
          });
        },
      },
    },
  });
  const result = await session.run({
    instructions: "You are a study participant using a web page through the humanish_ui tool.",
    evidence:
      'Call humanish_ui with narration "Looking" and actions [{"type":"screenshot"}], then keep exploring.',
    images: [{ evidenceId: "start", dataUrl: rectangle() }],
    schema: PARTICIPANT_FINAL_SCHEMA,
    maxOutputTokens: null,
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  const closed = await session.close();
  return {
    status: result.status,
    errorCode: result.errorCode,
    dispatched: result.dispatched,
    toolCalls: calls,
    lateCall,
    closeConfirmed: closed,
    cliVersion: session.cliVersion,
  };
}

/** The operator's managed daemon sockets; a live launch must not reach them. */
export function daemonSockets() {
  const link = path.join(
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    "app-server-control",
    "app-server-control.sock",
  );
  try {
    return [link, realpathSync(link)];
  } catch {
    return [link];
  }
}

// The account backend the launcher reaches; live destinations are compared under this label.
const BACKEND_HOST = "chatgpt.com";
/**
 * Live address labels: every address the backend host resolves to now, and each nameserver in
 * /etc/resolv.conf. Resolved before and after a release's phases, so a rotation mid-run is covered.
 */
async function liveAddressLabels(labels = new Map()) {
  const { promises: dns } = await import("node:dns");
  for (const lookup of [dns.resolve4, dns.resolve6])
    for (const address of await lookup(BACKEND_HOST).catch(() => []))
      labels.set(address, `<${BACKEND_HOST}>`);
  for (const line of readFileSync("/etc/resolv.conf", "utf8").split("\n")) {
    const server = /^nameserver\s+(\S+)/.exec(line)?.[1];
    if (server) labels.set(server, "<resolver>");
  }
  return labels;
}

/**
 * Runs the account-backed phases for one release through the real launcher and records every
 * launch of its binary under strace; app-servers are also sampled. The qualification runs this for
 * the baseline and the candidate and compares them launch by launch.
 */
export async function collectLive(release, say) {
  const { spawn } = await import("node:child_process");
  const strace = findStrace();
  const traces = mkdtempSync(path.join(tmpdir(), "humanish-qualify-live-"));
  const launches = [];
  const workDirs = new Set();
  let phase = "readiness";
  // A `--version` check can exit before the first sample, so it is traced only.
  const spawnFn = (file, args, settings) => {
    const traceFile = strace ? path.join(traces, `${launches.length}.txt`) : undefined;
    const command = traceFile ? tracedCommand(strace, traceFile, file, args) : { file, args };
    const child = spawn(command.file, command.args, settings);
    const home = settings.env?.CODEX_HOME ?? path.join(settings.env?.HOME ?? homedir(), ".codex");
    const appServer = args[0] === "app-server";
    const work = privateWorkDir(settings.cwd);
    if (work) workDirs.add(work);
    // An operator-mode participant uses the operator's own Codex home, which is never the run's.
    const privateHome = work !== undefined && home.startsWith(`${work}/`);
    const homeLabel = privateHome ? "<codex-home>" : "<operator-codex-home>";
    const preexisting = work
      ? Object.keys(snapshot(work)).map((entry) => {
          const full = applyPathPatterns(`${work}/${entry}`);
          return privateHome && (full === home || full.startsWith(`${home}/`))
            ? `<codex-home>${full.slice(home.length)}`
            : `<work>${full.slice(work.length)}`;
        })
      : [];
    launches.push({
      phase: appServer ? phase : `${phase} (${args.join(" ")})`,
      file,
      traceFile,
      preexisting,
      cwd: typeof settings.cwd === "string" ? settings.cwd : undefined,
      rewrites: [
        { label: homeLabel, path: home },
        ...(work ? [{ label: "<work>", path: work }] : []),
        { label: "<codex>", path: path.dirname(path.dirname(file)) },
      ],
      stop: appServer
        ? observeProcesses({
            rootPid: child.pid,
            ...(home.includes("humanish-codex-analysis-") ? { marker: `CODEX_HOME=${home}` } : {}),
          }).stop
        : undefined,
    });
    return child;
  };
  const options = { executable: release.binary, cliVersions: [release.version], spawnFn };
  const tag = `${release.version}`;
  const labels = await liveAddressLabels();
  const readiness = await checkRestrictedCodexSessionReadiness({ timeoutMs: 30_000 }, options);
  say(`  ${tag} readiness: ${readiness.status} ${readiness.errorCode ?? ""}`);
  phase = "analyst turn";
  const analyst = await analystTurn(options);
  say(`  ${tag} analyst turn: ${analyst.status} ${JSON.stringify(analyst.usage)}`);
  phase = "analyst cancellation";
  const cancel = await analystCancellation(options);
  say(`  ${tag} analyst cancellation: ${cancel.status} after ${cancel.cancelToResultMs} ms`);
  phase = "participant cancellation";
  const participant = await participantCancellation(options);
  say(
    `  ${tag} participant cancellation: ${participant.status}, ${participant.toolCalls} tool call(s)`,
  );
  const leftBehind = [...workDirs].filter((dir) => existsSync(dir));
  await liveAddressLabels(labels);
  const observed = [];
  for (const entry of launches) {
    const observation = entry.stop ? await entry.stop() : undefined;
    const parsed = entry.traceFile
      ? parseTrace(
          readFileSync(entry.traceFile, "utf8"),
          entry.file,
          entry.rewrites,
          labels,
          entry.cwd,
        )
      : undefined;
    const error = parsed
      ? parsed.error
      : "strace is not on PATH; codex:qualify needs Linux with strace";
    observed.push({
      phase: entry.phase,
      inspection: observation
        ? { ok: observation.ok, error: observation.error, samples: observation.samples }
        : null,
      processes: observation?.processes.map((item) => item.exe || item.comm) ?? [],
      aliveAfterStop: observation?.aliveAfterStop.map((item) => item.exe || item.comm) ?? [],
      uninspectable: observation?.uninspectable.map((item) => item.comm) ?? [],
      unixSockets: observation?.unixSockets ?? [],
      // Labeled like the trace, so a sampled remote compares with the baseline's.
      tcpRemotes: (observation?.tcpRemotes ?? []).map((remote) => labelAddress(remote, labels)),
      udpRemotes: (observation?.udpRemotes ?? []).map((remote) => labelAddress(remote, labels)),
      // strace runs with --kill-on-exit, so a traced survivor dies with it; the sampler's
      // aliveAfterStop covers detached processes.
      preexisting: entry.preexisting,
      trace: {
        ok: error === null,
        error,
        survived: false,
        execs: parsed?.execs ?? [],
        raw: parsed?.raw ?? [],
        net: parsed?.net ?? [],
        internal: parsed?.internal ?? [],
        files: parsed?.files ?? [],
        fileLog: parsed?.fileLog ?? [],
        ioUring: parsed?.ioUring ?? 0,
        rewrites: entry.rewrites,
      },
    });
  }
  rmSync(traces, { recursive: true, force: true });
  return {
    results: {
      readiness,
      analyst,
      cancel,
      participant,
      workCheck: privateWorkCheck([...workDirs], leftBehind),
    },
    labels: Object.fromEntries(labels),
    observed,
  };
}

/** Whether the candidate's live phases behaved as the launcher promises. */
export function liveOutcomeChecks(release, results) {
  const { readiness, analyst, cancel, participant, workCheck } = results;
  return [
    {
      check: "live: readiness passes without a model turn",
      pass: readiness.status === "completed" && !readiness.dispatched,
      detail: readiness.errorCode,
    },
    {
      check: "live: analyst turn completes with the expected answer and complete usage",
      pass: analyst.status === "completed" && analyst.answerMatches && analyst.usageComplete,
      detail: analyst.usage,
    },
    {
      check: "live: analyst cancellation after the first delta cleans up",
      pass:
        cancel.status === "cancelled" &&
        cancel.abortedAfterDelta &&
        cancel.privateWorkRemoved === true &&
        !cancel.usageComplete,
      detail: cancel,
    },
    {
      check: "live: participant cancellation admits no late tool call",
      pass:
        participant.status === "cancelled" &&
        participant.toolCalls === 1 &&
        !participant.lateCall &&
        participant.closeConfirmed &&
        participant.cliVersion === release.version,
      detail: participant,
    },
    workCheck,
  ];
}
