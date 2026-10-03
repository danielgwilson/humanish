// Dotted field paths such as `execution.timeoutMs` or `actors[0].lanes[].entry`, read and deleted
// on a parsed object and on a YAML document node. The parsed participant list's key also matches
// a v2 `roster`, which the parser expands into that list. A mapping a deletion leaves empty is deleted with it.

import { isMap, isScalar, isSeq, type Pair, type YAMLMap } from "yaml";

interface Segment {
  readonly key: string;
  /** A list index, or `all` for `[]`. */
  readonly index?: number | "all";
}

function segments(path: string): Segment[] {
  return path.split(".").map((part) => {
    const match = /^([^[\]]+)(?:\[(\d*)\])?$/.exec(part);
    if (!match) throw new Error(`Unreadable field path: ${path}`);
    const [, key, index] = match;
    if (index === undefined) return { key: key! };
    return { key: key!, index: index === "" ? "all" : Number(index) };
  });
}

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `lanes` names the participant list after parsing; a v2 file may spell it `roster`.
function plainKey(record: PlainRecord, key: string): string {
  return key === "lanes" && !(key in record) && "roster" in record ? "roster" : key;
}

function itemsAt<T>(list: readonly T[], index: number | "all"): T[] {
  if (index === "all") return [...list];
  const item = list[index];
  return item === undefined ? [] : [item];
}

/** The value at `path`, or for a `[]` segment the values found in each item; undefined if none. */
export function readFieldPath(root: unknown, path: string): unknown {
  const read = (value: unknown, rest: readonly Segment[]): unknown[] => {
    const [segment, ...tail] = rest;
    if (segment === undefined) return [value];
    if (!isPlainRecord(value)) return [];
    const child = value[plainKey(value, segment.key)];
    if (child === undefined) return [];
    if (segment.index === undefined) return read(child, tail);
    if (!Array.isArray(child)) return [];
    return itemsAt(child, segment.index).flatMap((item) => read(item, tail));
  };
  const parsed = segments(path);
  const found = read(root, parsed);
  if (found.length === 0) return undefined;
  return parsed.some((segment) => segment.index === "all") ? found : found[0];
}

/** Delete `path` from a parsed object. Returns whether anything was deleted. */
export function deletePlainFieldPath(root: unknown, path: string): boolean {
  const remove = (value: unknown, rest: readonly Segment[]): boolean => {
    const [segment, ...tail] = rest;
    if (segment === undefined || !isPlainRecord(value)) return false;
    const key = plainKey(value, segment.key);
    if (!(key in value)) return false;
    const child = value[key];
    let removed: boolean;
    if (segment.index === undefined) {
      if (tail.length === 0) {
        delete value[key];
        return true;
      }
      removed = remove(child, tail);
    } else {
      if (!Array.isArray(child)) return false;
      removed = itemsAt(child, segment.index).reduce<boolean>(
        (any, item) => remove(item, tail) || any,
        false,
      );
    }
    if (removed && isPlainRecord(child) && Object.keys(child).length === 0) delete value[key];
    return removed;
  };
  return remove(root, segments(path));
}

function mapKey(map: YAMLMap, key: string): string {
  const has = (name: string) =>
    map.items.some((pair) => isScalar(pair.key) && pair.key.value === name);
  return key === "lanes" && !has(key) && has("roster") ? "roster" : key;
}

/** The index of `key`'s pair in a YAML mapping, or -1. */
export function pairIndex(map: YAMLMap, key: string): number {
  return map.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === key);
}

/**
 * Delete `path` from a YAML document's root mapping. Returns the deleted pairs, including the
 * mappings a deletion left empty, so the caller can report their comments.
 */
export function deleteNodeFieldPath(root: unknown, path: string): Pair[] {
  const remove = (node: unknown, rest: readonly Segment[]): Pair[] => {
    const [segment, ...tail] = rest;
    if (segment === undefined || !isMap(node)) return [];
    const index = pairIndex(node, mapKey(node, segment.key));
    if (index < 0) return [];
    const pair = node.items[index]!;
    let removed: Pair[];
    if (segment.index === undefined) {
      if (tail.length === 0) {
        // A mapping holds the comment above its first key; it goes with that key.
        if (index === 0 && node.commentBefore && isScalar(pair.key)) {
          pair.key.commentBefore = [node.commentBefore, pair.key.commentBefore]
            .filter(Boolean)
            .join("\n");
          node.commentBefore = null;
        }
        return node.items.splice(index, 1);
      }
      removed = remove(pair.value, tail);
    } else {
      if (!isSeq(pair.value)) return [];
      removed = itemsAt(pair.value.items, segment.index).flatMap((item) => remove(item, tail));
    }
    if (removed.length > 0 && isMap(pair.value) && pair.value.items.length === 0)
      removed.push(...node.items.splice(index, 1));
    return removed;
  };
  return remove(root, segments(path));
}
