/**
 * Writes the test fixture for the app-server protocol check (tests/fixtures/restricted-codex/
 * app-server-schema) from a release's generated schema: the definitions the protocol contract
 * names, the params of each request it sends, the notifications that carry a turn, thread or item
 * list (the item carriers) or that it reads, and every definition those reference.
 *
 *   codex app-server generate-json-schema --experimental --out <dir>
 *   tsx scripts/codex-schema-fixture.ts <dir> tests/fixtures/restricted-codex/app-server-schema
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { protocolContract } from "../src/actors/codex/protocol-contract.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const [source, out] = process.argv.slice(2);
if (source === undefined || out === undefined) {
  process.stderr.write(
    "usage: tsx scripts/codex-schema-fixture.ts <generated-schema-dir> <out-dir>\n",
  );
  process.exit(2);
}
const read = async (file: string): Promise<Json> =>
  record(JSON.parse(await readFile(path.join(source, file), "utf8")));
const v2 = await read("codex_app_server_protocol.v2.schemas.json");
const full = await read("codex_app_server_protocol.schemas.json");
const requests = await read("ClientRequest.json");
const notifications = await read("ServerNotification.json");
const contract = protocolContract({ reasoningEffort: "low", platform: "linux" });

// The full bundle nests the v2 definitions under `v2`; the v2 bundle wins for a shared name.
const all: Json = { ...record(full.definitions), ...record(v2.definitions) };
delete all.v2;
const refName = (ref: unknown): string => String(ref).split("/").pop()!;
const methodOf = (branch: unknown): string =>
  String((record(record(record(branch).properties).method).enum as unknown[] | undefined)?.[0]);
const paramsOf = (branch: unknown): string =>
  refName(record(record(record(branch).properties).params).$ref);
const oneOf = (union: Json): unknown[] => (Array.isArray(union.oneOf) ? union.oneOf : []);
const requestMethods = new Set(contract.requests.map((request) => request.method));
const branches = oneOf(requests).filter((branch) => requestMethods.has(methodOf(branch)));
const carrierRoots = new Set(contract.itemCarriers.map((rule) => rule.path.split(/[.[]/)[0]));
const messageMethods = new Set(contract.messages.map((message) => message.method));
const notificationBranches = oneOf(notifications).filter(
  (branch) =>
    messageMethods.has(methodOf(branch)) ||
    Object.keys(record(record(all[paramsOf(branch)]).properties)).some((key) =>
      carrierRoots.has(key),
    ),
);
const roots = [
  ...contract.requests.flatMap((request) =>
    request.response === undefined ? [] : [request.response.definition],
  ),
  ...contract.messages.flatMap((message) => [
    message.definition,
    ...(message.reply === undefined ? [] : [message.reply.definition]),
  ]),
  ...branches.map(paramsOf),
  ...notificationBranches.map(paramsOf),
];

const keep = new Set<string>();
const visit = (node: unknown): void => {
  if (Array.isArray(node)) return node.forEach(visit);
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$ref" || typeof value !== "string") visit(value);
    else if (!keep.has(refName(value)) && refName(value) in all) {
      keep.add(refName(value));
      visit(all[refName(value)]);
    }
  }
};
for (const root of roots) {
  keep.add(root);
  visit(all[root]);
}

const definitions = Object.fromEntries([...keep].sort().map((name) => [name, all[name]]));
await mkdir(out, { recursive: true });
const write = (file: string, value: Json) =>
  writeFile(path.join(out, file), `${JSON.stringify(value)}\n`);
await write("codex_app_server_protocol.v2.schemas.json", {
  $schema: v2.$schema,
  title: v2.title,
  definitions,
});
await write("codex_app_server_protocol.schemas.json", {
  $schema: full.$schema,
  title: full.title,
  definitions: {},
});
await write("ClientRequest.json", {
  $schema: requests.$schema,
  title: requests.title,
  oneOf: branches,
});
await write("ServerNotification.json", {
  $schema: notifications.$schema,
  title: notifications.title,
  oneOf: notificationBranches,
});
process.stdout.write(`${keep.size} definitions\n`);
