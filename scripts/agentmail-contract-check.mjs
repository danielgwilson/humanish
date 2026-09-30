// Live AgentMail receiving contract through the real adapter: authenticate, acquire two fresh
// inboxes, send one message from the second to the first, read it back, then delete both.
// Each run uses new client IDs, subject and send idempotency key, so runs are independent.
// Output is one JSON object of codes and statuses: no key, address, inbox ID or message body.
// Run with: pnpm comms:agentmail:contract (reads AGENTMAIL_API_KEY from the environment).
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createReceivingAdapter } from "../src/comms/receiving-runtime.ts";

// Send is the one call the receiving adapter does not make. Endpoint and Idempotency-Key header
// follow https://docs.agentmail.to/api-reference/inboxes/messages/send and /idempotency.
const API_ORIGIN = "https://api.agentmail.to";
const REQUEST_MS = 30_000;
const DELIVERY_MS = 120_000;
const POLL_MS = 3_000;
const RELEASE_ATTEMPTS = 10;
const BODY = "Synthetic humanish receiving contract message.";

const apiKey = process.env.AGENTMAIL_API_KEY?.trim();
if (!apiKey) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: "credential_missing",
      message: "Set AGENTMAIL_API_KEY. This check creates and deletes two live AgentMail inboxes.",
    })}\n`,
  );
  process.exit(2);
}

const stop = new AbortController();
// The first interrupt ends the flow and still runs cleanup; a second one exits at once.
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());

class ContractError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const safeCode = (error) =>
  typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
    ? error.code
    : "unexpected_error";
const flowContext = () => ({ signal: stop.signal, timeoutMs: REQUEST_MS });
const cleanupContext = () => ({ timeoutMs: REQUEST_MS });

const token = randomBytes(8).toString("hex");
const subject = `humanish-contract-${token}`;
const clientIds = {
  recipient: `humanish-contract-${token}-recipient`,
  sender: `humanish-contract-${token}-sender`,
};
const leases = {};
const attempted = [];
const result = {
  check: "agentmail-receiving-contract",
  ok: false,
  subject,
  adapter: null,
  steps: {},
  cleanup: {},
};
let adapter;
let step = "configure";

async function send(from, to) {
  const response = await fetch(
    `${API_ORIGIN}/v0/inboxes/${encodeURIComponent(from.resourceId)}/messages/send`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": subject,
      },
      body: JSON.stringify({ to: [to.address], subject, text: BODY }),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_MS)]),
    },
  );
  const reply = await response.json().catch(() => null);
  if (!response.ok || typeof reply?.message_id !== "string")
    throw new ContractError(`send_http_${response.status}`);
}

async function awaitDelivery(lease) {
  const started = Date.now();
  const limitations = new Set();
  while (Date.now() - started < DELIVERY_MS) {
    if (stop.signal.aborted) throw new ContractError("cancelled");
    const batch = await adapter.read(lease, flowContext());
    for (const code of batch.limitations) limitations.add(code);
    const message = batch.messages.find((item) => item.subject === subject);
    if (message) {
      for (const code of message.limitations) limitations.add(code);
      return { message, latencyMs: Date.now() - started, limitations: [...limitations] };
    }
    await sleep(POLL_MS, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  throw new ContractError("delivery_timeout");
}

async function releaseUntilAbsent(lease) {
  for (let attempt = 1; ; attempt++) {
    const { status } = await adapter.release(lease, cleanupContext());
    if (status === "absent" || attempt === RELEASE_ATTEMPTS) return { status, attempts: attempt };
    await sleep(2_000);
  }
}

try {
  adapter = createReceivingAdapter(
    { provider: "agentmail", apiKeyEnv: "AGENTMAIL_API_KEY" },
    apiKey,
  );
  result.adapter = {
    provider: adapter.provider,
    addressing: adapter.addressing,
    idempotentAcquire: adapter.idempotentAcquire,
  };
  step = "authenticate";
  await adapter.authenticate(flowContext());
  result.steps.authenticate = "ok";
  step = "acquire";
  for (const role of ["recipient", "sender"]) {
    attempted.push(role);
    leases[role] = await adapter.acquire(clientIds[role], flowContext());
  }
  if (leases.recipient.resourceId === leases.sender.resourceId)
    throw new ContractError("acquire_not_fresh");
  result.steps.acquire = "ok";
  step = "idempotent_acquire";
  const replay = await adapter.acquire(clientIds.recipient, flowContext());
  const same =
    replay.resourceId === leases.recipient.resourceId &&
    replay.address === leases.recipient.address;
  // A different inbox here is a new resource; release it with the others.
  if (!same) leases.replay = replay;
  result.steps.idempotentAcquire = same ? "same_inbox" : "different_inbox";
  step = "send";
  await send(leases.sender, leases.recipient);
  result.steps.send = "ok";
  step = "read";
  const delivery = await awaitDelivery(leases.recipient);
  result.steps.read = {
    received: true,
    latencyMs: delivery.latencyMs,
    fromSender: delivery.message.from.includes(leases.sender.address),
    textMatches: delivery.message.text.includes(BODY),
    limitations: delivery.limitations,
  };
  step = "done";
} catch (error) {
  result.failedStep = step;
  result.code = safeCode(error);
} finally {
  for (const role of [...attempted, ...(leases.replay ? ["replay"] : [])]) {
    try {
      // A failed acquire may still have created the inbox; the same client ID returns it.
      const lease = leases[role] ?? (await adapter.acquire(clientIds[role], cleanupContext()));
      result.cleanup[role] = await releaseUntilAbsent(lease);
    } catch (error) {
      result.cleanup[role] = {
        status: "unresolved",
        acquired: role in leases,
        code: safeCode(error),
      };
    }
  }
}

const read = result.steps.read;
result.ok =
  step === "done" &&
  result.steps.idempotentAcquire === "same_inbox" &&
  read?.fromSender === true &&
  read?.textMatches === true &&
  Object.values(result.cleanup).every((entry) => entry.status === "absent");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
