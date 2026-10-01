import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { navigateGuestInitialPage } from "../src/guest-runtime-desktop.js";

function fixture() {
  const dispose = vi.fn(async () => {});
  const goto = vi.fn(async () => null);
  const waitForFunction = vi.fn(async () => ({ dispose }));
  return {
    goto,
    waitForFunction,
    dispose,
    page: { goto, waitForFunction } as unknown as Pick<Page, "goto" | "waitForFunction">,
  };
}

describe("initial guest document navigation", () => {
  it("awaits the document and a paint without waiting for load or app data", async () => {
    const f = fixture();
    let finish!: () => void;
    f.goto.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const pending = navigateGuestInitialPage(
      f.page,
      "http://127.0.0.1:3000/notes",
      new AbortController().signal,
    );
    expect(f.goto).toHaveBeenCalledWith("http://127.0.0.1:3000/notes", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(f.waitForFunction).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(f.waitForFunction).toHaveBeenCalledWith(expect.any(String), undefined, {
      timeout: 5000,
    });
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  // Playwright evaluates a string predicate as an expression, never calls it, and resolves once
  // the value is truthy. The paint wait's value must be a promise that settles only after two
  // animation frames, so a page that never paints times out instead of resolving at once.
  it("waits for two animation frames, not a function source that resolves at once", async () => {
    const f = fixture();
    await navigateGuestInitialPage(f.page, "http://127.0.0.1:3000/", new AbortController().signal);
    // The fixture's mock declares no parameters; the route passed the predicate first.
    const [expression] = f.waitForFunction.mock.calls[0] as unknown as [string];
    const frames: Array<() => void> = [];
    const value = runInNewContext(expression, {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
    }) as unknown;
    expect(typeof value).not.toBe("function");
    const painted = vi.fn();
    void (value as PromiseLike<unknown>).then(painted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(painted).not.toHaveBeenCalled();
    frames.shift()!();
    frames.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(painted).toHaveBeenCalledWith(true);
  });
  it.each(["document", "paint"])(
    "does not swallow a %s timeout or retry navigation",
    async (phase) => {
      const f = fixture(),
        error = new Error("Synthetic deadline");
      if (phase === "document") f.goto.mockRejectedValueOnce(error);
      else f.waitForFunction.mockRejectedValueOnce(error);
      await expect(
        navigateGuestInitialPage(f.page, "https://localhost:3000/", new AbortController().signal),
      ).rejects.toBe(error);
      expect(f.goto).toHaveBeenCalledOnce();
      if (phase === "document") expect(f.waitForFunction).not.toHaveBeenCalled();
    },
  );
  it("rejects unsupported entry URLs before browser I/O", async () => {
    const f = fixture();
    await expect(
      navigateGuestInitialPage(f.page, "http://example.com:3000/", new AbortController().signal),
    ).rejects.toBeDefined();
    expect(f.goto).not.toHaveBeenCalled();
  });
  it("rejects cancellation before and after navigation; the owner closes the browser", async () => {
    const f = fixture(),
      owner = new AbortController();
    f.goto.mockImplementationOnce(async () => {
      owner.abort();
      return null;
    });
    await expect(
      navigateGuestInitialPage(f.page, "http://localhost:3000/", owner.signal),
    ).rejects.toBeDefined();
    expect(f.waitForFunction).not.toHaveBeenCalled();
    await expect(
      navigateGuestInitialPage(f.page, "http://localhost:3000/", owner.signal),
    ).rejects.toBeDefined();
    expect(f.goto).toHaveBeenCalledOnce();
  });
});
