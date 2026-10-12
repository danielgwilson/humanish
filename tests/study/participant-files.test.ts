// participants[].files: files copied onto a participant's hosted desktop before it starts. The
// parser checks the declared shape; readDesktopFiles reads the files from the study's folder.

import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";

const card = { from: "fixtures/insurance-card.png", as: "Downloads/insurance-card.png" };

function withFiles(files: unknown, base: BaseName = "cuAppUrl", patch: Patch = {}) {
  return parseStudy(lab(base, { participants: [{ id: "patient", files }], ...patch }));
}

function refusedWith(result: ReturnType<typeof parseStudy>): string {
  if (result.ok) throw new Error("expected the study to be refused");
  expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  return result.error.message;
}

describe("participants[].files in a study file", () => {
  it("keeps each file's from and as on a hosted computer-use participant", () => {
    const result = withFiles([card]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.config.participants).toEqual([{ id: "patient", files: [card] }]);
  });

  it.each<[string, BaseName, Patch]>([
    ["a local browser", "cuAppUrl", { execution: { target: "local", timeoutMs: 60_000 } }],
    ["a shared world", "sharedProvisioned", {}],
  ])("refuses files on %s, which has no hosted computer-use desktop", (_label, base, patch) => {
    const raw = lab(base, patch);
    const roster = (raw.participants as Record<string, unknown>[] | undefined) ?? [
      { id: "patient" },
    ];
    raw.participants = roster.map((entry) => ({ ...entry, files: [card] }));
    const message = refusedWith(parseStudy(raw));
    expect(message).toMatch(/participants\[\]\.files/);
    expect(message).toMatch(/execution\.target: e2b-desktop/);
  });

  it.each([
    ["from", "an absolute path", "/etc/hosts"],
    ["from", "a path into a parent folder", "../outside.png"],
    ["from", "a parent segment inside the path", "fixtures/../../outside.png"],
    ["from", "a . segment", "./fixtures/card.png"],
    ["from", "an empty segment", "fixtures//card.png"],
    ["from", "a backslash", "fixtures\\card.png"],
    ["as", "an absolute path", "/home/user/Downloads/card.png"],
    ["as", "a path into a parent folder", "../card.png"],
    ["as", "a trailing slash", "Downloads/"],
    ["as", "a home shorthand", "~/Downloads/card.png"],
  ])("refuses a %s that is %s", (key, _label, value) => {
    const message = refusedWith(withFiles([{ ...card, [key]: value }]));
    expect(message).toMatch(new RegExp(`participants\\[0\\]\\.files\\[0\\]\\.${key}`));
  });

  it("refuses two files that land at the same path", () => {
    const message = refusedWith(withFiles([card, { from: "fixtures/other.png", as: card.as }]));
    expect(message).toMatch(/participants\[0\]\.files\[1\]\.as/);
    expect(message).toMatch(/Downloads\/insurance-card\.png/);
  });

  it("refuses a file whose path is the folder of another file", () => {
    const message = refusedWith(
      withFiles([
        { from: "fixtures/a.png", as: "Downloads/cards" },
        { from: "fixtures/b.png", as: "Downloads/cards/b.png" },
      ]),
    );
    expect(message).toMatch(/participants\[0\]\.files\[1\]\.as/);
  });

  it("places one source file under two names", () => {
    const copies = [card, { from: card.from, as: "Desktop/insurance-card.png" }];
    const result = withFiles(copies);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.config.participants).toEqual([{ id: "patient", files: copies }]);
  });

  it("refuses an empty list", () => {
    expect(refusedWith(withFiles([]))).toMatch(/participants\[0\]\.files/);
  });

  it("refuses more than 20 files for one participant", () => {
    const files = Array.from({ length: 21 }, (_, n) => ({
      from: `f${n}.png`,
      as: `Downloads/f${n}.png`,
    }));
    expect(refusedWith(withFiles(files))).toMatch(/participants\[0\]\.files.*20/);
    expect(withFiles(files.slice(0, 20)).ok).toBe(true);
  });
});
