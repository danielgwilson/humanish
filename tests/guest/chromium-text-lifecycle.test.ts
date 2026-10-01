import type { CDPSession } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupPorts,
  deferred,
  fixture,
  inserts,
  prepared,
} from "../helpers/chromium-text-port.js";

afterEach(cleanupPorts);

// Characterization before the split of createGuestChromiumText: each case passes on the
// unchanged closure. Operation interrupts, deadlines, busy release and session teardown.
describe("owned Chromium text port interrupts", () => {
  it("returns one close promise and interrupts an in-flight call as executor_closed", async () => {
    const f = fixture(),
      waiting = deferred<void>();
    f.assertFocusedWindow.mockImplementationOnce(async () => waiting.promise);
    // oxlint-disable-next-line vitest/valid-expect -- awaited below, after the rejection is triggered
    const rejected = expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({
      code: "executor_closed",
      disposition: "not_dispatched",
    });
    const closing = f.port.close();
    expect(f.port.close()).toBe(closing);
    await rejected;
    await closing;
    waiting.resolve();
  });

  it("interrupts a pending owner check on a target event and aborts its signal", async () => {
    const f = fixture(),
      waiting = deferred<void>();
    let seen: AbortSignal | undefined;
    f.assertFocusedWindow.mockImplementationOnce(async (signal) => {
      seen = signal;
      return waiting.promise;
    });
    // oxlint-disable-next-line vitest/valid-expect -- awaited below, after the rejection is triggered
    const rejected = expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    f.pageEvents.emit("framenavigated");
    expect(seen!.aborted).toBe(true);
    await rejected;
    waiting.resolve();
  });

  it.each(["page", "context"])("a %s close event leaves the port closed", async (owner) => {
    const f = fixture();
    (owner === "page" ? f.pageEvents : f.contextEvents).emit("close");
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({
      code: "executor_closed",
      disposition: "not_dispatched",
    });
    expect(f.assertFocusedWindow).not.toHaveBeenCalled();
  });

  it("refuses calls after the port closed as executor_closed", async () => {
    const f = fixture();
    await f.port.close();
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({
      code: "executor_closed",
      disposition: "not_dispatched",
    });
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({
      code: "executor_closed",
      disposition: "not_dispatched",
    });
    expect(f.assertFocusedWindow).not.toHaveBeenCalled();
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it("sends nothing more after a target event between protocol steps", async () => {
    const f = fixture(),
      original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) => {
      if (method !== "Page.getFrameTree") return original(method, params);
      const frameTree = { frame: { id: "owned-frame" } };
      return {
        get frameTree() {
          f.pageEvents.emit("framenavigated");
          return frameTree;
        },
      };
    });
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    expect(f.send.mock.calls.map(([method]) => method)).toEqual(["Page.getFrameTree"]);
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("aborts the owner check's signal when its operation fails", async () => {
    const f = fixture(),
      original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) =>
      method === "Runtime.evaluate"
        ? { result: { type: "boolean", value: false } }
        : original(method, params),
    );
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({
      code: "action_rejected",
    });
    expect(f.assertFocusedWindow.mock.calls[0]![0].aborted).toBe(true);
  });

  it("leaves a finished operation's signal alone when later events arrive", async () => {
    const f = fixture();
    await f.port.assertReady(f.abort.signal);
    const [signal] = f.assertFocusedWindow.mock.calls[0]!;
    f.pageEvents.emit("framenavigated");
    f.abort.abort();
    await f.port.close();
    expect(signal.aborted).toBe(false);
  });

  it("clears every deadline timer once its operation settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.port.assertReady(f.abort.signal);
    const handle = await prepared(f);
    await handle.paste();
    await handle.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the interrupt's code when the interrupted call also fails", async () => {
    const f = fixture();
    f.assertFocusedWindow.mockImplementationOnce(async () => {
      f.abort.abort();
      throw new Error("synthetic focus failure");
    });
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({
      code: "cancelled",
      disposition: "not_dispatched",
    });
  });
});

describe("owned Chromium text port teardown", () => {
  it("releases busy when a handle closes, so the next preparation opens a new session", async () => {
    const f = fixture(),
      first = await prepared(f);
    await first.close();
    const second = await prepared(f, "y");
    await second.paste();
    expect(f.newCDPSession).toHaveBeenCalledTimes(2);
    expect(inserts(f)).toEqual([["Input.insertText", { text: "y" }]]);
  });

  it("refuses paste through a handle that was closed", async () => {
    const f = fixture(),
      handle = await prepared(f);
    await handle.close();
    await expect(handle.paste()).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
    expect(inserts(f)).toHaveLength(0);
  });

  it("detaches a session that arrives after the port closed", async () => {
    const f = fixture(),
      waiting = deferred<CDPSession>();
    f.newCDPSession.mockReturnValueOnce(waiting.promise);
    // oxlint-disable-next-line vitest/valid-expect -- awaited below, after the rejection is triggered
    const rejected = expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({
      code: "executor_closed",
      disposition: "not_dispatched",
    });
    await vi.waitFor(() => expect(f.newCDPSession).toHaveBeenCalledOnce());
    await f.port.close();
    await rejected;
    waiting.resolve(f.session);
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
    expect(inserts(f)).toHaveLength(0);
  });

  it("port close after a failed handle close does not report that failure again", async () => {
    const f = fixture(),
      handle = await prepared(f);
    f.detach.mockRejectedValueOnce(new Error("synthetic cleanup detail"));
    await expect(handle.close()).rejects.toMatchObject({
      code: "transport_failed",
      disposition: "not_dispatched",
    });
    await expect(f.port.close()).resolves.toBeUndefined();
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("port close detaches a session that arrived while its preparation was running", async () => {
    const f = fixture(),
      waiting = deferred<CDPSession>();
    f.newCDPSession.mockReturnValueOnce(waiting.promise);
    const preparing = f.port.prepareText("x", f.abort.signal);
    // oxlint-disable-next-line vitest/valid-expect -- awaited below, after the rejection is triggered
    const rejected = expect(preparing).rejects.toMatchObject({ code: "executor_closed" });
    while (f.newCDPSession.mock.calls.length === 0) await Promise.resolve();
    waiting.resolve(f.session);
    await Promise.resolve();
    await f.port.close();
    await rejected;
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("detaches the session when the frame-tree request fails", async () => {
    const f = fixture(),
      original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) => {
      if (method === "Page.getFrameTree") throw new Error("synthetic transport detail");
      return original(method, params);
    });
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({
      code: "transport_failed",
      disposition: "not_dispatched",
    });
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("closing a closed handle again leaves the next preparation busy", async () => {
    const f = fixture(),
      first = await prepared(f);
    await first.close();
    await prepared(f, "y");
    await first.close();
    await expect(f.port.prepareText("z", f.abort.signal)).rejects.toMatchObject({
      code: "executor_busy",
    });
  });
});
