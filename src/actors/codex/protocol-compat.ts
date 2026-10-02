// The per-launch protocol check: the generated app-server schema against the fields humanish reads
// and the request fields it sends (protocol-contract.ts). It checks only those fields. It does not
// guarantee the rest of the protocol, and it does not attest how the release behaves.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProtocolContract,
  ProtocolFieldRule,
  ProtocolPrimitive,
} from "./protocol-contract.js";

type Schema = boolean | Record<string, unknown>;

/** The definitions of one generated schema, and the params definition of each client request. */
export interface ProtocolSchema {
  readonly definitions: ReadonlyMap<string, Schema>;
  readonly requestParams: ReadonlyMap<string, string>;
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

async function readJson(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > MAX_SCHEMA_FILE_BYTES) throw new Error(`${file} is too large`);
  return record(JSON.parse(text));
}

/**
 * Reads the files `codex app-server generate-json-schema --experimental` writes: the v2 and full
 * bundles for definitions, and ClientRequest.json for each method's params.
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
  const requestParams = new Map<string, string>();
  const requests = await readJson(path.join(directory, "ClientRequest.json"));
  for (const branch of Array.isArray(requests.oneOf) ? requests.oneOf : []) {
    const properties = record(record(branch).properties);
    const method = record(properties.method).enum;
    const ref = record(properties.params).$ref;
    if (Array.isArray(method) && typeof method[0] === "string" && typeof ref === "string")
      requestParams.set(method[0], ref.replace(/^#\/definitions\//, ""));
  }
  return { definitions, requestParams };
}

/**
 * A field's schema as the alternatives it may take: `$ref`s followed, and `anyOf`, `oneOf` and
 * `allOf` expanded so that each alternative is one plain schema object. An `allOf` member that is
 * itself a union yields one alternative per branch.
 */
function alternatives(schema: ProtocolSchema, node: Schema, seen = new Set<string>()): Schema[] {
  if (typeof node === "boolean") return [node];
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
  let result: Record<string, unknown>[] = [own];
  for (const member of Array.isArray(node.allOf) ? node.allOf : []) {
    const parts = alternatives(schema, member as Schema, seen).filter(
      (part): part is Record<string, unknown> => typeof part === "object",
    );
    result = result.flatMap((base) => parts.map((part) => mergeInto({ ...base }, part)));
  }
  const union = [
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(Array.isArray(node.oneOf) ? node.oneOf : []),
  ];
  if (union.length === 0) return result;
  // A union beside its own properties: each branch carries the shared part.
  return result.flatMap((base) =>
    union.flatMap((branch) =>
      alternatives(schema, branch as Schema, seen).map((part) =>
        typeof part === "object" ? mergeInto({ ...base }, part) : part,
      ),
    ),
  );
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (key === "properties")
      target.properties = { ...record(target.properties), ...record(value) };
    else if (key === "required")
      target.required = [
        ...(Array.isArray(target.required) ? target.required : []),
        ...(Array.isArray(value) ? value : []),
      ];
    else target[key] = value;
  }
  return target;
}

/** The JSON types an alternative allows; `any` when it constrains none. */
function typesOf(node: Schema): Set<ProtocolPrimitive | "any"> {
  if (typeof node === "boolean") return new Set(node ? ["any"] : []);
  const declared = node.type;
  if (typeof declared === "string") return new Set([declared as ProtocolPrimitive]);
  if (Array.isArray(declared)) return new Set(declared as ProtocolPrimitive[]);
  if (node.enum !== undefined || node.const !== undefined) {
    const values = node.enum !== undefined ? (node.enum as unknown[]) : [node.const];
    return new Set(
      values.map((value) => (value === null ? "null" : (typeof value as ProtocolPrimitive))),
    );
  }
  if (node.properties !== undefined) return new Set(["object"]);
  if (node.items !== undefined) return new Set(["array"]);
  return new Set(["any"]);
}

/** The fixed string values an alternative allows, or undefined when it allows any string. */
function stringValuesOf(node: Schema): string[] | undefined {
  if (typeof node === "boolean") return undefined;
  if (node.const !== undefined) return typeof node.const === "string" ? [node.const] : [];
  if (Array.isArray(node.enum))
    return node.enum.filter((value): value is string => typeof value === "string");
  return undefined;
}

/** One path step: `name`, `name[]` (its array items), or `{field=value}` (a union branch). */
function step(schema: ProtocolSchema, nodes: Schema[], segment: string): Schema[] {
  const branch = /^\{([A-Za-z_]+)=([A-Za-z0-9_/-]+)\}$/.exec(segment);
  if (branch) {
    const [, field, value] = branch;
    return nodes.filter((node) => {
      if (typeof node !== "object") return false;
      const discriminator = record(record(node.properties)[field!]);
      const values = alternatives(schema, discriminator).flatMap(
        (part) => stringValuesOf(part) ?? [],
      );
      return values.includes(value!);
    });
  }
  const array = segment.endsWith("[]");
  const name = array ? segment.slice(0, -2) : segment;
  const found: Schema[] = [];
  for (const node of nodes) {
    if (typeof node !== "object") continue;
    const properties = record(node.properties);
    const child = Object.hasOwn(properties, name)
      ? (properties[name] as Schema)
      : typeof node.additionalProperties === "object" || node.additionalProperties === true
        ? (node.additionalProperties as Schema)
        : undefined;
    if (child !== undefined) found.push(...alternatives(schema, child));
  }
  if (!array) return found;
  return found.flatMap((node) =>
    typeof node === "object" && node.items !== undefined
      ? alternatives(schema, node.items as Schema)
      : [],
  );
}

/** A field's alternatives at `path` under a definition, or none when the field is gone. */
export function resolveField(schema: ProtocolSchema, definition: string, path: string): Schema[] {
  const root = schema.definitions.get(definition);
  if (root === undefined) return [];
  let nodes = alternatives(schema, root);
  for (const segment of path === "" ? [] : path.split(".")) nodes = step(schema, nodes, segment);
  return nodes;
}

function checkField(
  schema: ProtocolSchema,
  owner: string,
  definition: string,
  rule: ProtocolFieldRule,
  result: ProtocolCheck,
): void {
  const where = `${owner} ${rule.path}`;
  const nodes = resolveField(schema, definition, rule.path);
  if (nodes.length === 0) {
    result.incompatibilities.push(`${where} is no longer in the schema`);
    return;
  }
  if (rule.types !== undefined) {
    const accepted = new Set<string>(rule.types);
    if (accepted.has("number")) accepted.add("integer");
    const found = new Set(nodes.flatMap((node) => [...typesOf(node)]));
    const foreign = [...found].filter((type) => !accepted.has(type));
    if (foreign.length > 0)
      result.incompatibilities.push(
        `${where} now allows ${foreign.join(", ")}; humanish reads ${rule.types.join(" or ")}`,
      );
  }
  if (rule.expects !== undefined || rule.known !== undefined) {
    // Only an alternative that can be a string offers values; a null or object one adds none.
    const lists = nodes
      .filter((node) => {
        const types = typesOf(node);
        return types.has("string") || types.has("any");
      })
      .map(stringValuesOf);
    // An alternative that allows any string removes no value and adds none humanish could list.
    if (lists.every((list) => list !== undefined)) {
      const offered = new Set(lists.flat() as string[]);
      const missing = (rule.expects ?? []).filter((value) => !offered.has(value));
      if (missing.length > 0)
        result.incompatibilities.push(`${where} no longer allows ${missing.join(", ")}`);
      if (rule.known !== undefined) {
        const known = new Set([...rule.known, ...(rule.expects ?? [])]);
        const added = [...offered].filter((value) => !known.has(value));
        if (added.length > 0) result.additions.push(`${where} now also allows ${added.join(", ")}`);
      }
    }
  }
}

/** Checks a generated schema against the contract; any incompatibility refuses the launch. */
export function checkProtocol(schema: ProtocolSchema, contract: ProtocolContract): ProtocolCheck {
  const result: ProtocolCheck = { incompatibilities: [], additions: [] };
  for (const request of contract.requests) {
    const params = schema.requestParams.get(request.method);
    if (params === undefined) {
      result.incompatibilities.push(`${request.method} is no longer a client request`);
      continue;
    }
    for (const node of resolveField(schema, params, "")) {
      const required =
        typeof node === "object" && Array.isArray(node.required) ? node.required : [];
      const unsent = required.filter(
        (field): field is string => typeof field === "string" && !request.sends.includes(field),
      );
      if (unsent.length > 0)
        result.incompatibilities.push(
          `${request.method} now requires ${unsent.join(", ")}, which humanish does not send`,
        );
    }
    for (const rule of request.sentValues ?? [])
      checkField(schema, `${request.method} request`, params, rule, result);
    if (request.response !== undefined) {
      if (!schema.definitions.has(request.response.definition))
        result.incompatibilities.push(
          `${request.method}'s response ${request.response.definition} is no longer in the schema`,
        );
      else
        for (const rule of request.response.reads)
          checkField(
            schema,
            `${request.method} response`,
            request.response.definition,
            rule,
            result,
          );
    }
  }
  for (const message of contract.messages) {
    if (!schema.definitions.has(message.definition)) {
      result.incompatibilities.push(
        `${message.method}'s ${message.definition} is no longer in the schema`,
      );
      continue;
    }
    for (const rule of message.reads)
      checkField(schema, message.method, message.definition, rule, result);
  }
  return result;
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
