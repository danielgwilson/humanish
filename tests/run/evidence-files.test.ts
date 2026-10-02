import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBoundedFileResult } from "../../src/run/evidence-files.js";
import {
  prepareSelectedOutputDirectory,
  type PreparedSelectedOutputDirectory,
} from "../../src/run/contained-output.js";

// Lets a test act between the reader's checks: the hook runs before the Nth lstat of `target`.
const lstatHook: {
  target?: string | undefined;
  call?: number;
  run?: () => Promise<void>;
} = {};
let lstatCalls = 0;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      if (lstatHook.target !== undefined && String(args[0]) === lstatHook.target) {
        lstatCalls += 1;
        if (lstatCalls === lstatHook.call) await lstatHook.run?.();
      }
      return actual.lstat(...args);
    }) as typeof actual.lstat,
  };
});

describe("bounded study file reads", () => {
  let base: string;
  let root: PreparedSelectedOutputDirectory;
  let file: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-study-files-"));
    const physical = await fs.realpath(base);
    await fs.mkdir(path.join(physical, "evidence"));
    root = await prepareSelectedOutputDirectory(path.dirname(physical), physical);
    file = path.join(physical, "evidence", "note.txt");
    await fs.writeFile(file, "retained evidence\n", { mode: 0o644 });
    lstatCalls = 0;
  });

  afterEach(async () => {
    lstatHook.target = undefined;
    await fs.rm(base, { recursive: true, force: true });
  });

  it("reads an unchanged file", async () => {
    lstatHook.target = file;
    const result = await readBoundedFileResult(root, "evidence/note.txt", 1024);
    expect(result.state).toBe("read");
    expect(lstatCalls).toBe(2);
  });

  it("refuses a file whose mode changed after it was read", async () => {
    // The second lstat of the file is the final recheck, after the read and its fstat.
    Object.assign(lstatHook, { target: file, call: 2, run: () => fs.chmod(file, 0o600) });
    const result = await readBoundedFileResult(root, "evidence/note.txt", 1024);
    expect(result.state).toBe("unavailable");
  });

  it("refuses an over-limit file whose mode changed before the limit recheck", async () => {
    Object.assign(lstatHook, { target: file, call: 2, run: () => fs.chmod(file, 0o600) });
    const result = await readBoundedFileResult(root, "evidence/note.txt", 4);
    expect(result.state).toBe("unavailable");
  });
});
