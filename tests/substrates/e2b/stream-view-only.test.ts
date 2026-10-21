import { describe, expect, it } from "vitest";
import { startDesktopStream } from "../../../src/substrates/e2b/desktop-browser.js";
import type { E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import { x11vncRemote } from "../../helpers/x11vnc-remote.js";

function desktop(options: { ignoresRemote?: boolean } = {}) {
  const calls: string[] = [];
  const x11vnc = x11vncRemote();
  const sandbox = {
    stream: {
      start: async (opts: { requireAuth?: boolean; windowId?: string }) => {
        calls.push(`stream.start ${opts.windowId ?? "desktop"}`);
      },
    },
    commands: {
      run: async (command: string) => {
        calls.push(command);
        if (options.ignoresRemote === true && command.endsWith("-R viewonly")) {
          return { exitCode: 0, stdout: "" };
        }
        return x11vnc(command) ?? { exitCode: 0, stdout: "" };
      },
    },
  } as unknown as E2BDesktopSandbox;
  return { sandbox, calls };
}

describe("startDesktopStream", () => {
  it("switches the started VNC server to view-only and confirms it", async () => {
    const { sandbox, calls } = desktop();
    await startDesktopStream(sandbox, "4194311", 5_000);
    expect(calls).toEqual([
      "stream.start 4194311",
      "x11vnc -display :0 -sync -R viewonly",
      "x11vnc -display :0 -Q viewonly",
    ]);
  });

  it("refuses a stream whose server is still interactive", async () => {
    const { sandbox } = desktop({ ignoresRemote: true });
    await expect(startDesktopStream(sandbox, undefined, 5_000)).rejects.toThrow(
      "the live stream could not be made view-only",
    );
  });
});
