import { describe, expect, it } from "vitest";

import type { E2BCommandResult } from "../../../src/substrates/e2b/sdk.js";
import {
  MODAL_STREAM_PORT,
  modalDesktopSurface,
  startModalDesktop,
} from "../../../src/substrates/modal/desktop.js";

// The expected commands are those of @e2b/desktop 2.4.0's Sandbox class, which the e2b-desktop
// modules were tuned against. Input commands are in tests/substrates/x11/desktop-contract.test.ts.

/** A command runner that records each command and answers from `answer`. */
function recorder(answer: (command: string) => E2BCommandResult | Error = () => ({ exitCode: 0 })) {
  const commands: string[] = [];
  const run = async (command: string): Promise<E2BCommandResult> => {
    commands.push(command);
    const result = answer(command);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, commands };
}

const exit = (code: number) =>
  Object.assign(new Error(`exit ${code}`), { name: "CommandExitError", exitCode: code });

const hosts = new Map([[MODAL_STREAM_PORT, "ta-01abc-6080.w.modal.host"]]);
const noFiles = async () => new Uint8Array();

describe("Modal desktop screenshots", () => {
  it("returns a screenshot's bytes and removes the file", async () => {
    const { run, commands } = recorder();
    const png = Uint8Array.from([137, 80, 78, 71]);
    const read: string[] = [];
    const desktop = modalDesktopSurface(
      run,
      async (path) => {
        read.push(path);
        return png;
      },
      hosts,
    );
    await expect(desktop.screenshot()).resolves.toEqual(png);
    expect(commands[0]).toMatch(/^scrot --pointer \/tmp\/screenshot-[0-9a-f]+\.png$/);
    expect(read).toEqual([commands[0]!.slice("scrot --pointer ".length)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands[1]).toBe(`rm -f ${read[0]}`);
  });
});

describe("Modal desktop stream", () => {
  it("serves noVNC on the stream port's tunnel, with a password when asked", async () => {
    const { run, commands } = recorder();
    const desktop = modalDesktopSurface(run, noFiles, hosts);
    await desktop.stream.start({ requireAuth: true });
    const key = desktop.stream.getAuthKey();
    const url = new URL(desktop.stream.getUrl({ authKey: key, viewOnly: true }));
    expect(url.origin + url.pathname).toBe("https://ta-01abc-6080.w.modal.host/vnc.html");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      autoconnect: "true",
      view_only: "true",
      resize: "scale",
      password: key,
    });
    expect(
      commands.some((command) => command.includes("x11vnc -bg") && command.includes("-usepw")),
    ).toBe(true);
  });

  it("refuses a port that has no tunnel", () => {
    const desktop = modalDesktopSurface(recorder().run, noFiles, hosts);
    expect(() => desktop.getHost!(3000)).toThrow("Port 3000 has no Modal tunnel");
  });
});

describe("starting a Modal desktop", () => {
  it("starts Xvfb at the requested size, then XFCE, waiting for each", async () => {
    const { run, commands } = recorder();
    await startModalDesktop(run, { resolution: [1440, 950], dpi: 96 });
    expect(commands[0]).toContain("Xvfb :0 -ac -screen 0 1440x950x24 -retro -dpi 96");
    expect(commands[1]).toBe("xdpyinfo -display :0 >/dev/null");
    expect(commands[2]).toContain("startxfce4");
    expect(commands[3]).toContain("pgrep -x xfce4-session");
  });

  it("fails when Xvfb never answers", async () => {
    const { run } = recorder((command) =>
      command.startsWith("xdpyinfo") ? exit(1) : { exitCode: 0 },
    );
    await expect(startModalDesktop(run, {})).rejects.toThrow("Could not start Xvfb");
  }, 15_000);
});
