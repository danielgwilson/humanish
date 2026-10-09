// The words a reader sees for a run's subject. The `subject:` line of `humanish run`, the run's
// summary and each participant's sentence name it the same way.

/** A subject as a run records it: its source and, for a product used at a desktop, the product. */
interface NamedSubject {
  readonly source: string;
  readonly product?: string | undefined;
}

/**
 * The URL a participant opens names the subject. A product used at a desktop has no URL, so it is
 * named with its source, as in `humanish (desktop-cli)`. Empty when there is neither.
 */
export function subjectName(url: string, subject: NamedSubject): string {
  if (url !== "" || subject.product === undefined) return url;
  return `${subject.product} (${subject.source})`;
}
