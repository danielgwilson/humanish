// What a local agent is told each turn and how its reply is read: the reply shape, derived from
// the participant action schema Codex's humanish_ui tool also uses, so both agents propose from
// one vocabulary; what the agent's last actions read (a pointer position, a zoom frame); and the
// JSON reading that turns a Claude Code answer into a CuaTurn. The one-shot provider (cli.ts) and
// the session (claude-session.ts) share it.

import { z } from "zod";

import { participantActionSchema } from "../../browser-control/protocol.js";
import type { ParticipantDeclaredOutcome } from "../contract.js";
import type { CuaAction, CuaTurn, CuaTurnRequest } from "../computer-use/loop.js";

/**
 * Read the agent's proposed actions with the participant action schema the Codex tool also uses
 * (src/browser-control/protocol.ts), so both local agents share one vocabulary. A null field reads
 * as absent: the reply shape once asked for every field, null where unused. A `done` marker
 * carries no action. The first proposal the schema refuses becomes the turn's rejected proposal,
 * and nothing after it runs: a coordinate we invented would be recorded as the participant's
 * choice, and a later action may depend on the refused one.
 */
export function proposedActions(
  raw: readonly unknown[],
): Pick<CuaTurn, "actions" | "rejectedProposal"> {
  const actions: CuaAction[] = [];
  for (const [index, item] of raw.entries()) {
    const fields =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null))
        : item;
    if ((fields as { kind?: unknown } | null)?.kind === "done") continue;
    const parsed = participantActionSchema.safeParse(fields);
    if (parsed.success) {
      actions.push(parsed.data);
      continue;
    }
    const kind = (fields as { kind?: unknown } | null)?.kind;
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
    return {
      actions,
      rejectedProposal: {
        reason: `Action ${index + 1} (${typeof kind === "string" ? kind.slice(0, 40) : "no kind"}) does not match its shape in the reply format${where}.`,
      },
    };
  }
  return { actions };
}

/** One JSON Schema node of the participant action schema, as far as the reply shape renders it. */
interface ShapeNode {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  items?: ShapeNode;
  properties?: Record<string, ShapeNode>;
  required?: string[];
  description?: string;
  oneOf?: ShapeNode[];
}

/** A compact TypeScript-like rendering of one schema node: `{"kind":"zoom","region":{...}}`. */
function shapeOf(node: ShapeNode): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum !== undefined) return node.enum.map((value) => JSON.stringify(value)).join("|");
  if (node.type === "array") return `[${node.items === undefined ? "" : shapeOf(node.items)}]`;
  if (node.type === "object") {
    const required = new Set(node.required ?? []);
    const fields = Object.entries(node.properties ?? {}).map(
      ([key, value]) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}:${shapeOf(value)}`,
    );
    return `{${fields.join(",")}}`;
  }
  return node.type ?? "unknown";
}

/** One line per action the participant schema admits, with the description it carries. */
const ACTION_SHAPES = (
  (z.toJSONSchema(participantActionSchema, { io: "input" }) as ShapeNode).oneOf ?? []
)
  .map((node) => `${shapeOf(node)}${node.description === undefined ? "" : `  ${node.description}`}`)
  .join("\n");

/**
 * The turn an agent's parsed reply asks for. A reply with no actions and closing words is done;
 * one whose only proposal was refused is not, since the participant asked to act.
 */
export function turnFromReply(reply: Record<string, unknown>): CuaTurn {
  const { actions, rejectedProposal } = proposedActions(
    Array.isArray(reply.actions) ? reply.actions : [],
  );
  const done =
    reply.done === true ||
    (actions.length === 0 && rejectedProposal === undefined && typeof reply.message === "string");
  const outcome = declaredOutcomeOf(reply.outcome);
  return {
    actions,
    ...(rejectedProposal === undefined ? {} : { rejectedProposal }),
    pendingSafetyChecks: [],
    done,
    ...(outcome === undefined ? {} : { outcome }),
    ...(typeof reply.reasoning === "string" && reply.reasoning.length > 0
      ? { reasoning: reply.reasoning }
      : {}),
    ...(typeof reply.message === "string" && reply.message.length > 0
      ? { message: reply.message }
      : {}),
  };
}

/**
 * What the agent's last actions read, as sentences for its next message: a pointer position as
 * text, and a zoom frame as an image file `saveFrame` writes where the agent may Read it. Empty
 * when they read nothing.
 */
export async function readResultsNote(
  request: CuaTurnRequest,
  saveFrame: (index: number, png: Buffer) => Promise<string>,
): Promise<string> {
  const lines: string[] = [];
  for (const { index, result } of request.previousExecution?.actions ?? []) {
    if (result?.kind === "pointer")
      lines.push(
        `Action ${index + 1} (read_pointer): the pointer is at (${result.x}, ${result.y}).`,
      );
    else if (result?.kind === "frame")
      lines.push(
        `Action ${index + 1} (zoom): Read the image file ${await saveFrame(index, result.screenshot)}. It is the region you asked for, captured when the action ran.`,
      );
  }
  return lines.join("\n");
}

/** The declared outcome, only if it is one of the three words; anything else is absence. */
function declaredOutcomeOf(value: unknown): ParticipantDeclaredOutcome | undefined {
  return value === "reached" || value === "not_reached" || value === "blocked" ? value : undefined;
}

/**
 * Pull the JSON object out of whatever the CLI printed: clean JSON, a Claude Code envelope, or an
 * answer wrapped in a ```json fence. A response with no object at all is a turn error, never an
 * empty turn: an empty turn would read to the loop as "the participant chose to do nothing".
 */
export function parseAgentJson(text: string): Record<string, unknown> {
  // Order matters, and a test caught it: Claude Code's envelope is valid JSON whose `result`
  // string contains a ```json fence. Stripping fences first reached inside that string and
  // mangled the envelope. So: parse what we were given, and only go fence-hunting if it is not
  // already JSON.
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim());
  const bare = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (text.indexOf("{") >= 0 && bare.length > 1) attempts.push(bare);

  for (const attempt of attempts) {
    if (attempt.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next shape
    }
  }
  throw new Error("the local agent did not return a JSON object");
}

/**
 * The turn prompt for Claude Code: the instructions, the screenshot to read, what the last actions
 * read, and the reply shape.
 */
export function promptFor(request: CuaTurnRequest, screenshotPath: string, results = ""): string {
  const hint =
    request.contextHint === undefined ? "" : `\n\nNote from the harness: ${request.contextHint}`;
  // Claude Code has no --output-schema, so the reply shape is stated in the prompt.
  const shape =
    '{"reasoning":string,"done":boolean,"message":string|null,"outcome":"reached"|"not_reached"|"blocked"|null,"actions":[action]}';
  // prose-check: model prompt (the participant model reads this, not a person)
  return [
    request.instructions,
    "",
    `Read the image file ${screenshotPath}. That image is the CURRENT SCREEN. You are the participant: decide what to do next, ` +
      "as this person would. Coordinates are pixels from the top-left of the screenshot.",
    ...(results === "" ? [] : [results]),
    "Return between one and three actions. Set done=true ONLY when the task is finished or you are " +
      "giving up, and put your closing words in message. When done=true, set outcome: reached if " +
      "the task is finished, blocked if something in the app stopped you, not_reached if you are " +
      "stopping for another reason. Otherwise outcome is null.",
    "A turn whose actions are only waits and that asks for some wait time asks to wait its waits' " +
      "ms together; an ask shorter than a wait whose ms is null counts as one, and named ms count " +
      "up to the study's longest wait. The note from the harness says how long you waited and why " +
      "it ended. A wait among other actions lasts its ms, and the note says when the study's limit " +
      "for one wait shortened it.",
    `Reply with ONLY a JSON object of this shape: ${shape}`,
    "Each action is one of these objects; a key marked ? may be left out:",
    ACTION_SHAPES,
    hint,
  ].join("\n");
}
