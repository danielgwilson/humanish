// Deterministic process fault injection. Wire envelopes are loaded from captures;
// scenario mutations intentionally break them. This script never calls a model.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const directory = path.dirname(fileURLToPath(import.meta.url));
const [scenario, trace, operation] = process.argv.slice(2);
const capture = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const note = value => fs.appendFileSync(trace, `${JSON.stringify(value)}\n`);
note({ operation, pid: process.pid, envKeys: Object.keys(process.env), cwd: process.cwd(), home: process.env.HOME });
if (operation === "--version") {
  if (scenario === "hang-version") setInterval(() => undefined, 1000);
  else if (scenario === "large-version") process.stdout.write("x".repeat(5000));
  else console.log(scenario === "wrong-version" ? "codex-cli 0.0.1" : "codex-cli 0.154.0");
} else {
  if (scenario === "ignore-term") { process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000); }
  const map = value => JSON.parse(JSON.stringify(value).replaceAll("/private/probe/home", process.env.HOME)
    .replaceAll("/private/probe/cwd", process.cwd()));
  const reply = (id, result) => write({ id, result });
  const emit = value => write(map(value));
  const init = capture("initialize.json"); init.codexHome = process.env.HOME;
  const config = map(capture("effective-config.json"));
  const thread = map(capture("thread-start.json"));
  const turn = capture("turn-start.json");
  const events = capture("completed-turn-and-usage.json");
  const deltaTemplate = capture("agent-message-delta.json");
  const completion = events.find(event => event.method === "turn/completed");
  const answer = events.find(event => event.method === "item/completed");
  const usage = events.find(event => event.method === "thread/tokenUsage/updated");
  if (scenario === "system-config") config.layers.find(layer => layer.name.type === "system").config = { notify: ["synthetic-command"] };
  if (scenario === "mcp-config") config.config.mcp_servers = { synthetic: { command: "synthetic-command" } };
  if (scenario === "instructions-config") config.config.instructions = "SYNTHETIC_UNTRUSTED_INSTRUCTIONS";
  if (scenario === "agents-enabled") config.config.agents.enabled = true;
  if (scenario === "code-host-enabled") config.config.features.code_mode_host = true;
  if (scenario === "provider-config") config.config.openai_base_url = "https://example.invalid";
  if (scenario === "model-mismatch") { thread.model = "unqualified-model"; thread.thread.model = "unqualified-model"; }
  if (scenario === "inherited-instructions") thread.instructionSources = [{ path: "/synthetic/AGENTS.md" }];
  if (scenario === "environment-enabled") thread.thread.environments = [{ environmentId: "synthetic-environment" }];
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", line => {
    const message = JSON.parse(line);
    note({ method: message.method, params: message.params });
    if (message.method === "initialized") return;
    if (scenario === `hang-${message.method.replaceAll("/", "-")}`) return;
    if (scenario === "malformed" && message.method === "initialize") { process.stdout.write("{not-json}\n"); return; }
    if (scenario === "server-request" && message.method === "initialize") { write({ id: 999, method: "item/commandExecution/requestApproval", params: {} }); return; }
    if (scenario === "provider-error" && message.method === "initialize") { write({ id: message.id, error: { code: -32000, message: "SYNTHETIC_PRIVATE_ERROR_PAYLOAD" } }); return; }
    if (message.method === "initialize") reply(message.id, init);
    else if (message.method === "config/read") reply(message.id, config);
    else if (message.method === "account/read") {
      const account = capture("account-read-projection.json");
      if (scenario === "api-key-auth") account.account.type = "apiKey";
      if (scenario === "signed-out") account.account = null;
      reply(message.id, account);
    } else if (message.method === "thread/start") reply(message.id, thread);
    else if (message.method === "mcpServerStatus/list") reply(message.id,
      scenario === "active-mcp" ? { data: [{ name: "synthetic" }], nextCursor: null } : capture("mcp-status.json"));
    else if (message.method === "turn/interrupt") {
      reply(message.id, {});
      for (const event of capture("interrupted-turn.json")) emit(event);
    } else if (message.method === "turn/start") {
      note({ imageCount: message.params.input.filter(item => item.type === "localImage").length,
        imageFiles: message.params.input.filter(item => item.type === "localImage").map(item => ({ path: item.path, exists: fs.existsSync(item.path), mode: fs.statSync(item.path).mode & 0o777 })) });
      if (scenario === "replace-auth") {
        fs.unlinkSync(path.join(process.env.HOME, "auth.json"));
        fs.writeFileSync(path.join(process.env.HOME, "auth.json"), "synthetic-rotated-login", { mode: 0o644 });
      }
      if (scenario === "lost-turn-ack") { emit({ method: "turn/started", params: { threadId: thread.thread.id, turn: turn.turn } }); return; }
      if (scenario !== "early-events") reply(message.id, turn);
      if (scenario === "large-input-echo") {
        const raw = capture("raw-input-image.json"), image = message.params.input.find(item => item.type === "localImage");
        raw.params.item.content.find(item => item.type === "input_image").image_url = `data:image/png;base64,${fs.readFileSync(image.path).toString("base64")}`;
        emit(raw);
      }
      if (scenario === "exit-after-dispatch") { process.exit(7); return; }
      if (["hang-turn", "ignore-term"].includes(scenario)) return;
      if (scenario === "stdout-large") { process.stdout.write("x".repeat(2 * 1024 * 1024 + 1)); return; }
      if (scenario === "stderr-large") { process.stderr.write("x".repeat(2 * 1024 * 1024 + 1)); return; }
      if (scenario === "event-overflow") { for (let n = 0; n < 65538; n++) emit({ method: "warning", params: {} }); return; }
      // The envelope comes from the captured account-backed study report;
      // IDs/text below are deliberate synthetic stream-size mutations.
      const delta = text => emit({ ...deltaTemplate, params: { ...deltaTemplate.params,
        delta: text, itemId: answer.params.item.id, threadId: answer.params.threadId, turnId: answer.params.turnId
      } });
      if (scenario === "many-deltas") {
        const text = JSON.stringify({ ...JSON.parse(answer.params.item.text), summary: "Synthetic finding. ".repeat(1200) });
        answer.params.item.text = text; completion.params.turn.items[0].text = text;
        for (let start = 0; start < text.length; start += 16) delta(text.slice(start, start + 16));
      }
      if (scenario === "aggregate-delta-overflow") {
        for (let n = 0; n < 129; n++) delta("é".repeat(8192));
      }
      if (scenario === "wrong-thread") { answer.params.threadId = "wrong-thread"; emit(answer); return; }
      if (scenario === "wrong-turn") { answer.params.turnId = "wrong-turn"; emit(answer); return; }
      if (scenario === "raw-tool") { emit(capture("raw-tool-call.json")); return; }
      if (scenario === "async-question") { for (const event of capture("async-question-items.json")) emit(event); return; }
      if (scenario === "interrupted") { emit(usage); for (const event of capture("interrupted-turn.json")) emit(event); return; }
      if (scenario === "invalid-json") answer.params.item.text = "{invalid-json}";
      if (scenario === "multiple-answers") { const other = structuredClone(answer); other.params.item.id = "other-answer"; emit(other); }
      if (scenario === "invalid-usage") usage.params.tokenUsage.total.cachedInputTokens = 999999999;
      if (scenario === "missing-item-thread") delete answer.params.threadId;
      if (scenario === "missing-item-turn") delete answer.params.turnId;
      if (scenario === "missing-usage-thread") delete usage.params.threadId;
      if (scenario === "missing-usage-turn") delete usage.params.turnId;
      if (scenario === "missing-completion-thread") delete completion.params.threadId;
      if (scenario === "missing-completion-id") delete completion.params.turn.id;
      if (scenario !== "missing-answer") emit(answer);
      if (scenario !== "missing-usage") emit(usage);
      if (scenario === "partial-usage") { process.exit(7); return; }
      emit(completion);
      if (scenario === "early-events") reply(message.id, turn);
    }
  });
  rl.on("close", () => { if (scenario !== "ignore-term") process.exit(0); });
}
