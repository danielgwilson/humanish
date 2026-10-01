// The rule for a run file humanish treats as text: strict UTF-8, with no control bytes other than
// tab, line feed and carriage return. verify scans only such files for secrets, and bundle export
// copies only such files as text, so neither calls a file clean that it could not read.

const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

export type PlainText =
  | { ok: true; text: string }
  | { ok: false; reason: "invalid-utf8" | "control-bytes" };

export function readPlainText(bytes: Uint8Array): PlainText {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }
  if (CONTROL_BYTES.test(text)) return { ok: false, reason: "control-bytes" };
  return { ok: true, text };
}
