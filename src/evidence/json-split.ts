// When the JSON text of a value can be worked on one element of an array at a time. A run bundle
// holds every participant's trace in its `streams` array, and the bundle's whole text can pass
// V8's longest string, 536,870,888 characters on Node 24.
//
// JSON.stringify calls a toJSON with the value's key in its parent, and an element serialized
// alone gets "" in place of its index. It writes a boxed primitive as the primitive. A plain object
// or array with no toJSON is written as its own keys or items wherever it sits, and every value
// inside an element gets the same key alone as inside the whole value.

import { isRecord } from "../run/type-guards.js";

/**
 * `value` and the elements of its array `value[key]`, when JSON.stringify(value) holds each
 * element's text as JSON.stringify(element) writes it: `value` is a plain object that has `key`
 * among its own enumerable keys, `value[key]` is a plain array with no holes, and each element is
 * a plain object. A plain object has Object.prototype or null as its prototype, a plain array
 * Array.prototype, and neither has a toJSON. Otherwise undefined: the caller needs the whole text.
 * Getters and proxies are not detected.
 */
export function splitAtArray(
  value: unknown,
  key: string,
): { value: Record<string, unknown>; elements: Record<string, unknown>[] } | undefined {
  // JSON.stringify writes only own enumerable keys.
  if (!isPlainRecord(value) || !Object.keys(value).includes(key)) return undefined;
  const array = value[key];
  if (!isPlainArray(array)) return undefined;
  // Array.from reads a hole as undefined, where every would skip it.
  const elements = Array.from(array);
  return elements.every(isPlainRecord) ? { value, elements } : undefined;
}

const hasToJson = (value: object): boolean =>
  typeof (value as { toJSON?: unknown }).toJSON === "function";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || hasToJson(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isPlainArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && !hasToJson(value);
