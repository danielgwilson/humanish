/**
 * Finds `/** *\/` blocks that document nothing: one followed by another doc block, by the end of
 * the file, or by a line that declares nothing. Line comments between a block and its declaration
 * are skipped, since the block still attaches there. A block with only comments above it that is
 * followed by an import is the file's header.
 */
export interface OrphanDocComment {
  line: number;
  reason: "followed by another doc comment" | "at end of file" | "not followed by a declaration";
  next?: string;
}

const DECLARATION =
  /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|const|let|var|class|interface|type|enum|namespace)\b/;
// A class, interface or object member: `name:`, `name?:`, `name(`, `name<`, `name =`, `"name":`,
// `[key: string]:`, an enum member `NAME,` / `NAME = 1`, or a get/set/static/readonly prefix.
const MEMBER =
  /^((readonly|private|protected|public|static|override|async|get|set|abstract|declare)\s+)*(\[[^\]]+\]\??|#?[A-Za-z_$][\w$]*\??|"[^"]+"\??|'[^']+'\??)\s*(:|\(|<|=|,|;|$)/;
// A member of a union written one per line, and a spread in an object literal.
const OTHER = /^(\||\.\.\.)/;

export function findOrphanDocComments(source: string): OrphanDocComment[] {
  const lines = source.split("\n");
  const issues: OrphanDocComment[] = [];
  let index = 0;
  let sawCode = false;
  while (index < lines.length) {
    const start = lines[index]!.indexOf("/**");
    if (!lines[index]!.trimStart().startsWith("/**")) {
      if (lines[index]!.trim() !== "" && !lines[index]!.trimStart().startsWith("//"))
        sawCode = true;
      index += 1;
      continue;
    }
    const header = !sawCode;
    sawCode = true;
    const opened = index;
    while (index < lines.length && !lines[index]!.includes("*/", opened === index ? start + 3 : 0))
      index += 1;
    const closeLine = lines[index] ?? "";
    // Code after `*/` on the same line (`/** doc */ name: string;`) is the documented member.
    const trailing = closeLine.slice(closeLine.indexOf("*/") + 2).trim();
    index += 1;
    if (trailing !== "") {
      if (!isDeclaration(trailing))
        issues.push({ line: opened + 1, reason: "not followed by a declaration", next: trailing });
      continue;
    }
    let next = index;
    while (
      next < lines.length &&
      (lines[next]!.trim() === "" || lines[next]!.trim().startsWith("//"))
    )
      next += 1;
    if (next >= lines.length) {
      issues.push({ line: opened + 1, reason: "at end of file" });
      continue;
    }
    const text = lines[next]!.trim();
    if (header && text.startsWith("import ")) continue;
    if (text.startsWith("/**")) {
      issues.push({ line: opened + 1, reason: "followed by another doc comment", next: text });
    } else if (!isDeclaration(text)) {
      issues.push({ line: opened + 1, reason: "not followed by a declaration", next: text });
    }
  }
  return issues;
}

function isDeclaration(text: string): boolean {
  return DECLARATION.test(text) || MEMBER.test(text) || OTHER.test(text);
}
