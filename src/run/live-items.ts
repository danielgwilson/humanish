// A running participant's items so far live in an append-only file, so a flush writes only the
// items recorded since the last one. The file is live/<position>.<generation>.ndjson, one item per
// line; run.json's liveActor indexes the prefix written so far by line count, byte count and a
// running sha256. A file only grows. When appending cannot keep what the file holds equal to the
// participant's list (the list shrank, an earlier item changed, an append failed, a sandbox id
// the run learned occurs in it), the writer starts the next generation with the full list, and
// removes the earlier one once run.json names the new one. This module owns that format: the
// trace loader reads through liveItemsFromBytes, the run writer through liveItemsWriter.

import { createHash, type Hash } from "node:crypto";

import type { ActorTraceItem } from "../actors/contract.js";
import type { RunEvent } from "./bundle.js";
import {
  appendContainedOutputFile,
  createContainedOutputFile,
  type PreparedOutputRoot,
  readContainedPrefix,
  removeContainedOutputFile,
} from "./contained-output.js";
import { publicSandboxView } from "./sandbox-ids.js";
import type { LiveItemsIndex, RunStream } from "./streams.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from "./type-guards.js";

/** The live actor of a v3 run.json, whose items are in the file `itemsFile` names. */
export const LIVE_ACTOR_SCHEMA = "humanish.live-actor.v2";
/** The live actor of v1 and v2 run.json, with its items inline. */
export const LIVE_ACTOR_V1_SCHEMA = "humanish.live-actor.v1";

/** live/<position>.<generation>.ndjson: names the writer gives, by stream position, from 1. */
const LIVE_FILE = /^live\/([1-9]\d{0,5})\.([1-9]\d{0,8})\.ndjson$/;

/** Whether `value` is a live items index naming a live file name and its own generation. */
export function isLiveItemsIndex(value: unknown): value is LiveItemsIndex {
  if (!isRecord(value) || typeof value.path !== "string") return false;
  const name = LIVE_FILE.exec(value.path);
  return (
    name !== null &&
    isPositiveSafeInteger(value.generation) &&
    Number(name[2]) === value.generation &&
    isNonNegativeSafeInteger(value.items) &&
    isNonNegativeSafeInteger(value.bytes) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

/**
 * The items the indexed prefix of a live file holds, or why the bytes do not match the index:
 * `bytes` must be exactly the indexed byte count, hash to the indexed sha256, and hold the indexed
 * number of lines, each a JSON object.
 */
export function liveItemsFromBytes(
  bytes: Buffer,
  index: LiveItemsIndex,
): { items: ActorTraceItem[] } | { refused: string } {
  if (bytes.length !== index.bytes)
    return {
      refused: `${index.path} holds ${bytes.length} bytes and run.json records ${index.bytes}`,
    };
  if (createHash("sha256").update(bytes).digest("hex") !== index.sha256)
    return { refused: `${index.path} does not match the sha256 run.json records for it` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { refused: `${index.path} is not UTF-8 text` };
  }
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines.pop() !== "")
    return { refused: `${index.path} does not end its indexed bytes at a line end` };
  if (lines.length !== index.items)
    return {
      refused: `${index.path} holds ${lines.length} items and run.json records ${index.items}`,
    };
  const items: ActorTraceItem[] = [];
  for (const line of lines) {
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      return { refused: `${index.path} holds a line that is not JSON` };
    }
    if (!isRecord(item)) return { refused: `${index.path} holds a line that is not an item` };
    items.push(item as unknown as ActorTraceItem);
  }
  return { items };
}

/** One run's live files: what each stream position's current generation holds. */
export interface LiveItemsWriter {
  /**
   * `streams` with each running participant's items in its live file: every `liveActor` that
   * carries `items` becomes humanish.live-actor.v2 with `itemsFile` in their place. A `liveActor`
   * that already carries `itemsFile` (a bundle built from a run.json this writer wrote) carries the
   * list this writer last wrote for its position, and gets the same checks; at a position where
   * this writer holds no generation, it is kept as given. Items past what the participant's current
   * generation holds are appended, each through publicSandboxView with `sandboxIds`; a new
   * generation holding the full list starts when appending cannot keep the file equal to the list.
   * Every byte is on disk when this resolves, so a run.json written after it indexes nothing
   * missing. Call `published` once run.json naming the returned streams is written: it removes
   * every superseded generation those streams do not name, including the file of a stream that no
   * longer carries live items. A generation whose removal fails, or whose write's run.json failed
   * so `published` never ran, is removed by the next `published`. `events` is the one warn event
   * the run records once a participant's generation was replaced on two writes in a row, from that
   * write on; empty until then.
   */
  write(
    streams: readonly RunStream[],
    sandboxIds: readonly string[],
  ): Promise<{ streams: RunStream[]; events: RunEvent[]; published: () => Promise<void> }>;
  /** Remove every live file this writer created, and live/ once empty: after the final run.json. */
  remove(): Promise<void>;
}

/** A stream position's current generation: its file, and the items and bytes it holds. */
interface Generation {
  readonly path: string;
  readonly generation: number;
  /** The list the last write was given; its first `items` entries are the ones in the file. */
  written: readonly ActorTraceItem[];
  items: number;
  bytes: number;
  /** sha256 of the file's bytes so far; copied for each digest, so no write rehashes the file. */
  readonly hash: Hash;
}

/** The warning for a participant whose live items were written in full on two writes in a row. */
function rewrittenEvent(stream: RunStream, position: number): RunEvent {
  return {
    id: "event-live-items-rewritten",
    at: stream.liveActor?.updatedAt ?? stream.updatedAt,
    level: "warn",
    type: "live-items.rewritten",
    streamId: stream.id,
    message: `The live items of ${stream.id} were written again in full on two flushes in a row (live/${position}.<generation>.ndjson). A full write copies every item recorded so far, so as long as this goes on, each flush takes longer and writes more to disk than the one before. It happens when an item already written was replaced or removed, or an append to the live file failed. Check that the disk holding the run has free space and no write errors. If the disk is fine, report this run: the participant's recorder is replacing items it already recorded.`,
  };
}

/** Each item as its line in a live file, scrubbed of the run's raw sandbox ids. */
function itemLines(items: readonly ActorTraceItem[], sandboxIds: readonly string[]): Buffer {
  return Buffer.from(
    items.map((item) => `${JSON.stringify(publicSandboxView(item, sandboxIds))}\n`).join(""),
    "utf8",
  );
}

export function liveItemsWriter(root: PreparedOutputRoot): LiveItemsWriter {
  const current = new Map<number, Generation>();
  /** The highest generation started at each position, so a failed start never reuses a name. */
  const started = new Map<number, number>();
  /** Positions whose last append failed: their next write starts a new generation. */
  const appendFailed = new Set<number>();
  const created = new Set<string>();
  /** Generations no current index names: removed once a published run.json names none of them. */
  const superseded = new Set<string>();
  let knownIds = new Set<string>();
  /** Positions whose generation the previous write replaced, and the current write. */
  let replacedBefore = new Set<number>();
  let replaced = new Set<number>();
  let rewritten: RunEvent | undefined;

  const startGeneration = async (
    position: number,
    items: readonly ActorTraceItem[],
    sandboxIds: readonly string[],
  ): Promise<Generation> => {
    const generation = (started.get(position) ?? 0) + 1;
    started.set(position, generation);
    const path = `live/${position}.${generation}.ndjson`;
    const bytes = itemLines(items, sandboxIds);
    created.add(path);
    await createContainedOutputFile(root, path, bytes.toString("utf8"));
    const previous = current.get(position);
    if (previous !== undefined) {
      superseded.add(previous.path);
      replaced.add(position);
    }
    appendFailed.delete(position);
    const next: Generation = {
      path,
      generation,
      written: items,
      items: items.length,
      bytes: bytes.length,
      hash: createHash("sha256").update(bytes),
    };
    current.set(position, next);
    return next;
  };

  /**
   * Whether the generation can take an append: the list did not shrink, every item it holds is the
   * object it wrote, its last append did not fail, and no id the run learned since occurs in it.
   */
  const appendable = async (
    position: number,
    held: Generation,
    items: readonly ActorTraceItem[],
    learned: readonly string[],
  ): Promise<boolean> => {
    if (appendFailed.has(position) || items.length < held.items) return false;
    for (let index = 0; index < held.items; index += 1)
      if (items[index] !== held.written[index]) return false;
    if (learned.length === 0) return true;
    const read = await readContainedPrefix(root, held.path, held.bytes);
    return (
      read.status === "read" &&
      read.bytes.length === held.bytes &&
      !learned.some((id) => id.length > 0 && read.bytes.includes(id))
    );
  };

  const writeItems = async (
    position: number,
    items: readonly ActorTraceItem[],
    sandboxIds: readonly string[],
    learned: readonly string[],
  ): Promise<Generation> => {
    const held = current.get(position);
    if (held === undefined || !(await appendable(position, held, items, learned)))
      return startGeneration(position, items, sandboxIds);
    if (items.length > held.items) {
      const bytes = itemLines(items.slice(held.items), sandboxIds);
      try {
        await appendContainedOutputFile(root, held.path, bytes, held.bytes);
      } catch {
        // What the file holds past its index is unknown now; the full list starts over.
        appendFailed.add(position);
        return startGeneration(position, items, sandboxIds);
      }
      held.hash.update(bytes);
      held.bytes += bytes.length;
      held.items = items.length;
    }
    held.written = items;
    return held;
  };

  return {
    async write(streams, sandboxIds) {
      const learned = sandboxIds.filter((id) => !knownIds.has(id));
      replaced = new Set();
      const live = new Set<number>();
      const written: RunStream[] = [];
      for (const [index, stream] of streams.entries()) {
        const position = index + 1;
        const liveActor = stream.liveActor;
        // A live actor written as its index carries what its generation holds, so an id learned
        // now is looked for in that generation too before the ids count as known.
        const items = Array.isArray(liveActor?.items)
          ? liveActor.items
          : liveActor?.itemsFile === undefined
            ? undefined
            : current.get(position)?.written;
        if (liveActor === undefined || items === undefined) {
          written.push(stream);
          continue;
        }
        live.add(position);
        const held = await writeItems(position, items, sandboxIds, learned);
        const { items: _items, ...summary } = liveActor;
        const itemsFile: LiveItemsIndex = {
          path: held.path,
          generation: held.generation,
          items: held.items,
          bytes: held.bytes,
          sha256: held.hash.copy().digest("hex"),
        };
        written.push({
          ...stream,
          liveActor: { ...summary, schema: LIVE_ACTOR_SCHEMA, itemsFile } as typeof liveActor,
        });
      }
      // Known once every current generation was checked for them; a write that threw rechecks.
      knownIds = new Set([...knownIds, ...sandboxIds]);
      for (const [position, held] of current)
        if (!live.has(position)) {
          superseded.add(held.path);
          current.delete(position);
        }
      // Replaced on two writes in a row: each flush rewrites the whole list, as before live files.
      const churning = [...replaced].find((position) => replacedBefore.has(position));
      if (rewritten === undefined && churning !== undefined)
        rewritten = rewrittenEvent(streams[churning - 1]!, churning);
      replacedBefore = replaced;
      const named = new Set(written.map((stream) => stream.liveActor?.itemsFile?.path));
      return {
        streams: written,
        events: rewritten === undefined ? [] : [rewritten],
        published: async () => {
          // A removal that fails stays pending for the next published run.json.
          for (const path of superseded)
            if (!named.has(path))
              await removeContainedOutputFile(root, path).then(
                () => superseded.delete(path),
                () => undefined,
              );
        },
      };
    },
    async remove() {
      for (const path of created) await removeContainedOutputFile(root, path).catch(() => {});
      await removeContainedOutputFile(root, "live").catch(() => {});
    },
  };
}
