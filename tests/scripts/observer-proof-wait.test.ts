import { describe, expect, it } from "vitest";
import { bounded } from "../../scripts/observer-proof-wait.mjs";

describe("bounded", () => {
  it("fails a wait that never settles with the step and the bound in the message", async () => {
    const started = Date.now();
    await expect(
      bounded("phone: decode keyframe 2 of 4", new Promise(() => {}), 50),
    ).rejects.toThrow("phone: decode keyframe 2 of 4 did not finish within 50 ms");
    expect(Date.now() - started).toBeLessThan(1000);
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
