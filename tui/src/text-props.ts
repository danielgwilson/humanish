/**
 * Ink's `<Text>` props are not optional-with-undefined, and this repo compiles with
 * `exactOptionalPropertyTypes`, so `color={maybeUndefined}` is a type error rather than "no colour".
 * Spreading an EMPTY object is how you say "do not set this prop at all".
 */
export function color(value: string | undefined): { color?: string } {
  return value === undefined ? {} : { color: value };
}
