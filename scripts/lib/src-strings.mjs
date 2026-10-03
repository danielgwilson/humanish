// The string literals and template text in a parsed program: what a person reads in an error, a
// warning or command output. scripts/check-code-prose.mjs counts prose in them, and
// tests/surface/removed-export-names.test.ts checks them for the library names 0.109.0 removed.

const quasiText = (quasi) => quasi.value.cooked ?? quasi.value.raw;

/**
 * Every string literal and template text in a program (an oxc-parser tree), with its offset in the
 * file. A string with no whitespace is a code token, a path or an enum value (`"EXECUTE"`,
 * `"ESRCH"`, `"/tmp/x.XXXXXX"`) and is skipped, unless a template splices it into its text
 * (`${ok ? "PROVEN" : "not seen"}`) or `everyString` is set. A template counts as one string for
 * the whitespace test.
 */
export function* stringsOf(node, spliced = false, everyString = false) {
  if (node === null || typeof node !== "object") return;
  // A string literal type (`mode: "fail-closed" | "record-evidence"`) names a value, not a message.
  if (node.type === "TSLiteralType") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* stringsOf(child, spliced, everyString);
    return;
  }
  if (node.type === "Literal") {
    if (typeof node.value === "string" && (everyString || spliced || /\s/.test(node.value))) {
      yield { text: node.value, start: node.start };
    }
    return;
  }
  if (node.type === "TemplateLiteral") {
    if (everyString || /\s/.test(node.quasis.map(quasiText).join(""))) {
      for (const quasi of node.quasis) yield { text: quasiText(quasi), start: quasi.start };
    }
    yield* stringsOf(node.expressions, true, everyString);
    return;
  }
  // A branch of `a ? b : c` or `a ?? b` inside a template is still spliced text; its test is not.
  const branches =
    spliced && (node.type === "ConditionalExpression" || node.type === "LogicalExpression");
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent") yield* stringsOf(child, branches && key !== "test", everyString);
  }
}
