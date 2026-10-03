/** A string literal or template text, with its offset in the file. */
export interface SourceString {
  text: string;
  start: number;
}
export function stringsOf(
  node: unknown,
  spliced?: boolean,
  everyString?: boolean,
): Generator<SourceString>;
