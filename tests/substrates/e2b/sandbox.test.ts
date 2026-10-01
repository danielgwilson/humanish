import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReceiptsModule from "../../../src/run/sandbox-receipts.js";
import {
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "../../../src/run/sandbox-receipts.js";
import {
  prepareSelectedOutputDirectory,
  type PreparedOutputRoot,
} from "../../../src/run/contained-output.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../../src/substrates/e2b/sdk.js";
import {
  acquireE2BDesktopSandbox,
  acquireE2BShellSandbox,
  destroyE2BSandbox,
  readE2BRelease,
} from "../../../src/substrates/e2b/sandbox.js";

// A receipt write can be held open so a test can observe what the caller sees meanwhile.
const receiptGate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock("../../../src/run/sandbox-receipts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ReceiptsModule>();
  return {
    ...actual,
    appendSandboxReceipt: async (...args: Parameters<typeof actual.appendSandboxReceipt>) => {
      await receiptGate.hold;
      return actual.appendSandboxReceipt(...args);
    },
  };
});

// Allocation tests need only the SDK's identity and existing create/kill contract.
// No HTTP fixture or new provider wire protocol is modeled here.
function fixture(result: boolean = true) {
  const desktop = { sandboxId: "owned-desktop" } as E2BDesktopSandbox;
  const create = vi.fn(async (..._args: unknown[]) => desktop);
  const kill = vi.fn(async (_id: string, _options?: { requestTimeoutMs?: number }) => result);
  const list = vi.fn(() => {
    throw new Error("must not enumerate");
  });
  const module = { Sandbox: { create, kill, list } } as unknown as E2BDesktopModule;
  return { desktop, module, create, kill, list };
}

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
      },
    },
  } as unknown as E2BDesktopModule;
  return { module, created };
}

const acquire = (module: E2BDesktopModule, options: E2BDesktopCreateOptions, template?: string) =>
  acquireE2BDesktopSandbox({ module, options, template, receipt: null });

const THROWN_KILL_MESSAGES = [
  "sandbox not found",
  "500: team not found",
  "NOTFOUND",
  "getaddrinfo ENOTFOUND api.e2b.app",
  "sandbox does not exist yet",
  "404",
  "500: internal error (trace 7c404ab1)",
  "sandbox sbx-404abc unreachable",
  "SandboxNotFoundError: sandbox sb-1 does not exist",
];
/** The SDK's own not-found error, recognized by type (its name), not by its message. */
const sandboxNotFound = (): Error =>
  Object.assign(new Error("sandbox is gone"), { name: "SandboxNotFoundError" });

describe("E2B sandbox acquisition", () => {
  it("preserves default and template creation arguments", async () => {
    const f = fixture();
    const options = {
      apiKey: "synthetic",
      timeoutMs: 1000,
      lifecycle: { onTimeout: "kill" as const },
    };
    const first = await acquire(f.module, options);
    expect(f.create).toHaveBeenLastCalledWith(options);
    await first.allocation.close();
    const second = await acquire(f.module, options, "custom-desktop");
    expect(f.create).toHaveBeenLastCalledWith("custom-desktop", options);
    await second.allocation.close();
    await acquireE2BShellSandbox({ module: f.module, options, receipt: null });
    expect(f.create).toHaveBeenLastCalledWith(options);
  });

  it("captures identity and release authority before mutable provisioning hooks", async () => {
    const f = fixture();
    const replacement = vi.fn(async () => true);
    const acquired = await acquire(f.module, { apiKey: "synthetic" });
    f.desktop.sandboxId = "unrelated-desktop";
    f.module.Sandbox.kill = replacement;
    expect(acquired.allocation.resourceId).toBe("owned-desktop");
    expect(await acquired.allocation.close()).toEqual({ status: "released", reason: "terminated" });
    expect(f.kill).toHaveBeenCalledWith("owned-desktop", { requestTimeoutMs: 60_000 });
    expect(replacement).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("treats the SDK false/404 result as already gone", async () => {
    const f = fixture(false);
    const { allocation } = await acquire(f.module, { apiKey: "synthetic" });
    expect(await allocation.close()).toEqual({ status: "released", reason: "already_gone" });
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(THROWN_KILL_MESSAGES)(
    "reads a thrown kill as unconfirmed whatever it says: %j",
    async (message) => {
      const f = fixture();
      f.kill.mockRejectedValue(new Error(message));
      expect(
        await (await acquire(f.module, { apiKey: "synthetic" })).allocation.close(),
      ).toMatchObject({ status: "unconfirmed", reason: "release_failed" });
    },
  );

  it("reads the SDK's typed not-found error as already gone", async () => {
    const f = fixture();
    f.kill.mockRejectedValue(sandboxNotFound());
    expect(await (await acquire(f.module, { apiKey: "synthetic" })).allocation.close()).toEqual({
      status: "released",
      reason: "already_gone",
    });
  });

  it("does not claim release for absent methods, malformed results or exceptions", async () => {
    const missing = fixture();
    delete missing.module.Sandbox.kill;
    expect(
      await (await acquire(missing.module, { apiKey: "synthetic" })).allocation.close(),
    ).toEqual({ status: "unconfirmed", reason: "release_unavailable" });
    const malformed = fixture();
    malformed.module.Sandbox.kill = "unsupported" as unknown as NonNullable<
      E2BDesktopModule["Sandbox"]["kill"]
    >;
    const acquired = await acquire(malformed.module, { apiKey: "synthetic" });
    expect(acquired.allocation.resourceId).toBe("owned-desktop");
    expect(await acquired.allocation.close()).toEqual({
      status: "unconfirmed",
      reason: "release_unavailable",
    });
    const invalid = fixture();
    invalid.kill.mockResolvedValue(undefined as unknown as boolean);
    expect(
      await (await acquire(invalid.module, { apiKey: "synthetic" })).allocation.close(),
    ).toEqual({ status: "unconfirmed", reason: "invalid_result" });
    const failed = fixture();
    failed.kill.mockRejectedValue(new Error("unreachable"));
    expect(
      await (await acquire(failed.module, { apiKey: "synthetic" })).allocation.close(),
    ).toMatchObject({ status: "unconfirmed", reason: "release_failed" });
    expect(failed.list).not.toHaveBeenCalled();
  });

  it("does not invent cleanup authority when creation never returns a handle", async () => {
    const f = fixture();
    f.create.mockRejectedValue(new Error("unauthorized"));
    await expect(acquire(f.module, { apiKey: "synthetic" })).rejects.toThrow("unauthorized");
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("retries a create whose first attempt hit an envd that was not routable yet, with the same options and template", async () => {
    const { module, created } = moduleFailingOnce("12: [unimplemented] HTTP 404");
    const reasons: string[] = [];
    const options = { apiKey: "k", timeoutMs: 1_000 };
    const { sandbox } = await acquireE2BDesktopSandbox({
      module,
      options,
      template: "custom-image",
      retry: { onRetry: (reason) => reasons.push(reason), sleep: async () => undefined },
      receipt: null,
    });
    expect(sandbox.sandboxId).toBe("sbx-2");
    expect(created).toEqual([
      ["custom-image", options],
      ["custom-image", options],
    ]);
    expect(reasons).toEqual(["12: [unimplemented] HTTP 404"]);
  });

  it("the default-template call stays byte-stable: options as the sole argument, on both attempts", async () => {
    const { module, created } = moduleFailingOnce(
      "Cannot read properties of undefined (reading 'envdVersion')",
    );
    const options = { apiKey: "k" };
    await acquireE2BShellSandbox({
      module,
      options,
      retry: { sleep: async () => undefined },
      receipt: null,
    });
    expect(created).toEqual([[options], [options]]);
  });

  it("does not retry a non-transient failure", async () => {
    const { module, created } = moduleFailingOnce("401 Unauthorized");
    const onRetry = vi.fn();
    await expect(
      acquireE2BDesktopSandbox({
        module,
        options: { apiKey: "k" },
        retry: { onRetry, sleep: async () => undefined },
        receipt: null,
      }),
    ).rejects.toThrow("401");
    expect(created).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("E2B sandbox receipts", () => {
  let cwd: string;
  let root: PreparedOutputRoot;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-sandbox-"));
    root = await prepareSelectedOutputDirectory(cwd, "run");
  });
  afterEach(async () => {
    receiptGate.hold = undefined;
    await rm(cwd, { recursive: true, force: true });
  });

  const receipts = async () =>
    parseSandboxReceipts(await readFile(path.join(cwd, "run", SANDBOX_RECEIPTS_ARTIFACT), "utf8"));

  it("writes a provider-qualified receipt before the handle reaches the caller", async () => {
    const f = fixture();
    let release!: () => void;
    receiptGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let returned = false;
    const pending = acquireE2BDesktopSandbox({
      module: f.module,
      options: { apiKey: "synthetic", timeoutMs: 90_000 },
      receipt: { root, participantId: "lane-01", now: () => Date.UTC(2026, 8, 30) },
    }).then((acquired) => {
      returned = true;
      return acquired;
    });
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    release();
    const acquired = await pending;
    expect(acquired.sandbox).toBe(f.desktop);
    const raw = await readFile(path.join(cwd, "run", SANDBOX_RECEIPTS_ARTIFACT), "utf8");
    expect(JSON.parse(raw.trim())).toEqual({
      at: "2026-09-30T00:00:00.000Z",
      laneId: "lane-01",
      provider: "e2b",
      sandboxId: "owned-desktop",
      timeoutMs: 90_000,
    });
  });

  it("records the id captured at create, whatever the handle says later", async () => {
    const f = fixture();
    const acquired = await acquireE2BShellSandbox({
      module: f.module,
      options: { apiKey: "synthetic" },
      receipt: { root, participantId: "terminal" },
    });
    f.desktop.sandboxId = "unrelated-desktop";
    expect(acquired.allocation.resourceId).toBe("owned-desktop");
    expect(await receipts()).toEqual([
      expect.objectContaining({ laneId: "terminal", provider: "e2b", sandboxId: "owned-desktop" }),
    ]);
  });

  it.each([
    [
      "desktop",
      "a throwing clock",
      acquireE2BDesktopSandbox,
      () => {
        throw new Error("synthetic clock failure");
      },
    ],
    ["shell", "an invalid clock", acquireE2BShellSandbox, () => Number.NaN],
  ])(
    "releases the %s sandbox when %s fails the receipt after create",
    async (_kind, _clock, acquireSandbox, now) => {
      const f = fixture();
      const error = await acquireSandbox({
        module: f.module,
        options: { apiKey: "synthetic" },
        receipt: { root, participantId: "lane-01", now },
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.kill).toHaveBeenCalledExactlyOnceWith("owned-desktop", { requestTimeoutMs: 60_000 });
      expect(f.list).not.toHaveBeenCalled();
    },
  );

  it("still returns the handle when the receipt cannot be written", async () => {
    await mkdir(path.join(cwd, "run", SANDBOX_RECEIPTS_ARTIFACT));
    const f = fixture();
    const acquired = await acquireE2BDesktopSandbox({
      module: f.module,
      options: { apiKey: "synthetic" },
      receipt: { root, participantId: "lane-01" },
    });
    expect(acquired.sandbox).toBe(f.desktop);
    expect(acquired.allocation.resourceId).toBe("owned-desktop");
  });
});

describe("destroyE2BSandbox", () => {
  const destroy = (kill: E2BDesktopModule["Sandbox"]["kill"]) => {
    const module = {
      Sandbox: {
        create: vi.fn(),
        ...(kill === undefined ? {} : { kill }),
        list: () => {
          throw new Error("must not enumerate");
        },
      },
    } as unknown as E2BDesktopModule;
    return destroyE2BSandbox(module, "sb-1", { requestTimeoutMs: 5_000 });
  };

  it.each(THROWN_KILL_MESSAGES)(
    "records a thrown kill as kill-failed for reclaim: %j",
    async (message) => {
      expect(
        await destroy(async () => {
          throw new Error(message);
        }),
      ).toEqual({ state: "kill-failed", detail: message });
    },
  );

  it("maps each kill result to the reclaim outcome", async () => {
    const kill = vi.fn(async () => true);
    expect(await destroy(kill)).toEqual({ state: "killed" });
    expect(kill).toHaveBeenCalledWith("sb-1", { requestTimeoutMs: 5_000 });
    expect(await destroy(async () => false)).toEqual({ state: "already-gone" });
    expect(
      await destroy(async () => {
        throw sandboxNotFound();
      }),
    ).toEqual({ state: "already-gone" });
    expect(
      await destroy(async () => {
        throw new Error("provider exploded");
      }),
    ).toEqual({ state: "kill-failed", detail: "provider exploded" });
    expect(await destroy(undefined)).toMatchObject({
      state: "kill-failed",
      detail: expect.stringContaining("does not expose Sandbox.kill"),
    });
  });
});

describe("readE2BRelease", () => {
  const scrub = (text: string) => text.replace("secret-value", "[redacted]");
  it.each([
    [{ status: "released", reason: "terminated" }, true, undefined],
    [
      { status: "released", reason: "already_gone" },
      true,
      "Subject sandbox was already absent when cleanup ran; its exact termination time is unknown. Desktop cost uses the observed acquisition-to-cleanup span.",
    ],
    [
      { status: "unconfirmed", reason: "release_unavailable" },
      false,
      "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.",
    ],
    [
      {
        status: "unconfirmed",
        reason: "release_failed",
        error: new Error("kill refused: secret-value"),
      },
      false,
      "Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): kill refused: [redacted]",
    ],
    [
      { status: "unconfirmed", reason: "invalid_result" },
      false,
      "Subject sandbox teardown returned an unexpected result; release is unconfirmed and server-side kill-on-timeout remains the backstop.",
    ],
    [{ status: "retained", reason: "debug" }, false, undefined],
  ] as const)("reads %o", (result, released, warning) => {
    expect(readE2BRelease(result, { label: "Subject sandbox", scrub, costSpan: true })).toEqual(
      warning === undefined ? { released } : { released, warning },
    );
  });

  it("omits the cost note when the route prices no desktop time", () => {
    expect(
      readE2BRelease({ status: "released", reason: "already_gone" }, { label: "Sandbox", scrub }),
    ).toEqual({
      released: true,
      warning:
        "Sandbox was already absent when cleanup ran; its exact termination time is unknown.",
    });
  });
});
