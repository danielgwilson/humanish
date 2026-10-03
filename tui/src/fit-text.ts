/**
 * Fit a name to one line, keeping the start.
 *
 * The opposite of a path: a title is identified by its first words, so cutting the front of
 * "One participant, one small diagram: the rebuilt Observer's live path" leaves a row that reads
 * as somebody else's sentence. Paths keep their tail, names keep their head.
 */
export function fitLabelToWidth(value: string, width: number): string {
  const limit = Math.max(4, Math.floor(width));
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
