// When the JSON text of a value can be worked on one element of an array at a time. A run bundle
// holds every participant's trace in its `streams` array, and the bundle's whole text can pass
// V8's longest string, 536,870,888 characters on Node 24.
//
// JSON.stringify calls a toJSON with the value's key in its parent, and an element serialized
// alone gets "" in place of its index. It writes a boxed primitive as the primitive. A plain object
// or array with no toJSON is written as its own keys or items wherever it sits, and every value
// inside an element gets the same key alone as inside the whole value.

import { isRecord } from "../run/type-guards.js";

/** The JSON text of a value cut around the elements of one of its arrays. */
export interface ArraySplit {
  /** The array's elements, read as JSON.stringify reads them. */
  readonly elements: readonly Record<string, unknown>[];
  /** The value's JSON text up to and including the array's `[`. */
  before(): string;
  /** The value's JSON text from the array's `]` on. */
  after(): string;
}

/**
 * The cut of JSON.stringify(value) around the elements of its array `value[key]`, when that text
 * holds each element's text as JSON.stringify(element) writes it: `value` is a plain object that
 * has `key` among its own enumerable keys, `value[key]` is a plain array with no holes, and each
 * element is a plain object. A plain object has Object.prototype or null as its prototype, a plain
 * array Array.prototype, and neither has a toJSON. Otherwise undefined: the caller needs the whole
 * text. Getters, proxies and a toJSON that changes `value` while it is serialized are not detected:
 * the elements are read before anything is serialized. before() and after() serialize the members
 * on their side of the array when called, so a caller that calls before(), serializes each element
 * and then calls after() runs every toJSON in the order JSON.stringify(value) runs them.
 */
export function splitAtArray(value: unknown, key: string): ArraySplit | undefined {
  // JSON.stringify writes only own enumerable keys.
  if (!isPlainRecord(value)) return undefined;
  const keys = Object.keys(value);
  const at = keys.indexOf(key);
  if (at === -1) return undefined;
  const array = value[key];
  if (!isPlainArray(array)) return undefined;
  // JSON.stringify reads the length once and then each index, so a hole reads as undefined and an
  // own iterator is never called. Array.from would call that iterator, and every skips holes.
  const elements: unknown[] = [];
  for (let index = 0, length = array.length; index < length; index += 1)
    elements.push(array[index]);
  if (!elements.every(isPlainRecord)) return undefined;
  // fromEntries keeps a key such as __proto__ an own property.
  const members = (from: number, to?: number) =>
    Object.fromEntries(keys.slice(from, to).map((name) => [name, value[name]]));
  return {
    elements,
    before: () => JSON.stringify({ ...members(0, at), [key]: [] }).slice(0, -"]}".length),
    after: () => {
      const text = JSON.stringify(members(at + 1));
      return text === "{}" ? "]}" : `],${text.slice(1)}`;
    },
  };
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
