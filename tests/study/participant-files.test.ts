// participants[].files: files copied onto a participant's hosted desktop before it starts. The
// parser checks the declared shape; readDesktopFiles reads the files from the study's folder.

import { createHash } from "node:crypto";
import { link, mkdir, stat, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { readDesktopFiles } from "../../src/study/desktop-files.js";
import { planStudy } from "../../src/study/plan.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { libraryConfig } from "../helpers/library-config.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const photo = { from: "fixtures/photo.png", as: "Downloads/photo.png" };

function withFiles(files: unknown, base: BaseName = "cuAppUrl", patch: Patch = {}) {
  return parseStudy(lab(base, { participants: [{ id: "applicant", files }], ...patch }));
}

function refusedWith(result: ReturnType<typeof parseStudy>): string {
  if (result.ok) throw new Error("expected the study to be refused");
  expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
  return result.error.message;
}

describe("participants[].files in a study file", () => {
  it("keeps each file's from and as on a hosted computer-use participant", () => {
    const result = withFiles([photo]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.config.participants).toEqual([{ id: "applicant", files: [photo] }]);
  });

  it.each<[string, BaseName, Patch]>([
    ["a local browser", "cuAppUrl", { execution: { target: "local", timeoutMs: 60_000 } }],
    ["a shared world", "sharedProvisioned", {}],
  ])("refuses files on %s, which has no hosted computer-use desktop", (_label, base, patch) => {
    const raw = lab(base, patch);
    const roster = (raw.participants as Record<string, unknown>[] | undefined) ?? [
      { id: "applicant" },
    ];
    raw.participants = roster.map((entry) => ({ ...entry, files: [photo] }));
    const message = refusedWith(parseStudy(raw));
    expect(message).toMatch(/participants\[\]\.files/);
    expect(message).toMatch(/execution\.target: e2b-desktop/);
  });

  it.each([
    ["from", "an absolute path", "/etc/hosts"],
    ["from", "a path into a parent folder", "../outside.png"],
    ["from", "a parent segment inside the path", "fixtures/../../outside.png"],
    ["from", "a . segment", "./fixtures/photo.png"],
    ["from", "an empty segment", "fixtures//photo.png"],
    ["from", "a backslash", "fixtures\\photo.png"],
    ["as", "an absolute path", "/home/user/Downloads/photo.png"],
    ["as", "a path into a parent folder", "../photo.png"],
    ["as", "a trailing slash", "Downloads/"],
    ["as", "a home shorthand", "~/Downloads/photo.png"],
  ])("refuses a %s that is %s", (key, _label, value) => {
    const message = refusedWith(withFiles([{ ...photo, [key]: value }]));
    expect(message).toMatch(new RegExp(`participants\\[0\\]\\.files\\[0\\]\\.${key}`));
  });

  it.each([
    ".env",
    "config/.env.local",
    "keys/deploy.pem",
    ".humanish/runs/latest.json",
    "id_ed25519",
    ".ENV",
    "Keys/Deploy.PEM",
    ".Git/config",
  ])("refuses a from of %s, a file the local-tree archive also leaves out", (from) => {
    const message = refusedWith(withFiles([{ from, as: "Downloads/file" }]));
    expect(message).toMatch(/participants\[0\]\.files\[0\]\.from/);
  });

  it.each(["subject/photo.png", "subject", ".humanish-source.tar.gz", ".humanish/photo.png"])(
    "refuses an as of %s, a path humanish uses on the desktop",
    (as) => {
      const message = refusedWith(withFiles([{ from: photo.from, as }]));
      expect(message).toMatch(/participants\[0\]\.files\[0\]\.as/);
    },
  );

  it("refuses an as that is encoded text the run's checks cannot read", () => {
    const encoded = Buffer.from(Array.from({ length: 96 }, (_, n) => 128 + n)).toString(
      "base64url",
    );
    const message = refusedWith(withFiles([{ from: photo.from, as: `Downloads/${encoded}.png` }]));
    expect(message).toMatch(/participants\[0\]\.files\[0\]\.as/);
  });

  it("refuses two files that land at the same path", () => {
    const message = refusedWith(withFiles([photo, { from: "fixtures/other.png", as: photo.as }]));
    expect(message).toMatch(/participants\[0\]\.files\[1\]\.as/);
    expect(message).toMatch(/Downloads\/photo\.png/);
  });

  it("refuses a file whose path is the folder of another file", () => {
    const message = refusedWith(
      withFiles([
        { from: "fixtures/a.png", as: "Downloads/photos" },
        { from: "fixtures/b.png", as: "Downloads/photos/b.png" },
      ]),
    );
    expect(message).toMatch(/participants\[0\]\.files\[1\]\.as/);
  });

  it("places one source file under two names", () => {
    const copies = [photo, { from: photo.from, as: "Desktop/photo.png" }];
    const result = withFiles(copies);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.config.participants).toEqual([{ id: "applicant", files: copies }]);
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

const MIB = 1024 * 1024;

/** A study folder holding `files` (name to contents, or to a size for a sparse file). */
async function studyFolder(files: Record<string, string | number> = {}): Promise<string> {
  const root = await makeTestTempDir("humanish-desktop-files-");
  const folder = path.join(root, "studies");
  await mkdir(folder);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(folder, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof contents === "string" ? contents : "");
    if (typeof contents === "number") await truncate(file, contents);
  }
  return folder;
}

function refusal(result: Awaited<ReturnType<typeof readDesktopFiles>>): string {
  if (result.ok) throw new Error("expected the files to be refused");
  return result.message;
}

describe("readDesktopFiles", () => {
  it("reads each file from the study's folder with its size and sha256", async () => {
    const contents = "synthetic photo data";
    const folder = await studyFolder({ "fixtures/photo.png": contents });
    const result = await readDesktopFiles(folder, [{ id: "applicant", files: [photo] }]);
    if (!result.ok) throw new Error(result.message);
    const [file] = result.files.get("applicant") ?? [];
    expect(file?.as).toBe("Downloads/photo.png");
    expect(file?.size).toBe(20);
    expect(file?.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
    expect(Buffer.from(file?.data ?? new ArrayBuffer(0)).toString("utf8")).toBe(contents);
  });

  it.each<[string, (folder: string) => Promise<void>]>([
    ["is missing", async () => undefined],
    [
      "is a symbolic link to a file outside the folder",
      async (folder) => {
        await writeFile(path.join(folder, "..", "outside.png"), "outside");
        await symlink(path.join(folder, "..", "outside.png"), path.join(folder, "photo.png"));
      },
    ],
    [
      "is a symbolic link to a file inside the folder",
      async (folder) => {
        await writeFile(path.join(folder, "real.png"), "inside");
        await symlink(path.join(folder, "real.png"), path.join(folder, "photo.png"));
      },
    ],
    [
      "is a hard link",
      async (folder) => {
        await writeFile(path.join(folder, "..", "outside.png"), "outside");
        await link(path.join(folder, "..", "outside.png"), path.join(folder, "photo.png"));
      },
    ],
    ["is a folder", async (folder) => mkdir(path.join(folder, "photo.png")).then(() => undefined)],
  ])("refuses a from that %s, before anything is copied", async (_label, arrange) => {
    const folder = await studyFolder();
    await arrange(folder);
    const message = refusal(
      await readDesktopFiles(folder, [
        { id: "applicant", files: [{ from: "photo.png", as: "photo.png" }] },
      ]),
    );
    expect(message).toMatch(/applicant/);
    expect(message).toMatch(/files\[0\]\.from/);
  });

  it("refuses a from under a folder that is a symbolic link out of the study's folder", async () => {
    const folder = await studyFolder();
    const outside = path.join(folder, "..", "elsewhere");
    await mkdir(outside);
    await writeFile(path.join(outside, "photo.png"), "outside");
    await symlink(outside, path.join(folder, "fixtures"));
    const message = refusal(
      await readDesktopFiles(folder, [
        { id: "applicant", files: [{ from: "fixtures/photo.png", as: "photo.png" }] },
      ]),
    );
    expect(message).toMatch(/files\[0\]\.from/);
  });

  it("copies a file of 10 MiB and refuses one byte more", async () => {
    const folder = await studyFolder({ "at-limit.png": 10 * MIB, "past-limit.png": 10 * MIB + 1 });
    const at = await readDesktopFiles(folder, [
      { id: "applicant", files: [{ from: "at-limit.png", as: "a.png" }] },
    ]);
    expect(at.ok).toBe(true);
    const past = refusal(
      await readDesktopFiles(folder, [
        { id: "applicant", files: [{ from: "past-limit.png", as: "a.png" }] },
      ]),
    );
    expect(past).toMatch(/10 MiB/);
  });

  it("refuses a participant whose files total more than 25 MiB, counting a file each time it is placed", async () => {
    const folder = await studyFolder({ "scan.png": 9 * MIB });
    const copies = ["a.png", "b.png", "c.png"].map((as) => ({ from: "scan.png", as }));
    const message = refusal(await readDesktopFiles(folder, [{ id: "applicant", files: copies }]));
    expect(message).toMatch(/applicant/);
    expect(message).toMatch(/25 MiB/);
    expect(
      (await readDesktopFiles(folder, [{ id: "applicant", files: copies.slice(0, 2) }])).ok,
    ).toBe(true);
  });

  it("refuses a study whose distinct files total more than 100 MiB", async () => {
    const sizes = Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => [`scan-${n}.png`, 9 * MIB]),
    );
    const folder = await studyFolder(sizes);
    const participants = Object.keys(sizes).map((from, n) => ({
      id: `applicant-${n}`,
      files: [{ from, as: "Downloads/scan.png" }],
    }));
    expect(refusal(await readDesktopFiles(folder, participants))).toMatch(/100 MiB/);
    expect((await readDesktopFiles(folder, participants.slice(0, 11))).ok).toBe(true);
  });

  it("gives a file placed for many participants one read and counts it once toward the study", async () => {
    const folder = await studyFolder({ "scan.png": 9 * MIB });
    const participants = Array.from({ length: 12 }, (_, n) => ({
      id: `applicant-${n}`,
      files: [{ from: "scan.png", as: "Downloads/scan.png" }],
    }));
    const result = await readDesktopFiles(folder, participants);
    if (!result.ok) throw new Error(result.message);
    expect(result.files.size).toBe(12);
  });

  it.each(["/etc/profile.d/photo.png", "../photo.png", "Downloads/../../photo.png"])(
    "refuses an as of %s from a config that skipped the parser",
    async (as) => {
      const folder = await studyFolder({ "photo.png": "synthetic" });
      const message = refusal(
        await readDesktopFiles(folder, [{ id: "applicant", files: [{ from: "photo.png", as }] }]),
      );
      expect(message).toMatch(/files\[0\]\.as/);
    },
  );

  it("refuses when the study's folder cannot be read as a folder", async () => {
    const folder = await studyFolder({ "photo.png": "synthetic" });
    const message = refusal(
      await readDesktopFiles(path.join(folder, "photo.png"), [{ id: "applicant", files: [photo] }]),
    );
    expect(message).toMatch(/folder that holds the study file/);
  });

  it("reads nothing when no participant declares files", async () => {
    const folder = path.join(await studyFolder(), "never-created");
    const result = await readDesktopFiles(folder, [{ id: "applicant" }]);
    expect(result).toEqual({ ok: true, files: new Map() });
    await expect(stat(folder)).rejects.toThrow(/ENOENT/);
  });
});

describe("a library config with participants[].files", () => {
  it("is refused on the shared-world route, which copies no files", () => {
    const raw = lab("sharedProvisioned");
    raw.participants = (raw.participants as Record<string, unknown>[]).map((entry) => ({
      ...entry,
      files: [photo],
    }));
    const planned = planStudy(libraryConfig(raw), { cwd: process.cwd(), dryRun: true });
    if (planned.ok) throw new Error("expected the plan to be refused");
    expect(planned.refusal.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(planned.refusal.message).toMatch(/participants\[\]\.files/);
  });
});
