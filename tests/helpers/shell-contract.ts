import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";

import type { Shell } from "../../src/substrates/shell.js";

/** Whether `setsid` exists here; the E2B start command needs it on the machine that runs it. */
export const hasSetsid = ((): boolean => {
  try {
    execFileSync("bash", ["-c", "command -v setsid"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * What every Shell must do, as `it` cases. `open` returns a Shell on a machine (or a faithful
 * stand-in) and a scratch directory on it that the cases may write into.
 */
export function shellContract(
  open: () => { shell: Shell; dir: string },
  options: { start: boolean },
): void {
  it("returns a zero exit with stdout and stderr kept apart", async () => {
    const { shell } = open();
    await expect(shell.run("printf out; printf err >&2")).resolves.toEqual({
      exitCode: 0,
      stdout: "out",
      stderr: "err",
    });
  });

  it("returns a non-zero exit as a result with its output", async () => {
    const { shell } = open();
    await expect(shell.run("printf partial; printf boom >&2; exit 3")).resolves.toEqual({
      exitCode: 3,
      stdout: "partial",
      stderr: "boom",
    });
  });

  it("creates and replaces a text file", async () => {
    const { shell, dir } = open();
    await shell.writeFile(`${dir}/note.txt`, "first");
    await shell.writeFile(`${dir}/note.txt`, "second line\nwith 'quotes'");
    await expect(shell.run(`cat ${dir}/note.txt`)).resolves.toMatchObject({
      exitCode: 0,
      stdout: "second line\nwith 'quotes'",
    });
  });

  it("writes binary data byte for byte", async () => {
    const { shell, dir } = open();
    const bytes = Uint8Array.from([0, 1, 127, 128, 255, 10, 13]);
    await shell.writeFile(`${dir}/blob.bin`, bytes.buffer);
    await expect(
      shell.run(`od -An -tu1 -v ${dir}/blob.bin | tr -s ' ' | xargs`),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "0 1 127 128 255 10 13\n" });
  });

  it.skipIf(!options.start)(
    "starts a command and returns before it finishes, leaving it running",
    async () => {
      const { shell, dir } = open();
      const marker = `${dir}/started.txt`;
      const launched = await shell.start(`bash -c 'sleep 1; echo done > ${marker}'`);
      expect(launched.exitCode).toBe(0);
      await expect(shell.run(`test -e ${marker}`)).resolves.toMatchObject({ exitCode: 1 });
      await vi.waitFor(
        async () => {
          await expect(shell.run(`cat ${marker}`)).resolves.toMatchObject({ stdout: "done\n" });
        },
        { timeout: 5000, interval: 100 },
      );
    },
  );
}
