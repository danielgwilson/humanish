// Deprecated fields on a value humanish hands to a caller. Each is a getter that warns once per
// process when read. The getters are not enumerable, so a spread, `Object.assign`,
// `JSON.stringify` or `structuredClone` of the value skips them and warns about no field the
// caller never named; `"name" in value` still finds them. Core never reads them.

/** One deprecated field: what to read instead, and how to compute the old value. */
export interface DeprecatedField {
  readonly replacement: string;
  readonly read: () => unknown;
}

const warned = new Set<string>();

/** Adds `fields` to `value` as warning getters and returns `value`. */
export function withDeprecatedFields<T extends object>(
  value: T,
  owner: { readonly name: string; readonly code: `HUMANISH_${string}` },
  fields: Readonly<Record<string, DeprecatedField>>,
): T {
  return Object.defineProperties(
    value,
    Object.fromEntries(
      Object.entries(fields).map(([field, { replacement, read }]) => [
        field,
        {
          enumerable: false,
          get: () => {
            warnOnce(`${owner.name}.${field}`, replacement, owner.code);
            return read();
          },
        },
      ]),
    ),
  );
}

function warnOnce(name: string, replacement: string, code: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  process.emitWarning(
    `${name} is deprecated and is removed in the next minor. Use ${replacement}.`,
    { type: "DeprecationWarning", code },
  );
}
