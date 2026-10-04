// Text handling shared by the scorer: one normal form for matching, and the paragraph and sentence
// units the answer key's patterns run on.

/** Lower case, straight apostrophes, no double quotes or Markdown emphasis, single spaces. */
export function normalize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/["\u201C\u201D\u201F\u2033]/g, "")
    .replace(/[\u2013\u2014]/g, " - ")
    .replace(/\*\*|__|`/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Raw paragraphs: blank-line blocks, with each list item as its own paragraph and its bullet or
 * number removed.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:[-*\u2022]|\d+[.)])\s)/)
    .map((block) => block.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, "").trim())
    .filter((block) => block.length > 0);
}

/** Normalized sentences of one paragraph. */
export function sentences(paragraph: string): string[] {
  return normalize(paragraph)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** A heading or a list lead-in such as "What behaved unexpectedly:", which reports nothing itself. */
export function isHeading(paragraph: string): boolean {
  const line = paragraph.trim();
  return line.startsWith("#") || (line.length <= 80 && line.endsWith(":") && !line.includes("\n"));
}

/** The sentence as a quote for a results file: whitespace collapsed, at most 240 characters. */
export function quote(sentence: string): string {
  const flat = sentence.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 237)}...` : flat;
}
