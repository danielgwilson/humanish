import { describe, expect, it } from "vitest";
import {
  checkProtocol,
  loadProtocolSchema,
  protocolAdditionsWarning,
  protocolIncompatibilityMessage,
  resolveField,
  type ProtocolSchema,
} from "../../../src/actors/codex/protocol-compat.js";
import {
  PROTOCOL_CONTRACT,
  type ProtocolContract,
} from "../../../src/actors/codex/protocol-contract.js";
import { CODEX_SCHEMA_FIXTURE } from "../../helpers/codex-schema.js";

type Definitions = Record<string, Record<string, unknown>>;

/** The fixture schema after `change` edits a copy of its definitions and request methods. */
async function changed(
  change: (definitions: Definitions, requestParams: Map<string, string>) => void,
): Promise<ProtocolSchema> {
  const fixture = await loadProtocolSchema(CODEX_SCHEMA_FIXTURE);
  const definitions = structuredClone(Object.fromEntries(fixture.definitions)) as Definitions;
  const requestParams = new Map(fixture.requestParams);
  change(definitions, requestParams);
  return { definitions: new Map(Object.entries(definitions)), requestParams };
}

const properties = (node: Record<string, unknown>) => node.properties as Definitions;

describe("app-server protocol check", () => {
  it("passes the trimmed 0.160.0 schema with nothing to refuse or record", async () => {
    const schema = await loadProtocolSchema(CODEX_SCHEMA_FIXTURE);
    expect(schema.requestParams.get("thread/start")).toBe("ThreadStartParams");
    expect(checkProtocol(schema, PROTOCOL_CONTRACT)).toEqual({
      incompatibilities: [],
      additions: [],
    });
  });

  it.each<
    [string, (definitions: Definitions, requests: Map<string, string>) => void, string | string[]]
  >([
    [
      "a field humanish reads",
      (d) => delete properties(d.Thread!).id,
      "thread/start response thread.id is no longer in the schema",
    ],
    [
      "a field's type",
      (d) => (properties(d.TokenUsageBreakdown!).inputTokens = { type: "string" }),
      "thread/tokenUsage/updated tokenUsage.total.inputTokens now allows string; humanish reads integer",
    ],
    [
      "a value humanish compares against",
      (d) => (d.TurnStatus!.enum = ["completed", "failed", "inProgress"]),
      "turn/completed turn.status no longer allows interrupted",
    ],
    [
      "a value humanish sends",
      (d) =>
        ((d.AskForApproval!.oneOf as Record<string, unknown>[])[0]!.enum = [
          "untrusted",
          "on-request",
        ]),
      [
        "config/read response config.approval_policy no longer allows never",
        "thread/start request approvalPolicy no longer allows never",
        "thread/start response approvalPolicy no longer allows never",
        "turn/start request approvalPolicy no longer allows never",
      ],
    ],
    [
      "the params humanish sends",
      (d) => (d.ThreadStartParams!.required = ["cwd", "serviceTier"]),
      "thread/start now requires serviceTier, which humanish does not send",
    ],
    [
      "a response definition",
      (d) => delete d.TurnStartResponse,
      "turn/start's response TurnStartResponse is no longer in the schema",
    ],
    [
      "a notification definition",
      (d) => delete d.AgentMessageDeltaNotification,
      "item/agentMessage/delta's AgentMessageDeltaNotification is no longer in the schema",
    ],
    [
      "a client request",
      (_d, requests) => requests.delete("turn/interrupt"),
      "turn/interrupt is no longer a client request",
    ],
  ])("refuses a release that changes %s", async (_change, change, incompatibility) => {
    const result = checkProtocol(await changed(change), PROTOCOL_CONTRACT);
    expect(result.incompatibilities).toEqual([incompatibility].flat());
    expect(result.additions).toEqual([]);
  });

  it("records a value beyond the baseline without refusing", async () => {
    const schema = await changed((d) =>
      (d.ThreadItem!.oneOf as unknown[]).push({
        type: "object",
        properties: { type: { type: "string", enum: ["synthetic_new_item"] } },
      }),
    );
    expect(checkProtocol(schema, PROTOCOL_CONTRACT)).toEqual({
      incompatibilities: [],
      additions: [
        "item/started item.type now also allows synthetic_new_item",
        "item/completed item.type now also allows synthetic_new_item",
      ],
    });
  });

  it("reads a union branch by its discriminator, so a change in one branch is found", async () => {
    const fixture = await loadProtocolSchema(CODEX_SCHEMA_FIXTURE);
    expect(
      resolveField(fixture, "ItemCompletedNotification", "item.{type=agentMessage}.text"),
    ).toEqual([{ type: "string" }]);
    expect(resolveField(fixture, "ItemCompletedNotification", "item.{type=missing}.text")).toEqual(
      [],
    );
    const schema = await changed((d) => {
      const branch = (d.ThreadItem!.oneOf as Definitions[]).find(
        (node) => (properties(node).type!.enum as string[])[0] === "agentMessage",
      )!;
      delete properties(branch).text;
    });
    expect(checkProtocol(schema, PROTOCOL_CONTRACT).incompatibilities).toEqual([
      "item/started item.{type=agentMessage}.text is no longer in the schema",
      "item/completed item.{type=agentMessage}.text is no longer in the schema",
    ]);
  });

  it("expands an allOf that refers to a union, accepts integer as number, and skips open strings", () => {
    const schema: ProtocolSchema = {
      definitions: new Map<string, Record<string, unknown>>([
        ["Kind", { oneOf: [{ enum: ["a"] }, { enum: ["b", null] }] }],
        [
          "Reply",
          {
            type: "object",
            properties: {
              kind: { allOf: [{ $ref: "#/definitions/v2/Kind" }] },
              count: { type: "integer" },
              label: { anyOf: [{ type: "string" }, { enum: ["fixed"], type: "string" }] },
            },
          },
        ],
      ]),
      requestParams: new Map([["probe", "Reply"]]),
    };
    const contract: ProtocolContract = {
      requests: [
        {
          method: "probe",
          sends: [],
          response: {
            definition: "Reply",
            reads: [
              { path: "kind", types: ["string", "null"], expects: ["a", "b"], known: [] },
              { path: "count", types: ["number"] },
              { path: "label", types: ["string"], expects: ["gone"], known: [] },
            ],
          },
        },
      ],
      messages: [],
    };
    expect(checkProtocol(schema, contract)).toEqual({ incompatibilities: [], additions: [] });
  });
});

describe("app-server protocol check messages", () => {
  it("lists the first five changes and counts the rest", () => {
    const changes = ["a", "b", "c", "d", "e", "f", "g"];
    expect(protocolIncompatibilityMessage("0.161.0", changes)).toBe(
      "Codex CLI 0.161.0 changed the app-server protocol humanish uses: a; b; c; d; e; and 2 more.",
    );
    expect(protocolIncompatibilityMessage(undefined, [])).toBe(
      "Codex CLI changed the app-server protocol humanish uses.",
    );
    expect(protocolAdditionsWarning("0.161.0", ["x"])).toBe(
      "Codex CLI 0.161.0's app-server schema has values humanish has not seen: x. humanish recorded them and continued.",
    );
    expect(protocolAdditionsWarning("0.161.0", [])).toBeUndefined();
  });
});
