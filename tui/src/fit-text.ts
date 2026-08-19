/**
 * Fit a filesystem path to one line, keeping the END.
 *
 * A wrapped path costs two lines of a short screen and is harder to read than a truncated one. And
 * when it must be cut, the tail is the identifying half: the last segments name the project you are
 * looking at, while the leading segments are the part you already know because you typed them. The
 * ellipsis is what marks it as cut, so the reader never mistakes a truncated path for a real
 * relative one.
 */
export function fitPathToWidth(value: string, width: number): string {
  const limit = Math.max(4, Math.floor(width));
  if (value.length <= limit) return value;
  return `…${value.slice(value.length - (limit - 1))}`;
}
