// Scenarios in an analysis characterization golden often leave the same file: a reused or re-run
// analysis keeps the receipt and report an earlier completed scenario wrote. A file exactly equal
// to the same-named file of an earlier scenario is pinned as a reference to that scenario; a file
// that differs in any way is pinned in full. expandRepeatedFiles rebuilds the scenarios, and the
// golden test checks that it does.

import { isDeepStrictEqual } from "node:util";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MARKER = /^\[same as scenario "(.+)"\]$/;
const sameAs = (scenario: string) => `[same as scenario "${scenario}"]`;

/** The scenarios with each file equal to an earlier scenario's same-named file as a reference. */
export function referenceRepeatedFiles(scenarios: Json): Json {
  // The first scenario that wrote each distinct content of a file name.
  const written = new Map<string, Array<{ scenario: string; content: unknown }>>();
  const out: Json = {};
  for (const [scenario, recorded] of Object.entries(scenarios)) {
    if (!isRecord(recorded) || !isRecord(recorded.files)) {
      out[scenario] = recorded;
      continue;
    }
    const files: Json = {};
    for (const [name, content] of Object.entries(recorded.files)) {
      const earlier = written.get(name) ?? [];
      const same = earlier.find((entry) => isDeepStrictEqual(entry.content, content));
      if (same !== undefined) files[name] = sameAs(same.scenario);
      else {
        files[name] = content;
        written.set(name, [...earlier, { scenario, content }]);
      }
    }
    out[scenario] = { ...recorded, files };
  }
  return out;
}

/** The scenarios that referenceRepeatedFiles pinned, with each reference replaced by the file. */
export function expandRepeatedFiles(scenarios: Json): Json {
  const out: Json = {};
  for (const [scenario, recorded] of Object.entries(scenarios)) {
    if (!isRecord(recorded) || !isRecord(recorded.files)) {
      out[scenario] = recorded;
      continue;
    }
    const files: Json = {};
    for (const [name, content] of Object.entries(recorded.files)) {
      const source = typeof content === "string" ? MARKER.exec(content)?.[1] : undefined;
      const sourceFiles = source === undefined ? undefined : scenarios[source];
      files[name] =
        isRecord(sourceFiles) && isRecord(sourceFiles.files) ? sourceFiles.files[name] : content;
    }
    out[scenario] = { ...recorded, files };
  }
  return out;
}
