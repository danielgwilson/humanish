import type { Duplex } from "node:stream";
import type { CuaExecutor } from "./computer-use.js";
import { attachBrowserControlDispatcher } from "./browser-control-dispatcher.js";
import { encodeGuestBootstrap, GuestBootstrapReader, GUEST_BOOTSTRAP_LIMITS } from "./guest-bootstrap.js";
import { CuaExecutorError } from "./cua-executor-error.js";

export interface GuestRuntimeDesktop { executor: CuaExecutor; close(): Promise<{ complete: boolean }> }
export interface GuestRuntimeOptions {
  transport: Duplex;
  revision: string;
  signal: AbortSignal;
  /** Fixed private supervision channel, not browser-control output. */
  marker(value: "A" | "R"): void;
  createDesktop(signal: AbortSignal, onTerminal: () => void): Promise<GuestRuntimeDesktop>;
}

/** One admitted desktop and one dispatcher. The owner retains physical teardown. */
export async function runGuestRuntime(options: GuestRuntimeOptions): Promise<{ close(): Promise<{ complete: boolean }>; closed: Promise<{ complete: boolean }> }> {
  const owner = new AbortController();
  const authority = AbortSignal.any([owner.signal, options.signal]);
  let desktop: GuestRuntimeDesktop | undefined;
  let dispatcher: ReturnType<typeof attachBrowserControlDispatcher> | undefined;
  let reader: GuestBootstrapReader | undefined;
  let closing: Promise<{ complete: boolean }> | undefined;
  let preparing: Promise<GuestRuntimeDesktop> | undefined;
  let resolveClosed!: (value: { complete: boolean }) => void;
  const closed = new Promise<{ complete: boolean }>(resolve => { resolveClosed = resolve; });
  const timer = setTimeout(() => { void close(); }, GUEST_BOOTSTRAP_LIMITS.readyMs);
  function terminal(): void { void close(); }
  function close(): Promise<{ complete: boolean }> {
    if (closing) return closing;
    // Assign before reader/dispatcher teardown can synchronously reenter.
    closing = Promise.resolve().then(async () => {
      reader?.close(); dispatcher?.close(); options.transport.destroy();
      let complete = true;
      let deadline: NodeJS.Timeout | undefined;
      const reclaim = async (): Promise<void> => {
        try {
          if (!desktop && preparing) desktop = await preparing;
          if (desktop) complete = (await desktop.close()).complete;
        } catch { complete = false; }
      };
      try {
        await Promise.race([reclaim(), new Promise<void>(resolve => { deadline = setTimeout(() => { complete = false; resolve(); }, 4000); })]);
      } finally {
        clearTimeout(deadline);
        options.signal.removeEventListener("abort", terminal);
        options.transport.off("end", terminal); options.transport.off("close", terminal);
        // Keep the finite error listener through native close; never surface text.
        if (options.transport.closed) options.transport.off("error", terminal);
        const result = { complete }; resolveClosed(result);
      }
      return { complete };
    });
    owner.abort(); clearTimeout(timer);
    return closing;
  }
  options.transport.on("error", terminal); options.transport.on("end", terminal); options.transport.on("close", terminal);
  options.signal.addEventListener("abort", terminal, { once: true });
  try {
    reader = new GuestBootstrapReader(options.transport, options.revision, authority, false, terminal);
    const identity = await reader.identity;
    if (authority.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
    options.marker("A");
    preparing = options.createDesktop(authority, terminal);
    desktop = await Promise.race([preparing, new Promise<never>((_, reject) => {
      const stop = (): void => reject(new CuaExecutorError("session_revoked", "not_dispatched"));
      authority.addEventListener("abort", stop, { once: true });
      void preparing!.finally(() => authority.removeEventListener("abort", stop)).catch(() => {});
      if (authority.aborted) stop();
    })]);
    if (authority.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
    reader.handoff();
    dispatcher = attachBrowserControlDispatcher({ transport: options.transport, identity, executor: desktop.executor,
      authoritySignal: authority, isAuthorized: () => !authority.aborted });
    // No await in this handoff: an immediate HELLO already has its sole receiver.
    options.transport.write(encodeGuestBootstrap(identity, true), error => { if (error) terminal(); });
    options.transport.resume();
    if (authority.aborted || options.transport.destroyed) throw new CuaExecutorError("session_revoked", "not_dispatched");
    options.marker("R"); clearTimeout(timer);
    return { close, closed };
  } catch (error) { await close(); throw error; }
}
