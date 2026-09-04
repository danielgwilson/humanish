import { describe, expect, it } from "vitest";
import {
  createDesktopSandbox,
  isTransientE2BError,
  TRANSIENT_RETRY_DELAY_MS,
  withOneRetryOnTransientE2BError,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "../src/e2b-desktop-launch.js";

// The three shapes measured on 2026-09-04 (five of six lanes created within 100 s), plus the
// transport resets the SDK surfaces the same way.
const TRANSIENT = [
  "12: [unimplemented] HTTP 404",
  "Cannot read properties of undefined (reading 'envdVersion')",
  "subject-upload failed: Expected to receive information about written file",
  "Response data is missing",
  "TypeError: fetch failed",
  "read ECONNRESET",
  "socket hang up",
  "14: [unavailable] HTTP 503"
];
const NOT_TRANSIENT = [
  "Sandbox create timed out after 64000 ms",
  "TimeoutError: deadline exceeded",
  "401 Unauthorized: invalid API key",
  "403 Forbidden",
  "429 Too Many Requests: rate limit exceeded",
  "InvalidArgumentError: timeoutMs must be positive",
  "SandboxNotFoundError: sandbox abc not found"
];

describe("isTransientE2BError: the provider errors worth one retry", () => {
  it.each(TRANSIENT)("retries %s", (message) => {
    expect(isTransientE2BError(new Error(message))).toBe(true);
  });
  it.each(NOT_TRANSIENT)("does not retry %s", (message) => {
    expect(isTransientE2BError(new Error(message))).toBe(false);
  });
  it("a timeout that also mentions a 404 is still a timeout: the budget is spent", () => {
    expect(isTransientE2BError(new Error("request timed out after HTTP 404"))).toBe(false);
  });
  it("a non-Error throw is judged by its text", () => {
    expect(isTransientE2BError("12: [unimplemented] HTTP 404")).toBe(true);
    expect(isTransientE2BError(undefined)).toBe(false);
  });
});

describe("withOneRetryOnTransientE2BError", () => {
  it("a transient first failure is reported, waited out with the injected sleep, and retried once", async () => {
    let calls = 0;
    const reasons: string[] = [];
    const slept: number[] = [];
    const value = await withOneRetryOnTransientE2BError(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("12: [unimplemented] HTTP 404");
        return "sandbox";
      },
      { onRetry: (reason) => reasons.push(reason), sleep: async (ms) => { slept.push(ms); } }
    );
    expect(value).toBe("sandbox");
    expect(calls).toBe(2);
    expect(reasons).toEqual(["12: [unimplemented] HTTP 404"]);
    expect(slept).toEqual([TRANSIENT_RETRY_DELAY_MS]);
  });

  it("a second transient failure propagates: one retry, never a loop", async () => {
    let calls = 0;
    await expect(
      withOneRetryOnTransientE2BError(
        async () => {
          calls += 1;
          throw new Error("12: [unimplemented] HTTP 404");
        },
        { sleep: async () => undefined }
      )
    ).rejects.toThrow("[unimplemented] HTTP 404");
    expect(calls).toBe(2);
  });

  it("a non-transient failure is not retried and onRetry never fires", async () => {
    let calls = 0;
    const reasons: string[] = [];
    await expect(
      withOneRetryOnTransientE2BError(
        async () => {
          calls += 1;
          throw new Error("401 Unauthorized");
        },
        { onRetry: (reason) => reasons.push(reason), sleep: async () => undefined }
      )
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
    expect(reasons).toEqual([]);
  });
});

describe("createDesktopSandbox: the one seam every desktop route calls", () => {
  function moduleFailingOnce(message: string): { module: E2BDesktopModule; created: unknown[][] } {
    const created: unknown[][] = [];
    let calls = 0;
    const module = {
      Sandbox: {
        create: async (...args: unknown[]) => {
          created.push(args);
          calls += 1;
          if (calls === 1) throw new Error(message);
          return { sandboxId: `sbx-${calls}` } as unknown as E2BDesktopSandbox;
        }
      }
    } as unknown as E2BDesktopModule;
    return { module, created };
  }

  it("retries a create whose first attempt hit an envd that was not routable yet, with the same options and template", async () => {
    const { module, created } = moduleFailingOnce("12: [unimplemented] HTTP 404");
    const reasons: string[] = [];
    const options = { apiKey: "k", timeoutMs: 1_000 } as Parameters<typeof createDesktopSandbox>[1];
    const sandbox = await createDesktopSandbox(module, options, "custom-image", { onRetry: (reason) => reasons.push(reason), sleep: async () => undefined });
    expect(sandbox.sandboxId).toBe("sbx-2");
    expect(created).toEqual([["custom-image", options], ["custom-image", options]]);
    expect(reasons).toEqual(["12: [unimplemented] HTTP 404"]);
  });

  it("the default-template call stays byte-stable: options as the sole argument, on both attempts", async () => {
    const { module, created } = moduleFailingOnce("Cannot read properties of undefined (reading 'envdVersion')");
    const options = { apiKey: "k" } as Parameters<typeof createDesktopSandbox>[1];
    await createDesktopSandbox(module, options, undefined, { sleep: async () => undefined });
    expect(created).toEqual([[options], [options]]);
  });

  it("an auth failure is not retried", async () => {
    const { module, created } = moduleFailingOnce("401 Unauthorized");
    await expect(createDesktopSandbox(module, { apiKey: "k" } as Parameters<typeof createDesktopSandbox>[1], undefined, { sleep: async () => undefined })).rejects.toThrow("401");
    expect(created).toHaveLength(1);
  });
});
