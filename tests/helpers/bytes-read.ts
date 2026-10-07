// How much a piece of work read from files: every FileHandle read in this process, while it ran.
import { open, type FileHandle } from "node:fs/promises";
import { vi } from "vitest";

/** Bytes every file handle in this process returned while `action` ran. */
export async function bytesReadDuring(action: () => Promise<unknown>): Promise<number> {
  const probe = await open(import.meta.filename, "r");
  const handle = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const readFileSpy = vi.spyOn(handle, "readFile");
  const readSpy = vi.spyOn(handle, "read");
  try {
    await action();
    let total = 0;
    for (const result of readFileSpy.mock.results)
      total += ((await result.value) as Buffer | string).length;
    for (const result of readSpy.mock.results)
      total += ((await result.value) as { bytesRead: number }).bytesRead;
    return total;
  } finally {
    readFileSpy.mockRestore();
    readSpy.mockRestore();
  }
}
