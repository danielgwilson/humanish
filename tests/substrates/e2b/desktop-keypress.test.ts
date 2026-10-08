// How the E2B executor presses keys: it translates the participant's key names through the table
// the guest desktop uses and runs the chord with xdotool on the desktop. The desktop's xdotool
// prints "No such key name ... Ignoring it." and exits 0 for a name it does not know, so that
// warning has to fail the action.

import { describe, expect, it } from "vitest";

import { isCommandExitError } from "../../../src/substrates/command-failure.js";
import {
  createE2BDesktopExecutor,
  type E2BDesktopLike,
} from "../../../src/substrates/e2b/desktop-executor.js";

type CommandResult = { exitCode?: number; stderr?: string; stdout?: string };

/** A fake desktop that records each command and answers it with `answer`. */
function keyDesktop(answer: (command: string) => CommandResult = () => ({ exitCode: 0 })) {
  const commands: string[] = [];
  const otherCalls: string[] = [];
  const other = (name: string) => (): void => {
    otherCalls.push(name);
  };
  const desktop: E2BDesktopLike = {
    screenshot: () => new Uint8Array(),
    leftClick: other("leftClick"),
    rightClick: other("rightClick"),
    middleClick: other("middleClick"),
    doubleClick: other("doubleClick"),
    moveMouse: other("moveMouse"),
    scroll: other("scroll"),
    write: other("write"),
    drag: other("drag"),
    wait: other("wait"),
    commands: {
      run: async (command) => {
        commands.push(command);
        return answer(command);
      },
    },
  };
  return { desktop, commands, otherCalls, executor: createE2BDesktopExecutor(desktop) };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the keypress to fail");
}

describe("createE2BDesktopExecutor keypress", () => {
  it.each([
    [["ARROWDOWN"], "xdotool key --clearmodifiers Down"],
    [["?"], "xdotool key --clearmodifiers question"],
    [["SHIFT", "/"], "xdotool key --clearmodifiers shift+slash"],
    [["CTRL", "a"], "xdotool key --clearmodifiers ctrl+a"],
    [["J"], "xdotool key --clearmodifiers j"],
    [["ESC"], "xdotool key --clearmodifiers Escape"],
    [["ENTER"], "xdotool key --clearmodifiers Return"],
  ])("sends %j as one translated xdotool chord", async (keys, command) => {
    const f = keyDesktop();
    await f.executor.execute({ kind: "keypress", keys });
    expect(f.commands).toEqual([command]);
    expect(f.otherCalls).toEqual([]);
  });

  it.each([
    ["an unknown name", ["ARROW_DOWN"]],
    ["command syntax", ["a; reboot"]],
    ["a repeated key", ["CTRL", "CONTROL", "a"]],
  ])("refuses %s before anything reaches the desktop", async (_label, keys) => {
    const f = keyDesktop();
    await expect(f.executor.execute({ kind: "keypress", keys })).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
    expect(f.commands).toEqual([]);
  });

  it("refuses a keypress on a desktop with no command channel", async () => {
    const f = keyDesktop();
    delete f.desktop.commands;
    await expect(f.executor.execute({ kind: "keypress", keys: ["ENTER"] })).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
  });

  it("fails the action when xdotool ignores a key name and still exits 0", async () => {
    const warning = "(symbol) No such key name 'Next'. Ignoring it.\n";
    const f = keyDesktop(() => ({ exitCode: 0, stdout: "", stderr: warning }));
    const error = await failure(f.executor.execute({ kind: "keypress", keys: ["PAGEDOWN"] }));
    expect(isCommandExitError(error)).toBe(true);
    expect(error).toMatchObject({ exitCode: 0, stderr: warning });
  });

  it("fails the action when the key command exits non-zero", async () => {
    const f = keyDesktop(() => ({ exitCode: 1, stdout: "", stderr: "Can't open display" }));
    const error = await failure(f.executor.execute({ kind: "keypress", keys: ["TAB"] }));
    expect(isCommandExitError(error)).toBe(true);
    expect(error).toMatchObject({ exitCode: 1 });
  });

  it("passes on the SDK's own error when the command throws", async () => {
    const sdkError = Object.assign(new Error("exit status 1"), {
      name: "CommandExitError",
      exitCode: 1,
    });
    const f = keyDesktop(() => {
      throw sdkError;
    });
    await expect(f.executor.execute({ kind: "keypress", keys: ["TAB"] })).rejects.toBe(sdkError);
  });
});
