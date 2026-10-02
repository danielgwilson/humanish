import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkProtocol,
  loadProtocolSchema,
  protocolAdditionsWarning,
  protocolIncompatibilityMessage,
  resolveField,
  type ProtocolSchema,
} from "../../../src/actors/codex/protocol-compat.js";
import { protocolContract } from "../../../src/actors/codex/protocol-contract.js";
import { CODEX_SCHEMA_FIXTURE } from "../../helpers/codex-schema.js";

type Node = Record<string, unknown>;
type Definitions = Record<string, Node>;
type Change = (definitions: Definitions, requestParams: Map<string, string>) => void;

const contract = protocolContract({ reasoningEffort: "low", platform: "linux" });

/** The fixture schema after `change` edits a copy of its definitions and request methods. */
async function changed(change: Change): Promise<ProtocolSchema> {
  const fixture = await loadProtocolSchema(CODEX_SCHEMA_FIXTURE);
  const definitions = structuredClone(Object.fromEntries(fixture.definitions)) as Definitions;
  const requestParams = new Map(fixture.requestParams);
  change(definitions, requestParams);
  return {
    definitions: new Map(Object.entries(definitions)),
    requestParams,
    notificationParams: fixture.notificationParams,
  };
}

const check = async (change: Change) => checkProtocol(await changed(change), contract);
const properties = (node: Node) => node.properties as Definitions;
/** The union branch of `definition` whose `type` is fixed to `type`. */
const branch = (definitions: Definitions, definition: string, type: string): Node =>
  (definitions[definition]!.oneOf as Node[]).find(
    (node) => (properties(node).type!.enum as string[])[0] === type,
  )!;

/** Read-side changes the check refuses, each with the incompatibilities it reports. */
const READ_CHANGES: [string, Change, string | string[]][] = [
  [
    "a field humanish reads",
    (d) => delete properties(d.Thread!).id,
    "thread/start response thread.id is no longer in the schema",
  ],
  [
    "a field to `false`, which allows no value",
    (d) => (properties(d.Thread!).id = false as unknown as Node),
    "thread/start response thread.id is no longer in the schema",
  ],
  [
    "a field's type",
    (d) => (properties(d.TokenUsageBreakdown!).inputTokens = { type: "string" }),
    "thread/tokenUsage/updated tokenUsage.total.inputTokens now allows string; humanish reads integer",
  ],
  [
    "a container on the path to a field",
    (d) => (d.Thread = { anyOf: [d.Thread, { type: "string" }] }),
    [
      "thread/start response thread now allows string; humanish reads object",
      "thread/started thread now allows string; humanish reads object or null",
    ],
  ],
  [
    "a value humanish compares against",
    (d) => (d.TurnStatus!.enum = ["completed", "failed", "inProgress"]),
    "turn/completed turn.status no longer allows interrupted",
  ],
  [
    "a value through an allOf that narrows it",
    (d) => (d.TurnStatus = { allOf: [{ enum: ["completed"] }, d.TurnStatus] }),
    "turn/completed turn.status no longer allows interrupted",
  ],
  [
    "null where humanish requires it",
    (d) => (properties(d.Thread!).path = { type: "string" }),
    "thread/start response thread.path no longer allows null",
  ],
  [
    "the selected reasoning effort",
    (d) => (d.ReasoningEffort = { type: "string", enum: ["high"] }),
    [
      "config/read response config.model_reasoning_effort no longer allows low",
      "thread/start response thread.reasoningEffort no longer allows low",
      "thread/start response reasoningEffort no longer allows low",
      "turn/start request effort no longer accepts low",
    ],
  ],
  [
    "a container the item policy reads in every notification",
    (d) =>
      (properties(d.Thread!).turns = {
        type: "object",
        additionalProperties: { $ref: "#/definitions/Turn" },
      }),
    [
      "thread/started thread.turns now allows object; humanish reads array or null",
      "thread/started thread.turns[].items is no longer in the schema",
    ],
  ],
  [
    "a system layer's config",
    (d) => delete properties(d.ConfigLayer!).config,
    "config/read response layers[].config is no longer in the schema",
  ],
  [
    "the user layer's file",
    (d) => {
      const user = branch(d, "ConfigLayerSource", "user");
      delete properties(user).file;
      user.required = ["type"];
    },
    "config/read response layers[].name.{type=user}.file is no longer in the schema",
  ],
  [
    "the name of a container that carries items",
    (d) => {
      properties(d.Turn!).entries = properties(d.Turn!).items!;
      delete properties(d.Turn!).items;
    },
    [
      "thread/started thread.turns[].items is no longer in the schema",
      "turn/started turn.items is no longer in the schema",
      "turn/completed turn.items is no longer in the schema",
    ],
  ],
  [
    "an item container in a notification outside ServerNotification",
    (d) =>
      (properties(d.RawResponseItemCompletedNotification!).items = {
        type: "object",
        additionalProperties: { $ref: "#/definitions/ThreadItem" },
      }),
    "rawResponseItem/completed items now allows object; humanish reads array or null",
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
];

describe("app-server protocol check: fields humanish reads", () => {
  it("passes the trimmed 0.160.0 schema with nothing to refuse or record", async () => {
    const schema = await loadProtocolSchema(CODEX_SCHEMA_FIXTURE);
    expect(schema.requestParams.get("thread/start")).toBe("ThreadStartParams");
    expect(schema.notificationParams.get("thread/started")).toBe("ThreadStartedNotification");
    expect(checkProtocol(schema, contract)).toEqual({ incompatibilities: [], additions: [] });
  });

  it.each(READ_CHANGES)(
    "refuses a release that changes %s",
    async (_change, change, incompatibility) => {
      const result = await check(change);
      expect(result.incompatibilities).toEqual([incompatibility].flat());
      expect(result.additions).toEqual([]);
    },
  );

  it.each<[string, Change]>([
    ["wraps a definition in allOf with `true`", (d) => (d.Thread = { allOf: [true, d.Thread] })],
    [
      "changes a config layer field humanish does not read",
      (d) => (properties(branch(d, "ConfigLayerSource", "system")).file = { type: "integer" }),
    ],
    [
      "fixes a token count to an integer constant without a type",
      (d) => (properties(d.TokenUsageBreakdown!).inputTokens = { const: 1 }),
    ],
    [
      "gives started items a schema without the fields humanish reads on completion",
      (d) => {
        const started = structuredClone(d.ThreadItem!);
        const message = branch({ started }, "started", "agentMessage");
        for (const field of ["id", "text", "phase"]) delete properties(message)[field];
        message.required = ["type"];
        const tool = branch({ started }, "started", "dynamicToolCall");
        delete properties(tool).success;
        d.StartedThreadItem = started;
        properties(d.ItemStartedNotification!).item = {
          $ref: "#/definitions/StartedThreadItem",
        };
      },
    ],
  ])("passes a release that %s", async (_change, change) => {
    expect(await check(change)).toEqual({ incompatibilities: [], additions: [] });
  });

  it("records a value beyond the baseline without refusing", async () => {
    const result = await check((d) =>
      (d.ThreadItem!.oneOf as unknown[]).push({
        type: "object",
        properties: { type: { type: "string", enum: ["synthetic_new_item"] } },
      }),
    );
    expect(result).toEqual({
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
    const result = await check(
      (d) => delete properties(branch(d, "ThreadItem", "agentMessage")).text,
    );
    expect(result.incompatibilities).toEqual([
      "item/completed item.{type=agentMessage}.text is no longer in the schema",
    ]);
  });
});

describe("app-server protocol check: fields humanish sends", () => {
  it.each<[string, Change, string | string[]]>([
    [
      "a value humanish sends and compares against",
      (d) => ((d.AskForApproval!.oneOf as Node[])[0]!.enum = ["untrusted", "on-request"]),
      [
        "config/read response config.approval_policy no longer allows never",
        "thread/start request approvalPolicy no longer accepts never",
        "thread/start response approvalPolicy no longer allows never",
        "turn/start request approvalPolicy no longer accepts never",
      ],
    ],
    [
      "the type of a field humanish sends",
      (d) => (properties(d.TurnStartParams!).threadId = { type: "integer" }),
      "turn/start request threadId no longer accepts string",
    ],
    [
      "the params humanish sends",
      (d) => (d.ThreadStartParams!.required = ["cwd", "serviceTier"]),
      "thread/start request now requires serviceTier, which humanish does not send",
    ],
    [
      "an object humanish sends inside the params",
      (d) => (branch(d, "DynamicToolSpec", "function").required as string[]).push("strictMode"),
      "thread/start request dynamicTools[].{type=function} now requires strictMode, which humanish does not send",
    ],
    [
      "a field humanish sends, to one the params no longer accept",
      (d) => {
        delete properties(d.InitializeParams!).clientInfo;
        d.InitializeParams!.required = [];
        d.InitializeParams!.additionalProperties = false;
      },
      [
        "initialize request clientInfo is no longer accepted",
        "initialize request clientInfo.name is no longer accepted",
        "initialize request clientInfo.version is no longer accepted",
      ],
    ],
    [
      "the reply humanish sends to a tool call",
      (d) => delete properties(branch(d, "DynamicToolCallOutputContentItem", "inputText")).text,
      "item/tool/call reply contentItems[].{type=inputText}.text is no longer accepted",
    ],
    [
      "a client request",
      (_d, requests) => requests.delete("turn/interrupt"),
      "turn/interrupt is no longer a client request",
    ],
  ])("refuses a release that changes %s", async (_change, change, incompatibility) => {
    const result = await check(change);
    expect(result.incompatibilities).toEqual([incompatibility].flat());
    expect(result.additions).toEqual([]);
  });
});

describe("app-server protocol schema files and messages", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const copy = (): string => {
    const directory = mkdtempSync(path.join(tmpdir(), "humanish-schema-test-"));
    directories.push(directory);
    cpSync(CODEX_SCHEMA_FIXTURE, directory, { recursive: true });
    return directory;
  };

  it("refuses a schema file that is not a regular file, or is over 16 MiB, before reading it", async () => {
    // A link to an endless device, and a directory: lstat sees neither as a regular file, as it
    // does not see a FIFO, so none is opened.
    const link = copy();
    rmSync(path.join(link, "ClientRequest.json"));
    symlinkSync("/dev/zero", path.join(link, "ClientRequest.json"));
    await expect(loadProtocolSchema(link)).rejects.toThrow("is not a schema file");
    const folder = copy();
    rmSync(path.join(folder, "ClientRequest.json"));
    mkdirSync(path.join(folder, "ClientRequest.json"));
    await expect(loadProtocolSchema(folder)).rejects.toThrow("is not a schema file");
    const large = copy();
    truncateSync(path.join(large, "ServerNotification.json"), 16 * 1024 * 1024 + 1);
    await expect(loadProtocolSchema(large)).rejects.toThrow("is not a schema file");
  });

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
