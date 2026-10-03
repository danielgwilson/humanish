// `humanish migrate`, held to four properties:
// 1. A second run changes nothing.
// 2. It never overwrites or deletes a file it did not convert, and a name collision refuses and
//    names both files.
// 3. It prints every path it will write before it writes, and --dry-run writes nothing.
// 4. Every committed v2 lab round-trips to a v3 study that parses and plans the same.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, link, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { parseStudy, parseStudyDocument } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import { migrateStudies } from "../../src/study/migrate.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let cwd: string;
beforeEach(async () => {
  cwd = await makeTestTempDir("humanish-migrate-");
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const v2 = (id: string) =>
  stringify({
    schema: "humanish.lab.v2",
    id,
    subject: { source: "this-repo" },
    actors: [{ type: "synthetic-persona", count: 2 }],
  });

async function write(relativePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
  await writeFile(path.join(cwd, relativePath), contents);
}

// Every file under the project, by relative path, with its sha256.
async function tree(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(cwd, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files[path.relative(cwd, absolute)] = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex");
  }
  return files;
}

async function copyCommittedLabs(): Promise<string[]> {
  // The 21 v2 files this repo committed before its studies moved to humanish/studies.
  const fixtures = path.join(ROOT, "tests", "fixtures", "labs-v2");
  const names = (await readdir(fixtures)).filter((name) => name.endsWith(".yaml")).sort();
  await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
  for (const name of names)
    await cp(path.join(fixtures, name), path.join(cwd, "humanish", "labs", name));
  return names;
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("a second run", () => {
  it("changes nothing", async () => {
    await copyCommittedLabs();
    const first = await migrateStudies({ cwd });
    expect(first.ok).toBe(true);
    const after = await tree();

    const second = await migrateStudies({ cwd });
    expect(second.ok).toBe(true);
    expect(second.files.every((file) => file.action === "skip")).toBe(true);
    expect(second.files).toHaveLength(21);
    expect(await tree()).toEqual(after);
  });
});

describe("files migrate did not convert", () => {
  it("refuses a name a studies file already uses, names both, and touches nothing", async () => {
    await write("humanish/labs/foo.yaml", v2("foo"));
    await write("humanish/studies/foo.yaml", "schema: humanish.study.v3\nid: foo-new\n");
    await write("humanish/labs/notes.md", "# notes\n");
    const before = await tree();

    const result = await migrateStudies({ cwd });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      code: "HUMANISH_MIGRATE_REFUSED",
      phase: "plan",
      file: "humanish/labs/foo.yaml",
      message:
        "humanish/labs/foo.yaml and humanish/studies/foo.yaml share the name foo. Keep one, then migrate.",
    });
    expect(await tree()).toEqual(before);
  });

  it("refuses two files in one directory that would share a name", async () => {
    await write("humanish/labs/bar.yaml", v2("bar"));
    await write("humanish/labs/bar.yml", v2("bar-old"));
    const before = await tree();

    const result = await migrateStudies({ cwd });
    expect(result.error?.message).toBe(
      "humanish/labs/bar.yml and humanish/labs/bar.yaml would share the name bar in humanish/studies. Remove one, then migrate.",
    );
    expect(await tree()).toEqual(before);
  });

  it("refuses a source that changed after the plan, and leaves every file as it found it", async () => {
    await write("humanish/labs/foo.yaml", v2("foo"));
    await write("humanish/labs/qux.yaml", v2("qux"));
    const edited = `${v2("foo")}# edited after the plan\n`;

    const result = await migrateStudies({
      cwd,
      // Runs after the plan read the file and before the commit phase rechecks it.
      onPlan: () => writeFileSync(path.join(cwd, "humanish/labs/foo.yaml"), edited),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.phase).toBe("commit");
    expect(await readFile(path.join(cwd, "humanish/labs/foo.yaml"), "utf8")).toBe(edited);
    expect(Object.keys(await tree()).sort()).toEqual([
      "humanish/labs/foo.yaml",
      "humanish/labs/qux.yaml",
    ]);
  });

  it("rewrites a v2 file outside labs/ in place and keeps no backup", async () => {
    await write("humanish/studies/inplace.yaml", v2("inplace"));
    const result = await migrateStudies({ cwd });
    expect(result.files).toMatchObject([
      { source: "humanish/studies/inplace.yaml", action: "rewrite" },
    ]);
    expect(Object.keys(await tree())).toEqual(["humanish/studies/inplace.yaml"]);
    expect(
      parse(await readFile(path.join(cwd, "humanish/studies/inplace.yaml"), "utf8")),
    ).toMatchObject({
      schema: "humanish.study.v3",
      participants: 2,
    });
  });

  it("refuses a file reached through a symbolic link, and leaves its target alone", async () => {
    const outside = await makeTestTempDir("humanish-migrate-outside-");
    try {
      await writeFile(path.join(outside, "x.yaml"), v2("x"));
      await mkdir(path.join(cwd, "humanish"), { recursive: true });
      await symlink(outside, path.join(cwd, "humanish", "labs"));

      const scanned = await migrateStudies({ cwd });
      const given = await migrateStudies({ cwd, paths: ["humanish/labs/x.yaml"] });
      expect(scanned.error).toMatchObject({ phase: "plan" });
      expect(given.error).toMatchObject({
        code: "HUMANISH_MIGRATE_REFUSED",
        phase: "plan",
        file: "humanish/labs/x.yaml",
      });
      expect(await readFile(path.join(outside, "x.yaml"), "utf8")).toBe(v2("x"));
      expect(existsSync(path.join(cwd, "humanish", "studies"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes and reads back each file on a filesystem without hard links", async () => {
    await write("humanish/labs/foo.yaml", v2("foo"));
    const noLinks = async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    const result = await migrateStudies({ cwd, link: noLinks });
    expect(result.ok).toBe(true);
    expect(Object.keys(await tree())).toEqual(["humanish/studies/foo.yaml"]);
    expect(
      parse(await readFile(path.join(cwd, "humanish/studies/foo.yaml"), "utf8")),
    ).toMatchObject({ schema: "humanish.study.v3", id: "foo" });
  });

  it("undoes every commit when a link fails for another reason, and keeps every source", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    await write("humanish/labs/b.yaml", v2("b"));
    const before = await tree();
    let calls = 0;
    const secondFails = async (from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("i/o error"), { code: "EIO" });
      await link(from, to);
    };
    const result = await migrateStudies({ cwd, link: secondFails });
    expect(result.error).toMatchObject({ code: "HUMANISH_MIGRATE_FAILED", phase: "commit" });
    expect(await tree()).toEqual(before);
  });

  it("rewrites a file outside the study directories even when a study shares its name", async () => {
    await write("configs/a.yaml", v2("a"));
    await write("humanish/labs/a.yml", v2("a-study"));
    const result = await migrateStudies({ cwd, paths: ["configs/a.yaml"] });
    expect(result.ok).toBe(true);
    expect(parse(await readFile(path.join(cwd, "configs/a.yaml"), "utf8")).schema).toBe(
      "humanish.study.v3",
    );
    expect(await readFile(path.join(cwd, "humanish/labs/a.yml"), "utf8")).toBe(v2("a-study"));
  });

  it("migrates two given files whose names discovery would not read", async () => {
    await write("one.study", v2("one"));
    await write("two.study", v2("two"));
    const result = await migrateStudies({ cwd, paths: ["one.study", "two.study"] });
    expect(result.ok).toBe(true);
    for (const name of ["one.study", "two.study"])
      expect(parse(await readFile(path.join(cwd, name), "utf8")).schema).toBe("humanish.study.v3");
  });

  it("refuses a path outside the project", async () => {
    const result = await migrateStudies({ cwd, paths: ["../elsewhere.yaml"] });
    expect(result.error).toMatchObject({ code: "HUMANISH_MIGRATE_REFUSED", phase: "plan" });
  });
});

describe("changes during a run", () => {
  it("refuses a staged copy that changed before commit, and keeps it for checking", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const result = await migrateStudies({
      cwd,
      onPhase: (finished) => {
        if (finished !== "stage") return;
        const dir = path.join(cwd, "humanish/studies");
        const temp = readdirSync(dir).find((name) => name.endsWith(".tmp"))!;
        writeFileSync(path.join(dir, temp), "NOT A STUDY\n");
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.error?.message).toMatch(/the staged copy of humanish\/labs\/a.yaml changed/);
    expect(result.error?.message).toMatch(
      /Kept for you to check: humanish\/studies\/\.a\.yaml\.migrate-.*\.tmp/,
    );
    expect(await readFile(path.join(cwd, "humanish/labs/a.yaml"), "utf8")).toBe(v2("a"));
    expect(existsSync(path.join(cwd, "humanish/studies/a.yaml"))).toBe(false);
  });

  it("refuses a destination directory replaced by a link after staging", async () => {
    const outside = await makeTestTempDir("humanish-migrate-outside-");
    try {
      await write("humanish/labs/a.yaml", v2("a"));
      const result = await migrateStudies({
        cwd,
        onPhase: (finished) => {
          if (finished !== "stage") return;
          // The staged directory moves outside, and a link to it takes its place, so the staged
          // copy is still found through the link.
          renameSync(path.join(cwd, "humanish/studies"), path.join(outside, "moved"));
          symlinkSync(path.join(outside, "moved"), path.join(cwd, "humanish/studies"));
        },
      });
      expect(result.error?.phase).toBe("commit");
      expect(await readFile(path.join(cwd, "humanish/labs/a.yaml"), "utf8")).toBe(v2("a"));
      expect(existsSync(path.join(outside, "moved", "a.yaml"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a name that appeared after the plan", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const result = await migrateStudies({
      cwd,
      onPlan: () => {
        mkdirSync(path.join(cwd, ".humanish/labs"), { recursive: true });
        writeFileSync(path.join(cwd, ".humanish/labs/a.yml"), v2("a-late"));
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.error?.message).toMatch(/\.humanish\/labs\/a\.yml appeared/);
    expect(existsSync(path.join(cwd, "humanish/studies/a.yaml"))).toBe(false);
  });

  it("keeps the source when the new file changed before clean-up", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const result = await migrateStudies({
      cwd,
      onPhase: (finished) => {
        if (finished === "commit") writeFileSync(path.join(cwd, "humanish/studies/a.yaml"), "");
      },
    });
    expect(result).toMatchObject({ ok: false, unresolved: ["humanish/labs/a.yaml"] });
    expect(await readFile(path.join(cwd, "humanish/labs/a.yaml"), "utf8")).toBe(v2("a"));
  });

  it("keeps a source edited after commit, and lists it", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const edited = `${v2("a")}# edited after commit\n`;
    const result = await migrateStudies({
      cwd,
      onPhase: (finished) => {
        if (finished === "commit") writeFileSync(path.join(cwd, "humanish/labs/a.yaml"), edited);
      },
    });
    expect(result).toMatchObject({ ok: false, unresolved: ["humanish/labs/a.yaml"] });
    expect(await readFile(path.join(cwd, "humanish/labs/a.yaml"), "utf8")).toBe(edited);
    expect(parse(await readFile(path.join(cwd, "humanish/studies/a.yaml"), "utf8")).schema).toBe(
      "humanish.study.v3",
    );
  });

  it("keeps the source when the new file is gone before clean-up", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const result = await migrateStudies({
      cwd,
      onPhase: (finished) => {
        if (finished === "commit") rmSync(path.join(cwd, "humanish/studies/a.yaml"));
      },
    });
    expect(result).toMatchObject({ ok: false, unresolved: ["humanish/labs/a.yaml"] });
    expect(await readFile(path.join(cwd, "humanish/labs/a.yaml"), "utf8")).toBe(v2("a"));
  });

  it("puts a rewritten source back when its new file vanished before the undo", async () => {
    await write("humanish/studies/a.yaml", v2("a"));
    await write("humanish/labs/b.yaml", v2("b"));
    let calls = 0;
    const result = await migrateStudies({
      cwd,
      // a.yaml is rewritten in place first; b.yaml's move then fails after a.yaml's v3 file is gone.
      link: async (from, to) => {
        calls += 1;
        if (calls !== 2) return link(from, to);
        rmSync(path.join(cwd, "humanish/studies/a.yaml"));
        throw Object.assign(new Error("i/o error"), { code: "EIO" });
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.error?.message).toMatch(/Every source is where it was\.$/);
    expect(await readFile(path.join(cwd, "humanish/studies/a.yaml"), "utf8")).toBe(v2("a"));
    expect(existsSync(path.join(cwd, "humanish/studies/a.yaml.v2.bak"))).toBe(false);
    expect(await readFile(path.join(cwd, "humanish/labs/b.yaml"), "utf8")).toBe(v2("b"));
  });

  it("keeps a backup when another file took the rewritten name before the undo", async () => {
    await write("humanish/studies/a.yaml", v2("a"));
    await write("humanish/labs/b.yaml", v2("b"));
    let calls = 0;
    const result = await migrateStudies({
      cwd,
      link: async (from, to) => {
        calls += 1;
        if (calls !== 2) return link(from, to);
        rmSync(path.join(cwd, "humanish/studies/a.yaml"));
        writeFileSync(path.join(cwd, "humanish/studies/a.yaml"), "someone else's\n");
        throw Object.assign(new Error("i/o error"), { code: "EIO" });
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.unresolved).toEqual([
      "humanish/studies/a.yaml",
      "humanish/studies/a.yaml.v2.bak",
    ]);
    expect(await readFile(path.join(cwd, "humanish/studies/a.yaml"), "utf8")).toBe(
      "someone else's\n",
    );
    expect(await readFile(path.join(cwd, "humanish/studies/a.yaml.v2.bak"), "utf8")).toBe(v2("a"));
  });
});

// Each case changes a file at the moment migrate commits it: after its last check, before its
// rename or link.
describe("changes during a commit", () => {
  it.each([
    ["that exists before the run", (bak: string) => writeFileSync(bak, "an older backup\n")],
    ["that appears during the rewrite", () => undefined],
  ])("leaves a <name>.v2.bak %s alone", async (name, before) => {
    await write("humanish/studies/a.yaml", v2("a"));
    const bak = path.join(cwd, "humanish/studies/a.yaml.v2.bak");
    before(bak);
    const result = await migrateStudies({
      cwd,
      onCommit: () => {
        if (name === "that appears during the rewrite") writeFileSync(bak, "an older backup\n");
      },
    });
    expect(result.ok).toBe(true);
    expect(await readFile(bak, "utf8")).toBe("an older backup\n");
    expect(Object.keys(await tree()).sort()).toEqual([
      "humanish/studies/a.yaml",
      "humanish/studies/a.yaml.v2.bak",
    ]);
  });

  it("keeps an edited source as <name>.v2.bak when, without hard links, its name was taken", async () => {
    await write("humanish/studies/a.yaml", v2("a"));
    const source = path.join(cwd, "humanish/studies/a.yaml");
    let calls = 0;
    const result = await migrateStudies({
      cwd,
      onCommit: () => writeFileSync(source, "edited\n"),
      // The first restore finds the name taken by another file the moment it tries.
      link: async (_from, to) => {
        calls += 1;
        if (calls === 1) writeFileSync(to, "competing\n");
        throw Object.assign(new Error("no hard links"), { code: "EPERM" });
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.unresolved).toEqual(["humanish/studies/a.yaml.v2.bak"]);
    expect(await readFile(source, "utf8")).toBe("competing\n");
    expect(await readFile(`${source}.v2.bak`, "utf8")).toBe("edited\n");
    expect(Object.keys(await tree()).sort()).toEqual([
      "humanish/studies/a.yaml",
      "humanish/studies/a.yaml.v2.bak",
    ]);
  });

  it.each([
    [
      "saved by a rename",
      (file: string) => {
        writeFileSync(`${file}.editor`, "edited\n");
        renameSync(`${file}.editor`, file);
      },
    ],
    ["written in place", (file: string) => writeFileSync(file, "edited\n")],
  ])("keeps a source %s before its rewrite, and writes no backup", async (_name, edit) => {
    await write("humanish/studies/a.yaml", v2("a"));
    const result = await migrateStudies({
      cwd,
      onCommit: () => edit(path.join(cwd, "humanish/studies/a.yaml")),
    });
    expect(result.error).toMatchObject({ code: "HUMANISH_MIGRATE_FAILED", phase: "commit" });
    expect(result.error?.message).toMatch(
      /humanish\/studies\/a\.yaml changed after it was planned/,
    );
    expect(await readFile(path.join(cwd, "humanish/studies/a.yaml"), "utf8")).toBe("edited\n");
    expect(Object.keys(await tree())).toEqual(["humanish/studies/a.yaml"]);
  });

  it("keeps a file that took the destination name on a filesystem without hard links", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const theirs = path.join(cwd, "humanish/studies/a.yaml");
    const result = await migrateStudies({
      cwd,
      onCommit: () => writeFileSync(theirs, "theirs\n"),
      link: async () => {
        throw Object.assign(new Error("no hard links"), { code: "EPERM" });
      },
    });
    expect(result.error?.message).toMatch(
      /^humanish\/studies\/a\.yaml appeared while humanish\/labs\/a\.yaml was migrated; both are kept\./,
    );
    expect(await readFile(theirs, "utf8")).toBe("theirs\n");
    expect(await readFile(path.join(cwd, "humanish/labs/a.yaml"), "utf8")).toBe(v2("a"));
  });

  it.skipIf(process.getuid?.() === 0)(
    "undoes every other commit when one undo fails, and lists the one it could not",
    async () => {
      await write("humanish/labs/a.yaml", v2("a"));
      await write(".humanish/labs/b.yaml", v2("b"));
      await write(".humanish/local/labs/c.yaml", v2("c"));
      const locked = path.join(cwd, ".humanish/studies");
      let calls = 0;
      try {
        const result = await migrateStudies({
          cwd,
          // a and b commit; c fails after b's directory turns read-only, so b's undo fails too.
          link: async (from, to) => {
            calls += 1;
            if (calls < 3) return link(from, to);
            chmodSync(locked, 0o555);
            throw Object.assign(new Error("i/o error"), { code: "EIO" });
          },
        });
        expect(result.error?.phase).toBe("commit");
        // b's new file and its temp file sit in the read-only directory, so both stay.
        expect(result.unresolved).toEqual([
          ".humanish/studies/b.yaml",
          expect.stringMatching(/^\.humanish\/studies\/\.b\.yaml\.migrate-[\w-]+\.tmp$/),
        ]);
        expect(existsSync(path.join(cwd, "humanish/studies/a.yaml"))).toBe(false);
        for (const source of [
          "humanish/labs/a.yaml",
          ".humanish/labs/b.yaml",
          ".humanish/local/labs/c.yaml",
        ])
          expect(existsSync(path.join(cwd, source))).toBe(true);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

// Pass four of the review: a name taken over between two steps of one file operation.
describe("a name taken over mid-operation", () => {
  it("keeps a temp file another file replaced after the link, and lists it", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    let calls = 0;
    const result = await migrateStudies({
      cwd,
      // The commit's link; any later one is a restore that should run as it is.
      link: async (from, to) => {
        calls += 1;
        await link(from, to);
        if (calls !== 1) return;
        writeFileSync(`${from}.other`, "other\n");
        renameSync(`${from}.other`, from);
      },
    });
    expect(result.error?.phase).toBe("clean-up");
    expect(result.unresolved).toEqual([
      expect.stringMatching(/^humanish\/studies\/\.a\.yaml\.migrate-[\w-]+\.tmp$/),
    ]);
    const temp = path.join(cwd, result.unresolved![0]!);
    expect(await readFile(temp, "utf8")).toBe("other\n");
    expect(parse(await readFile(path.join(cwd, "humanish/studies/a.yaml"), "utf8")).schema).toBe(
      "humanish.study.v3",
    );
    expect(existsSync(path.join(cwd, "humanish/labs/a.yaml"))).toBe(false);
  });

  it("keeps an original whose restored name was replaced right after the link", async () => {
    await write("humanish/studies/a.yaml", v2("a"));
    const source = path.join(cwd, "humanish/studies/a.yaml");
    let calls = 0;
    const result = await migrateStudies({
      cwd,
      onCommit: () => writeFileSync(source, "edited\n"),
      link: async (from, to) => {
        calls += 1;
        await link(from, to);
        if (calls !== 1) return;
        writeFileSync(`${to}.theirs`, "theirs\n");
        renameSync(`${to}.theirs`, to);
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.unresolved).toEqual(["humanish/studies/a.yaml.v2.bak"]);
    expect(await readFile(source, "utf8")).toBe("theirs\n");
    expect(await readFile(`${source}.v2.bak`, "utf8")).toBe("edited\n");
  });

  it("keeps a source swapped for a symbolic link, without hard links, and stops", async () => {
    await write("humanish/studies/a.yaml", v2("a"));
    await write("other.txt", "other\n");
    const source = path.join(cwd, "humanish/studies/a.yaml");
    const result = await migrateStudies({
      cwd,
      onCommit: () => {
        rmSync(source);
        symlinkSync(path.join(cwd, "other.txt"), source);
      },
      link: async () => {
        throw Object.assign(new Error("no hard links"), { code: "EPERM" });
      },
    });
    expect(result.error?.phase).toBe("commit");
    expect(result.unresolved).toHaveLength(1);
    const kept = path.join(cwd, result.unresolved![0]!);
    expect(lstatSync(kept).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("other\n");
    expect(readdirSync(path.join(cwd, "humanish/studies"))).toEqual([path.basename(kept)]);
  });
});

describe("writing", () => {
  it("reports every destination before any is written", async () => {
    await copyCommittedLabs();
    let planned: readonly string[] = [];
    let writtenAtPlan: string[] = [];
    const result = await migrateStudies({
      cwd,
      onPlan: (files) => {
        planned = files.map((file) => file.destination!);
        writtenAtPlan = planned.filter((destination) => existsSync(path.join(cwd, destination)));
      },
    });
    expect(result.ok).toBe(true);
    expect(planned).toHaveLength(21);
    expect(planned.every((destination) => destination.startsWith("humanish/studies/"))).toBe(true);
    expect(writtenAtPlan).toEqual([]);
    expect(Object.keys(await tree()).sort()).toEqual([...planned].sort());
  });

  it("writes nothing with --dry-run", async () => {
    await copyCommittedLabs();
    const before = await tree();
    const result = await migrateStudies({ cwd, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.files.filter((file) => file.action === "move")).toHaveLength(21);
    expect(await tree()).toEqual(before);
  });

  it("takes the files to convert as arguments", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    await write("humanish/labs/b.yaml", v2("b"));
    const stdout: string[] = [];
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stdout.push(text),
      setExitCode: () => undefined,
    });
    program.exitOverride();
    await program.parseAsync(
      ["node", "humanish", "migrate", "--cwd", cwd, "--dry-run", "humanish/labs/b.yaml"],
      { from: "node" },
    );
    const output = stdout.join("");
    expect(output).toContain("humanish/labs/b.yaml -> humanish/studies/b.yaml");
    expect(output).not.toContain("humanish/labs/a.yaml");
  });

  it("prints the plan to stderr before writing when --json keeps stdout for the result", async () => {
    await write("humanish/labs/a.yaml", v2("a"));
    const destination = path.join(cwd, "humanish/studies/a.yaml");
    const events: string[] = [];
    const written: boolean[] = [];
    const program = createProgram({
      writeOut: (text) => events.push(`out:${text}`),
      writeErr: (text) => {
        events.push(`err:${text}`);
        written.push(existsSync(destination));
      },
      setExitCode: () => undefined,
    });
    program.exitOverride();
    await program.parseAsync(["node", "humanish", "migrate", "--cwd", cwd, "--json"], {
      from: "node",
    });
    expect(events[0]).toBe(
      "err:humanish/labs/a.yaml -> humanish/studies/a.yaml (route: preview)\n  moved: actors[0] -> actor, actors[0].count -> participants\n",
    );
    expect(JSON.parse(events[1]!.slice("out:".length))).toMatchObject({ ok: true });
    // The plan printed while the destination did not exist yet, and the run then wrote it.
    expect(written).toEqual([false]);
    expect(existsSync(destination)).toBe(true);
  });

  it("prints each source, destination and dropped key before its summary line", async () => {
    await copyCommittedLabs();
    const stdout: string[] = [];
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stdout.push(text),
      setExitCode: () => undefined,
    });
    program.exitOverride();
    try {
      await program.parseAsync(["node", "humanish", "migrate", "--cwd", cwd], { from: "node" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
    }
    const output = stdout.join("");
    expect(output).toContain(
      "humanish/labs/first-contact.yaml -> humanish/studies/first-contact.yaml (route: terminal)",
    );
    expect(output).toContain(
      "  dropped execution.timeoutMs: 900000 (the terminal route never reads it)",
    );
    expect(output.indexOf("first-contact.yaml ->")).toBeLessThan(
      output.indexOf("Converted 21 study files."),
    );
  });
});

describe("every committed lab", () => {
  it("round-trips through migrate to a v3 study that parses and plans the same", async () => {
    const names = await copyCommittedLabs();
    expect(names).toHaveLength(21);
    const result = await migrateStudies({ cwd });
    expect(result.ok).toBe(true);
    for (const name of names) {
      const before = parseStudyDocument(
        parse(await readFile(path.join(ROOT, "tests/fixtures/labs-v2", name), "utf8")),
      );
      const after = parseStudy(
        parse(await readFile(path.join(cwd, "humanish/studies", name), "utf8")),
      );
      if (!before.ok || !after.ok) throw new Error(`${name} did not parse`);
      expect(after.config.schema, name).toBe("humanish.study.v3");
      for (const dryRun of [true, false]) {
        expect(plain(planStudy(after.config, { cwd: ROOT, dryRun })), name).toEqual(
          plain(planStudy(before.config, { cwd: ROOT, dryRun })),
        );
      }
    }
  });
});
