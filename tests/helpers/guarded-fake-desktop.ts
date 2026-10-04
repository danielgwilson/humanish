// A fake @e2b/desktop SDK behind the real desktop startup guard (guardDesktopSandboxCreate). Its
// create constructs a handle, so the guard reports the id, then waits in desktop startup until the
// test ends it. A kill by id during startup fails the startup the way the E2B SDK does when the
// connection to a killed sandbox ends, with an error that quotes the id. No provider wire format
// is modeled.

import { guardDesktopSandboxCreate, type E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

export interface GuardedFakeDesktop {
  module: E2BDesktopModule;
  /** Ids the SDK constructed a handle for, in order. */
  constructed: string[];
  /** Ids passed to Sandbox.kill, in order. */
  killed: string[];
  /** End the oldest startup still waiting: the create returns its handle. */
  finishStartup(): void;
  /** Fail the oldest startup still waiting with `error`. */
  failStartup(error: Error): void;
}

/** The startup error for a sandbox killed mid-startup, shaped like the E2B SDK's. */
export function connectionEnded(sandboxId: string): Error {
  return new Error(
    `[unavailable] the connection to sandbox ${sandboxId} ended before desktop startup finished`,
  );
}

export function guardedFakeDesktop(options: {
  /** The id each create's handle gets, in order. */
  ids: readonly string[];
  /** Called when a handle is constructed, after the guard has seen its id. */
  onConstructed?: (sandboxId: string) => void;
  /** Holds every list request open until it resolves. */
  listGate?: Promise<void>;
}): GuardedFakeDesktop {
  const constructed: string[] = [];
  const killed: string[] = [];
  const startups: Array<{ sandboxId: string; end: (error?: Error) => void }> = [];

  class FakeDesktop {
    readonly files = {};
    constructor(readonly sandboxId: string) {}

    /** The guard's cleanup after a failed startup; false is the SDK's exact-id 404. */
    async kill(): Promise<boolean> {
      return !killed.includes(this.sandboxId);
    }

    static async create(this: new (sandboxId: string) => FakeDesktop): Promise<FakeDesktop> {
      const sandboxId = options.ids[constructed.length];
      if (sandboxId === undefined) throw new Error("the fake has no id left for this create");
      const desktop = new this(sandboxId);
      constructed.push(sandboxId);
      options.onConstructed?.(sandboxId);
      await new Promise<void>((resolve, reject) => {
        startups.push({ sandboxId, end: (error) => (error ? reject(error) : resolve()) });
      });
      return desktop;
    }

    static async kill(sandboxId: string): Promise<boolean> {
      killed.push(sandboxId);
      const index = startups.findIndex((startup) => startup.sandboxId === sandboxId);
      if (index >= 0) startups.splice(index, 1)[0]?.end(connectionEnded(sandboxId));
      return true;
    }

    static list() {
      let read = false;
      return {
        get hasNext() {
          return !read;
        },
        nextItems: async () => {
          read = true;
          await options.listGate;
          return [];
        },
      };
    }
  }

  return {
    module: guardDesktopSandboxCreate({ Sandbox: FakeDesktop } as unknown as E2BDesktopModule),
    constructed,
    killed,
    finishStartup: () => startups.shift()?.end(),
    failStartup: (error) => startups.shift()?.end(error),
  };
}
