import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded, closeWhenOverdue } from "../../scripts/observer-proof-wait.mjs";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bounded", () => {
  it("fails a wait that never settles with the step and the bound in the message", async () => {
    const started = Date.now();
    await expect(
      bounded("phone: decode keyframe 2 of 4", new Promise(() => {}), 50),
    ).rejects.toThrow("phone: decode keyframe 2 of 4 did not finish within 50 ms");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("points the timeout's stack at the line that started the wait", async () => {
    const error = await bounded("decode", new Promise<never>(() => {}), 10).catch(
      (failure: Error) => failure,
    );
    expect(error.stack).toContain("observer-proof-wait.test.ts");
  });

  it("returns the value of a wait that settles inside the bound", async () => {
    await expect(bounded("read the slider", Promise.resolve("30000"), 50)).resolves.toBe("30000");
  });

  it("keeps the wait's own error when it fails inside the bound", async () => {
    await expect(
      bounded("decode", Promise.reject(new Error("The source image cannot be decoded.")), 50),
    ).rejects.toThrow("The source image cannot be decoded.");
  });
});

describe("closeWhenOverdue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the context of a case that runs past its deadline and says which case", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    let closed = 0;
    closeWhenOverdue({ close: async () => void closed++ }, "phone-reduced-motion", 20);
    await pause(60);
    expect(closed).toBe(1);
    expect(lines).toEqual([
      "phone-reduced-motion did not finish within 20 ms; closing its pages so the pending call fails\n",
    ]);
  });

  it("leaves a case alone that finishes before its deadline", async () => {
    let closed = 0;
    const release = closeWhenOverdue({ close: async () => void closed++ }, "desktop-motion", 20);
    release();
    await pause(60);
    expect(closed).toBe(0);
  });
});
