// Loopback restriction probe for `pnpm codex:qualify`. It drives a Codex app-server with the
// Humanish restricted config, but points the model provider at a local no-auth Responses endpoint
// whose server-sent events are scripted. Nothing reaches a model or an account. Event shapes follow
// codex-rs/core/tests/common/responses.rs.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshot, snapshotDiff } from "./file-snapshot.ts";
import { applyPathPatterns, findStrace, parseTrace, tracedCommand } from "./strace.ts";
import { observeProcesses, waitForChild } from "./process-observer.ts";

const CANARY = "HOST_CANARY_7f3a91";

const created = (id) => ({ type: "response.created", response: { id } });
const completed = (id) => ({
  type: "response.completed",
  response: {
    id,
    usage: {
      input_tokens: 10,
      input_tokens_details: null,
      output_tokens: 2,
      output_tokens_details: null,
      total_tokens: 12,
    },
  },
});
const message = (id, text) => ({
  type: "response.output_item.done",
  item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] },
});
const call = (call_id, name, args, namespace) => ({
  type: "response.output_item.done",
  item: {
    type: "function_call",
    call_id,
    name,
    arguments: JSON.stringify(args),
    ...(namespace ? { namespace } : {}),
  },
});
const custom = (call_id, name, input) => ({
  type: "response.output_item.done",
  item: { type: "custom_tool_call", call_id, name, input },
});
const answer = (n) => [created(`resp-${n}`), message(`msg-${n}`, "{}"), completed(`resp-${n}`)];

// Every call a restricted analyst must refuse, including tools only other feature sets expose.
const DENIALS = [
  custom("call-exec", "exec", "text('probe');"),
  call("call-0", "spawn_agent", { message: "probe" }),
  call("call-1", "spawn_agent", { message: "probe" }, "collaboration"),
  call("call-2", "collaboration.spawn_agent", { message: "probe" }),
  call("call-3", "wait", { cell_id: "1", yield_time_ms: 1000 }),
  call("call-4", "skills__list", {}),
  call("call-5", "skills__read", { name: "probe" }),
  call("call-6", "exec_command", { cmd: `echo ${CANARY}` }),
  call("call-7", "shell", { command: ["echo", CANARY] }),
  custom(
    "call-8",
    "apply_patch",
    "*** Begin Patch\n*** Add File: probe.txt\n+probe\n*** End Patch\n",
  ),
  call("call-9", "view_image", { path: "/etc/hostname" }),
  call("call-10", "update_plan", { plan: [] }),
  call("call-11", "send_message_to_user_async", { message: "probe" }),
  call("call-12", "post_message", { channel: "probe", message: "probe" }, "collaboration"),
  call("call-13", "list_mcp_resources", {}),
  call("call-14", "clock__curr_time", {}),
  call("call-15", "web_search", { query: "probe" }),
  call("call-16", "sleep", { seconds: 1 }),
];
const QUESTION = "Synthetic question must not reach a user";
const participantCode =
  "const r = JSON.parse(await tools.humanish_ui({kind: 'observe'})); text(JSON.stringify(r));";
const escapeCode = (port) =>
  [
    "const names = Object.keys(tools).sort(); text(JSON.stringify({names}));",
    // The error text separates a refusal from a rejected argument; the check compares it.
    "for (const n of names) { if (n === 'humanish_ui') continue; try { await tools[n]({}); text(JSON.stringify({n, ok: true})); } catch (e) { text(JSON.stringify({n, ok: false, error: String(e && e.message !== undefined ? e.message : e).slice(0, 300)})); } }",
    "text(JSON.stringify({globals: [typeof process, typeof require, typeof fetch, typeof Deno]}));",
    `try { await fetch('http://127.0.0.1:${port}/escape'); text('fetch-reached'); } catch (e) { text('fetch-refused'); }`,
  ].join("\n");

function script(scenario, port) {
  return (n) => {
    if (n > 1 || scenario === "inventory") return answer(n);
    if (scenario === "denials") return [created("resp-1"), ...DENIALS, completed("resp-1")];
    if (scenario === "questions")
      return [
        created("resp-1"),
        call("call-ui-0", "request_user_input", {
          questions: [
            {
              id: "canary",
              header: "Canary",
              question: QUESTION,
              options: [
                { label: "A", description: "First" },
                { label: "B", description: "Second" },
              ],
            },
          ],
        }),
        call("call-ui-1", "request_user_input_async", {
          questions: [{ title: QUESTION, options: null }],
        }),
        completed("resp-1"),
      ];
    const code = scenario === "participant" ? participantCode : escapeCode(port);
    return [created("resp-1"), custom("code-1", "exec", code), completed("resp-1")];
  };
}

function loopbackServer(scenario) {
  const requests = [];
  let respond;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      requests.push({ url: req.url, body: json });
      if (req.method !== "POST" || !req.url.endsWith("/responses")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const n = requests.filter((entry) => entry.url.endsWith("/responses")).length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of respond(n))
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      respond = script(scenario, server.address().port);
      resolve({ server, requests, port: server.address().port });
    }),
  );
}

function jsonRpc(child, onServerRequest) {
  const pending = new Map();
  const notifications = [];
  const serverRequests = [];
  let buffer = "";
  let nextId = 1;
  let turnDone;
  const turnFinished = new Promise((resolve) => (turnDone = resolve));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.method === undefined) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (entry && msg.error) entry.reject(msg.error);
        else if (entry) entry.resolve(msg.result);
      } else if (msg.id !== undefined) {
        serverRequests.push({ method: msg.method, tool: msg.params?.tool ?? null });
        child.stdin.write(JSON.stringify({ id: msg.id, ...onServerRequest(msg) }) + "\n");
      } else {
        notifications.push({ method: msg.method, params: msg.params });
        if (msg.method === "turn/completed") turnDone(msg.params);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ method, params }) + "\n");
  return { rpc, notify, notifications, serverRequests, turnFinished };
}

async function drive(client, { cwd, overrides, participant, timeoutMs }) {
  const initialize = await client.rpc("initialize", {
    clientInfo: { name: "humanish_analysis", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  const config = await client.rpc("config/read", { includeLayers: true, cwd });
  const dynamicTools = participant
    ? [
        {
          type: "function",
          name: "humanish_ui",
          description: "Operate the participant desktop.",
          inputSchema: {
            type: "object",
            properties: { kind: { type: "string" } },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      ]
    : [];
  const thread = await client.rpc("thread/start", {
    cwd,
    ephemeral: true,
    experimentalRawEvents: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    model: "gpt-6-astra",
    modelProvider: "loopback",
    allowProviderModelFallback: false,
    environments: [],
    runtimeWorkspaceRoots: [],
    dynamicTools,
    baseInstructions: "Analyze only supplied study evidence.",
    config: overrides,
  });
  const mcp = await client.rpc("mcpServerStatus/list", { limit: 100 });
  await client.rpc("turn/start", {
    threadId: thread.thread.id,
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    environments: [],
    runtimeWorkspaceRoots: [],
    effort: "low",
    model: "gpt-6-astra",
    outputSchema: { type: "object", additionalProperties: false, properties: {} },
    input: [{ type: "text", text: "Probe evidence.", text_elements: [] }],
  });
  const turn = await Promise.race([
    client.turnFinished,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  return { initialize, config, thread, mcp, turn };
}

/** Runs one scenario against one binary and returns the raw capture; nothing is printed. */
export async function runLoopbackProbe({ binary, scenario, toml, overrides, timeoutMs = 60_000 }) {
  const participant = scenario === "participant" || scenario === "escape";
  const work = mkdtempSync(path.join(tmpdir(), "humanish-qualify-probe-"));
  const [home, cwd, scratch] = ["home", "cwd", "scratch"].map((name) => path.join(work, name));
  for (const directory of [home, cwd, scratch]) mkdirSync(directory, { mode: 0o700 });
  // The product home holds only config.toml and an auth link; the canary sits in the project.
  writeFileSync(path.join(cwd, "AGENTS.md"), `${CANARY} project instructions\n`);
  const loopback = await loopbackServer(scenario);
  writeFileSync(
    path.join(home, "config.toml"),
    toml.replace('model_provider = "openai"', 'model_provider = "loopback"') +
      `[model_providers.loopback]\nname = "loopback"\nbase_url = "http://127.0.0.1:${loopback.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
    { mode: 0o600 },
  );
  const env = { HOME: home, CODEX_HOME: home, TMPDIR: scratch };
  // The trace sits outside the work directory so the snapshots see only what the app-server wrote.
  const traceDir = mkdtempSync(path.join(tmpdir(), "humanish-qualify-trace-"));
  let before;
  try {
    before = normalizedSnapshot(work);
  } catch (error) {
    before = { error: String(error) };
  }
  for (const key of ["PATH", "LANG", "USER", "LOGNAME"])
    if (process.env[key]) env[key] = process.env[key];
  // Under strace every execve of the app-server and its descendants is recorded; the sampler
  // watches the app-server's tree and anything carrying this private home for sockets and survivors.
  const strace = findStrace();
  const traceFile = path.join(traceDir, "strace.txt");
  const command = strace
    ? tracedCommand(strace, traceFile, binary, ["app-server", "--strict-config"])
    : { file: binary, args: ["app-server", "--strict-config"] };
  const child = spawn(command.file, command.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const exited = new Promise((resolve) => child.on("close", resolve));
  const appServer = strace ? await waitForChild(child.pid, realpathSync(binary)) : child.pid;
  const observer = observeProcesses({
    rootPid: appServer ?? child.pid,
    marker: `CODEX_HOME=${home}`,
  });
  const toolCalls = [];
  const client = jsonRpc(child, (msg) => {
    if (participant && msg.method === "item/tool/call" && msg.params?.tool === "humanish_ui") {
      toolCalls.push(msg.params.arguments);
      const text = JSON.stringify({
        acknowledgments: [],
        imageUrl: "data:image/png;base64,c3ludGhldGlj",
      });
      return { result: { success: true, contentItems: [{ type: "inputText", text }] } };
    }
    return { error: { code: -32601, message: "probe refuses" } };
  });
  const capture = { scenario, error: null };
  try {
    Object.assign(
      capture,
      await drive(client, {
        cwd,
        overrides: { ...overrides, model_provider: "loopback" },
        participant,
        timeoutMs,
      }),
    );
  } catch (error) {
    capture.error = JSON.stringify(error).slice(0, 500);
  } finally {
    // Stop the app-server itself; strace exits once no traced process remains.
    // The app-server may already have exited; that is recorded, not thrown.
    try {
      if (appServer !== undefined) process.kill(appServer, "SIGTERM");
      else child.kill("SIGTERM");
      capture.exitedBeforeStop = false;
    } catch {
      capture.exitedBeforeStop = true;
    }
    const survived = !(await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]));
    if (survived) {
      child.kill("SIGKILL");
      await exited;
    }
    capture.observation = await observer.stop();
    capture.exit = { code: child.exitCode, signal: child.signalCode };
    capture.trace = strace
      ? traceSummary(
          readFileSync(traceFile, "utf8"),
          binary,
          appServer,
          survived,
          [
            { label: "<codex-home>", path: home },
            { label: "<probe>", path: work },
            { label: "<codex>", path: path.dirname(path.dirname(binary)) },
          ],
          new Map([[`127.0.0.1:${loopback.port}`, "<loopback>"]]),
          cwd,
        )
      : { ...NO_STRACE, survived };
    capture.workDir = work;
    capture.loopbackPort = loopback.port;
    loopback.server.close();
    capture.files = {
      error: before.error ?? null,
      added: [],
      removed: [],
      retyped: [],
      resized: [],
    };
    if (!before.error) {
      try {
        capture.files = { error: null, ...snapshotDiff(before, normalizedSnapshot(work)) };
      } catch (error) {
        capture.files.error = String(error);
      }
      capture.preexisting = [
        "<probe>",
        ...Object.keys(before).map((entry) =>
          entry === "home" || entry.startsWith("home/")
            ? `<codex-home>${entry.slice(4)}`
            : `<probe>/${entry}`,
        ),
      ];
    }
    rmSync(work, { recursive: true, force: true });
    rmSync(traceDir, { recursive: true, force: true });
  }
  return {
    ...capture,
    requests: loopback.requests,
    notifications: client.notifications,
    serverRequests: client.serverRequests,
    toolCalls,
  };
}

/** A snapshot of the work directory with random temporary names replaced by the path patterns. */
function normalizedSnapshot(work) {
  // Random temporary names collapse to one pattern; a numbered suffix keeps each entry, so a
  // candidate that leaves two files where the baseline left one still shows the extra one.
  const entries = {};
  for (const [entry, value] of Object.entries(snapshot(work))) {
    const name = applyPathPatterns(`/${entry}`).slice(1);
    let unique = name;
    for (let n = 2; unique in entries; n++) unique = `${name}#${n}`;
    entries[unique] = value;
  }
  return entries;
}

const NO_STRACE = {
  ok: false,
  error: "strace is not on PATH; codex:qualify needs Linux with strace",
  root: null,
  execs: [],
  raw: [],
  net: [],
  files: [],
  fileLog: [],
  ioUring: 0,
  rewrites: [],
};
/** The probe's lifecycle record: execs after the app-server's own, sockets and file writes. */
function traceSummary(text, binary, appServer, survived, rewrites, loopback, cwd) {
  const parsed = parseTrace(text, binary, rewrites, loopback, cwd);
  const error = appServer === undefined ? "the traced app-server was not found" : parsed.error;
  return { ok: error === null, error, survived, ...parsed, rewrites };
}

/** Reduces a capture to the fields a qualification compares between two releases. */
export function summarizeProbe(capture) {
  const responses = capture.requests.filter((entry) => entry.url.endsWith("/responses"));
  const first = responses[0]?.body ?? { input: [] };
  const tools = [];
  const nested = new Set();
  const walk = (list, prefix) => {
    for (const tool of list ?? []) {
      if (tool.type === "namespace") walk(tool.tools, tool.name);
      else {
        tools.push(`${prefix ? `${prefix}.` : ""}${tool.name}`);
        for (const match of String(tool.description ?? "").matchAll(/### `([A-Za-z0-9_]+)`/g))
          nested.add(match[1]);
      }
    }
  };
  for (const item of first.input ?? []) if (item.type === "additional_tools") walk(item.tools, "");
  walk(first.tools, "");
  const outputs = {};
  for (const request of responses.slice(1))
    for (const item of request.body?.input ?? [])
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
        outputs[item.call_id] =
          typeof item.output === "string"
            ? item.output
            : Array.isArray(item.output)
              ? item.output.map((part) => part.text ?? "").join("\n")
              : JSON.stringify(item.output).slice(0, 400);
  const events = capture.notifications
    .filter(
      (n) =>
        n.method === "rawResponseItem/completed" ||
        n.method === "item/started" ||
        n.method === "item/completed",
    )
    .map(
      (n) =>
        `${n.method}:${n.params.item?.type}:${n.params.item?.name ?? n.params.item?.tool ?? ""}${n.params.item?.delivery ? `:${n.params.item.delivery}` : ""}`,
    );
  const developer = (first.input ?? [])
    .filter((item) => item.role === "developer" && item.type === "message")
    .flatMap((item) => item.content.map((content) => content.text ?? ""))
    .join("\n");
  return {
    error: capture.error,
    turn: capture.turn?.turn?.status ?? "none",
    userAgentShape: String(capture.initialize?.userAgent ?? "").replace(
      /\/[0-9][^ ]* /,
      "/<version> ",
    ),
    tools,
    nestedTools: [...nested].sort(),
    hostCanaryPresent: JSON.stringify(first).includes(CANARY),
    instructionSources: capture.thread?.instructionSources ?? null,
    outputs,
    events,
    serverRequests: capture.serverRequests,
    toolCalls: capture.toolCalls.length,
    inspection: {
      ok: capture.observation.ok,
      error: capture.observation.error,
      samples: capture.observation.samples,
    },
    trace: capture.trace,
    exitedBeforeStop: capture.exitedBeforeStop === true,
    processes: capture.observation.processes.map((entry) => entry.exe || entry.comm),
    aliveAfterStop: capture.observation.aliveAfterStop.map((entry) => entry.exe || entry.comm),
    unixSockets: capture.observation.unixSockets.map((socket) =>
      socket.replace(capture.workDir, "<probe>"),
    ),
    tcpRemotes: capture.observation.tcpRemotes.map((remote) =>
      remote === `127.0.0.1:${capture.loopbackPort}` ? "<loopback>" : remote,
    ),
    udpRemotes: capture.observation.udpRemotes,
    uninspectable: capture.observation.uninspectable.map((entry) => entry.comm),
    files: capture.files,
    preexisting: capture.preexisting ?? [],
    developerInstructions: developer.replace(/\/tmp\/[^\s]*/g, "<tmp>"),
  };
}
