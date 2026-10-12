// A running participant's items so far live in an append-only file, so a flush writes only the
// items recorded since the last one. The file is live/<position>.<generation>.ndjson, one item per
// line; run.json's liveActor indexes the prefix written so far by line count, byte count and a
// running sha256. A file only grows. When appending cannot keep what the file holds equal to the
// participant's list (the list shrank, an earlier item changed, an append failed, a sandbox id
// the run learned occurs in it), the writer starts the next generation with the full list, and
// removes the earlier one once run.json names the new one. This module owns that format: the
// trace loader reads through liveItemsFromBytes, the run writer through liveItemsWriter.

import { createHash } from "node:crypto";

import type { ActorTraceItem } from "../actors/contract.js";
import type { LiveItemsIndex } from "./streams.js";
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
