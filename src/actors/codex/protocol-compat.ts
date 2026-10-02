// The per-launch protocol check: the generated app-server schema against the fields humanish reads
// and sends (protocol-contract.ts). It checks only those fields. It does not guarantee the rest of
// the protocol, and it does not attest how the release behaves.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProtocolContract,
  ProtocolFieldRule,
  ProtocolPrimitive,
  ProtocolSentField,
  ProtocolValue,
} from "./protocol-contract.js";

type Schema = boolean | Record<string, unknown>;
type Kind = ProtocolPrimitive | "any";

/** The definitions of one generated schema, and the params definition of each method. */
export interface ProtocolSchema {
  readonly definitions: ReadonlyMap<string, Schema>;
  readonly requestParams: ReadonlyMap<string, string>;
  readonly notificationParams: ReadonlyMap<string, string>;
}

/** What the check found: changes that refuse the launch, and additions it only records. */
export interface ProtocolCheck {
  readonly incompatibilities: string[];
  readonly additions: string[];
}

const MAX_SCHEMA_FILE_BYTES = 16 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A regular file of at most 16 MiB, checked before it is opened: no pipe, device or link. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_SCHEMA_FILE_BYTES)
    throw new Error(`${file} is not a schema file`);
  return record(JSON.parse(await readFile(file, "utf8")));
}

/** Each method of a ClientRequest or ServerNotification union, with its params definition. */
function methodParams(union: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  for (const branch of list(union.oneOf)) {
    const properties = record(record(branch).properties);
    const method = list(record(properties.method).enum)[0];
    const ref = record(properties.params).$ref;
    if (typeof method === "string" && typeof ref === "string")
      result.set(method, ref.split("/").pop()!);
  }
  return result;
}

/**
 * Reads the files `codex app-server generate-json-schema --experimental` writes: the v2 and full
 * bundles for definitions, and the ClientRequest and ServerNotification unions for params.
 */
export async function loadProtocolSchema(directory: string): Promise<ProtocolSchema> {
  const definitions = new Map<string, Schema>();
  for (const name of [
    "codex_app_server_protocol.v2.schemas.json",
    "codex_app_server_protocol.schemas.json",
  ]) {
    const bundle = await readJson(path.join(directory, name));
    for (const [key, value] of Object.entries(record(bundle.definitions)))
      if (!definitions.has(key)) definitions.set(key, value as Schema);
  }
  const requests = await readJson(path.join(directory, "ClientRequest.json"));
  const notifications = await readJson(path.join(directory, "ServerNotification.json"));
  return {
    definitions,
    requestParams: methodParams(requests),
    notificationParams: methodParams(notifications),
  };
}

/** Types both declarations allow; an integer is a number. */
function sharedTypes(a: unknown, b: unknown): string[] {
  const left = Array.isArray(a) ? a : [a],
    right = Array.isArray(b) ? b : [b];
  const shared = new Set<string>();
  for (const type of left)
    if (right.includes(type)) shared.add(String(type));
    else if (type === "integer" && right.includes("number")) shared.add("integer");
    else if (type === "number" && right.includes("integer")) shared.add("integer");
  return [...shared];
}

/**
 * Two schemas a value must both satisfy, as one: types and fixed values intersect, required fields
 * add up, and a property, items or additionalProperties both constrain becomes their `allOf`.
 * False when nothing satisfies both.
 */
function intersect(a: Schema, b: Schema): Schema {
  if (a === false || b === false) return false;
  if (a === true) return b;
  if (b === true) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (!(key in out)) out[key] = value;
    else if (key === "properties") {
      const merged = { ...record(out.properties) };
      for (const [name, schema] of Object.entries(record(value)))
        merged[name] = name in merged ? { allOf: [merged[name], schema] } : schema;
      out.properties = merged;
    } else if (key === "required")
      out.required = [...new Set([...list(out.required), ...list(value)])];
    else if (key === "type") out.type = sharedTypes(out.type, value);
    else if (key === "enum") out.enum = list(out.enum).filter((item) => list(value).includes(item));
    else if (key === "const") {
      if (out.const !== value) out.enum = [];
    } else if (key === "items" || key === "additionalProperties")
      out[key] = { allOf: [out[key], value] };
    else out[key] = value;
  }
  if ("const" in out && "enum" in out) {
    out.enum = list(out.enum).filter((item) => item === out.const);
    delete out.const;
  }
  const empty = (key: string) => Array.isArray(out[key]) && list(out[key]).length === 0;
  return empty("type") || empty("enum") ? false : out;
}

/**
 * A field's schema as the alternatives it may take: `$ref`s followed, `allOf` intersected, and
 * `anyOf` and `oneOf` expanded, so that each alternative is one plain schema. `false` (no value)
 * is dropped; `true` (any value) stays.
 */
function alternatives(schema: ProtocolSchema, node: Schema, seen = new Set<string>()): Schema[] {
  if (typeof node === "boolean") return node ? [true] : [];
  if (typeof node.$ref === "string") {
    // The full bundle nests v2 definitions (`#/definitions/v2/Name`); the v2 bundle has each by name.
    const name = node.$ref.split("/").pop()!;
    const target = schema.definitions.get(name);
    if (target === undefined || seen.has(name)) return [];
    return alternatives(schema, target, new Set([...seen, name]));
  }
  const own: Record<string, unknown> = { ...node };
  delete own.anyOf;
  delete own.oneOf;
  delete own.allOf;
  let result: Schema[] = [own];
  for (const member of list(node.allOf)) {
    const parts = alternatives(schema, member as Schema, seen);
    result = result.flatMap((base) => parts.map((part) => intersect(base, part)));
  }
  const union = [...list(node.anyOf), ...list(node.oneOf)];
  if (union.length > 0)
    result = result.flatMap((base) =>
      union.flatMap((branch) =>
        alternatives(schema, branch as Schema, seen).map((part) => intersect(base, part)),
      ),
    );
  return result.filter((part) => part !== false);
}

function kindOf(value: unknown): Kind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value as Kind;
}

/** The fixed values an alternative allows, or undefined when it does not fix them. */
const fixedValues = (node: Record<string, unknown>): unknown[] | undefined =>
  node.const !== undefined ? [node.const] : Array.isArray(node.enum) ? node.enum : undefined;

/** The JSON types an alternative allows; `any` when it constrains none. */
function typesOf(node: Schema): Set<Kind> {
  if (typeof node === "boolean") return new Set(node ? ["any"] : []);
  const declared = node.type;
  if (typeof declared === "string") return new Set([declared as Kind]);
  if (Array.isArray(declared)) return new Set(declared as Kind[]);
  const fixed = fixedValues(node);
  if (fixed !== undefined) return new Set(fixed.map(kindOf));
  if (node.properties !== undefined) return new Set(["object"]);
  if (node.items !== undefined) return new Set(["array"]);
  return new Set(["any"]);
}

const accepts = (types: Set<Kind>, type: ProtocolPrimitive): boolean =>
  types.has(type) || types.has("any") || (type === "integer" && types.has("number"));

/** Whether an alternative allows a value humanish compares against or sends. */
function allows(node: Schema, value: ProtocolValue): boolean {
  if (typeof node === "boolean") return node;
  if (!accepts(typesOf(node), kindOf(value) as ProtocolPrimitive)) return false;
  const fixed = fixedValues(node);
  return fixed === undefined || fixed.includes(value);
}

/** One container a path steps through, and the alternatives found there. */
interface Container {
  readonly prefix: string;
  readonly nodes: Schema[];
  readonly kind: "object" | "array";
}

function property(schema: ProtocolSchema, node: Schema, name: string): Schema[] {
  if (typeof node !== "object") return [];
  const properties = record(node.properties);
  if (Object.hasOwn(properties, name)) return alternatives(schema, properties[name] as Schema);
  const extra = node.additionalProperties;
  return extra === true || typeof extra === "object" ? alternatives(schema, extra as Schema) : [];
}

/** Whether a union branch's discriminator `field` is fixed to `value`. */
function selects(schema: ProtocolSchema, node: Schema, field: string, value: string): boolean {
  return property(schema, node, field).some(
    (part) => typeof part === "object" && (fixedValues(part) ?? []).includes(value),
  );
}

/**
 * The alternatives at `path` under a definition, and each container on the way. A step is
 * `name`, `name[]` (its array items) or `{field=value}` (the union branches with that value).
 */
function walk(
  schema: ProtocolSchema,
  definition: string,
  fieldPath: string,
): { nodes: Schema[]; containers: Container[] } {
  const root = schema.definitions.get(definition);
  let nodes = root === undefined ? [] : alternatives(schema, root);
  const containers: Container[] = [];
  const done: string[] = [];
  for (const segment of fieldPath === "" ? [] : fieldPath.split(".")) {
    if (done.length > 0) containers.push({ prefix: done.join("."), nodes, kind: "object" });
    const branch = /^\{([A-Za-z_]+)=([A-Za-z0-9_/-]+)\}$/.exec(segment);
    if (branch) nodes = nodes.filter((node) => selects(schema, node, branch[1]!, branch[2]!));
    else {
      const array = segment.endsWith("[]");
      const name = array ? segment.slice(0, -2) : segment;
      nodes = nodes.flatMap((node) => property(schema, node, name));
      if (array) {
        containers.push({ prefix: [...done, name].join("."), nodes, kind: "array" });
        nodes = nodes.flatMap((node) =>
          typeof node === "object" && node.items !== undefined
            ? alternatives(schema, node.items as Schema)
            : [],
        );
      }
    }
    done.push(segment);
  }
  return { nodes, containers };
}

/** A field's alternatives at `path` under a definition, or none when the field is gone. */
export function resolveField(
  schema: ProtocolSchema,
  definition: string,
  fieldPath: string,
): Schema[] {
  return walk(schema, definition, fieldPath).nodes;
}

const show = (value: ProtocolValue): string => (value === null ? "null" : String(value));
const typesIn = (nodes: Schema[]): Kind[] => [
  ...new Set(nodes.flatMap((node) => [...typesOf(node)])),
];

interface Findings {
  readonly incompatibilities: Set<string>;
  readonly additions: Set<string>;
}

/** String values offered at a field, or undefined when an alternative allows any string. */
function offeredStrings(nodes: Schema[]): string[] | undefined {
  const values: string[] = [];
  for (const node of nodes.filter((entry) => accepts(typesOf(entry), "string"))) {
    const fixed = typeof node === "object" ? fixedValues(node) : undefined;
    if (fixed === undefined) return undefined;
    values.push(...fixed.filter((value): value is string => typeof value === "string"));
  }
  return [...new Set(values)];
}

/**
 * A read field: every type the release allows there, and in each container on the way, is one
 * humanish handles; each compared value is still allowed; values beyond `known` are recorded.
 * `listed` holds the paths with their own rule, whose types decide for that container.
 */
function checkRead(
  schema: ProtocolSchema,
  owner: string,
  definition: string,
  rule: ProtocolFieldRule,
  listed: ReadonlySet<string>,
  found: Findings,
): void {
  const { nodes, containers } = walk(schema, definition, rule.path);
  if (nodes.length === 0) {
    if (!rule.optional)
      found.incompatibilities.add(`${owner} ${rule.path} is no longer in the schema`);
    return;
  }
  for (const container of containers.filter((entry) => !listed.has(entry.prefix))) {
    const foreign = typesIn(container.nodes).filter((type) => type !== container.kind);
    if (foreign.length > 0)
      found.incompatibilities.add(
        `${owner} ${container.prefix} now allows ${foreign.join(", ")}; humanish reads ${container.kind}`,
      );
  }
  if (rule.types !== undefined) {
    const accepted = new Set<Kind>(rule.types);
    if (accepted.has("number")) accepted.add("integer");
    const foreign = typesIn(nodes).filter((type) => !accepted.has(type));
    if (foreign.length > 0)
      found.incompatibilities.add(
        `${owner} ${rule.path} now allows ${foreign.join(", ")}; humanish reads ${rule.types.join(" or ")}`,
      );
  }
  const missing = (rule.expects ?? []).filter(
    (value) => !nodes.some((node) => allows(node, value)),
  );
  if (missing.length > 0)
    found.incompatibilities.add(
      `${owner} ${rule.path} no longer allows ${missing.map(show).join(", ")}`,
    );
  const offered = rule.known === undefined ? undefined : offeredStrings(nodes);
  if (offered === undefined) return;
  const known = new Set<unknown>([...rule.known!, ...(rule.expects ?? [])]);
  const added = offered.filter((value) => !known.has(value));
  if (added.length > 0)
    found.additions.add(`${owner} ${rule.path} now also allows ${added.join(", ")}`);
}

/** A sent field: some alternative still accepts each type and value humanish sends there. */
function checkSent(
  schema: ProtocolSchema,
  owner: string,
  definition: string,
  rule: ProtocolSentField,
  found: Findings,
): void {
  const nodes = resolveField(schema, definition, rule.path);
  const where = rule.path === "" ? owner : `${owner} ${rule.path}`;
  if (nodes.length === 0) {
    found.incompatibilities.add(`${where} is no longer accepted`);
    return;
  }
  for (const type of rule.sends)
    if (!nodes.some((node) => accepts(typesOf(node), type)))
      found.incompatibilities.add(`${where} no longer accepts ${type}`);
  for (const value of rule.expects ?? [])
    if (!nodes.some((node) => allows(node, value)))
      found.incompatibilities.add(`${where} no longer accepts ${show(value)}`);
  const fields = rule.fields;
  if (fields === undefined) return;
  const required = nodes.flatMap((node) => (typeof node === "object" ? list(node.required) : []));
  const unsent = [...new Set(required)].filter(
    (field): field is string => typeof field === "string" && !fields.includes(field),
  );
  if (unsent.length > 0)
    found.incompatibilities.add(
      `${where} now requires ${unsent.join(", ")}, which humanish does not send`,
    );
}

function checkReads(
  schema: ProtocolSchema,
  owner: string,
  definition: string,
  rules: readonly ProtocolFieldRule[],
  found: Findings,
): void {
  const listed = new Set(rules.map((rule) => rule.path));
  for (const rule of rules) checkRead(schema, owner, definition, rule, listed, found);
}

/** Checks a generated schema against the contract; any incompatibility refuses the launch. */
export function checkProtocol(schema: ProtocolSchema, contract: ProtocolContract): ProtocolCheck {
  const found: Findings = { incompatibilities: new Set(), additions: new Set() };
  const present = (name: string, what: string): boolean => {
    if (schema.definitions.has(name)) return true;
    found.incompatibilities.add(`${what} ${name} is no longer in the schema`);
    return false;
  };
  for (const request of contract.requests) {
    const params = schema.requestParams.get(request.method);
    if (params === undefined) {
      found.incompatibilities.add(`${request.method} is no longer a client request`);
      continue;
    }
    for (const rule of request.params)
      checkSent(schema, `${request.method} request`, params, rule, found);
    const response = request.response;
    if (response && present(response.definition, `${request.method}'s response`))
      checkReads(schema, `${request.method} response`, response.definition, response.reads, found);
  }
  for (const message of contract.messages) {
    if (present(message.definition, `${message.method}'s`))
      checkReads(schema, message.method, message.definition, message.reads, found);
    const reply = message.reply;
    if (reply && present(reply.definition, `${message.method}'s reply`))
      for (const rule of reply.sends)
        checkSent(schema, `${message.method} reply`, reply.definition, rule, found);
  }
  // The carriers in every notification, including the consumed ones outside ServerNotification.
  const notifications = new Map(schema.notificationParams);
  for (const message of contract.messages)
    if (message.reply === undefined && !notifications.has(message.method))
      notifications.set(message.method, message.definition);
  for (const [method, params] of notifications)
    checkReads(schema, method, params, contract.itemCarriers, found);
  return { incompatibilities: [...found.incompatibilities], additions: [...found.additions] };
}

const listed = (items: readonly string[]): string =>
  items.length <= 5
    ? items.join("; ")
    : `${items.slice(0, 5).join("; ")}; and ${items.length - 5} more`;

/** The refusal detail for an incompatible release. */
export function protocolIncompatibilityMessage(
  cliVersion: string | undefined,
  incompatibilities: readonly string[],
): string {
  const release = `Codex CLI${cliVersion === undefined ? "" : ` ${cliVersion}`}`;
  return incompatibilities.length === 0
    ? `${release} changed the app-server protocol humanish uses.`
    : `${release} changed the app-server protocol humanish uses: ${listed(incompatibilities)}.`;
}

/** The run warning for schema values beyond the baseline, or undefined when there were none. */
export function protocolAdditionsWarning(
  cliVersion: string | undefined,
  additions: readonly string[] | undefined,
): string | undefined {
  if (additions === undefined || additions.length === 0) return undefined;
  return `Codex CLI${cliVersion === undefined ? "" : ` ${cliVersion}`}'s app-server schema has values humanish has not seen: ${listed(additions)}. humanish recorded them and continued.`;
}
