// The local guest's side of a link handed to another app: the image's stand-in for xdg-open and
// xdg-email, run under the real sh, writes the link to the runtime directory, and each observation
// the guest executor returns carries the links written since the previous one.
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CuaExecutor } from "../../src/actors/computer-use/loop.js";
import {
  GUEST_EXTERNAL_LINK_BIN,
  prepareGuestBrowserProfile,
  withExternalHandoffs,
} from "../../src/guest/external-links.js";
import { externalLinkStandIn } from "../../src/substrates/e2b/desktop-handoff.js";

const execFileAsync = promisify(execFile);
// Regular files, one per command: the guest proofs refuse a link in the controller's payload.
const IMAGE_BIN = path.resolve("runtime/browser-guest/control/root/opt/humanish/control/bin");
const COMMANDS = ["xdg-open", "xdg-email"];

describe("the local guest's stand-in for a link's app", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-guest-links-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(COMMANDS)(
    "ships %s as the script the hosted desktop installs, with the guest's paths",
    async (command) => {
      expect(await readFile(path.join(IMAGE_BIN, command), "utf8")).toBe(
        externalLinkStandIn(GUEST_EXTERNAL_LINK_BIN, '"$XDG_RUNTIME_DIR/humanish-links.log"'),
      );
    },
  );

  it("hands each link the browser could not open to the next observation, once", async () => {
    const bin = path.join(dir, "bin");
    await execFileAsync("mkdir", [bin]);
    for (const command of COMMANDS) {
      await copyFile(path.join(IMAGE_BIN, command), path.join(bin, command));
      await chmod(path.join(bin, command), 0o755);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: dir };
    let looks = 0;
    const executor: CuaExecutor = {
      stallRecovery: "fail_closed",
      observe: async () => ({ stateSignature: `look-${(looks += 1)}` }),
      execute: async () => {},
    };
    const observed = withExternalHandoffs(executor, path.join(dir, "humanish-links.log"));
    expect(observed.stallRecovery).toBe("fail_closed");
    expect((await observed.observe()).externalHandoffs).toBeUndefined();

    await execFileAsync("xdg-email", ["mailto:help@example.test?body=order%2042"], { env });
    await execFileAsync("xdg-open", ["tel:555-0100"], { env });
    expect((await observed.observe()).externalHandoffs).toEqual([
      { scheme: "mailto", recipients: ["help@example.test"] },
      { scheme: "tel" },
    ]);
    expect((await observed.observe()).externalHandoffs).toBeUndefined();
  });
});

describe("the local guest browser's profile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-guest-profile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lets the app's origin open phone and message links without Chromium's prompt", async () => {
    const profile = path.join(dir, "browser");
    await prepareGuestBrowserProfile(profile, "http://127.0.0.1:3000/notes");
    const preferences = JSON.parse(
      await readFile(path.join(profile, "Default", "Preferences"), "utf8"),
    ) as { protocol_handler: { allowed_origin_protocol_pairs: Record<string, object> } };
    expect(Object.keys(preferences.protocol_handler.allowed_origin_protocol_pairs)).toEqual([
      "http://127.0.0.1:3000",
    ]);
    expect(
      preferences.protocol_handler.allowed_origin_protocol_pairs["http://127.0.0.1:3000"],
    ).toMatchObject({
      tel: true,
      sms: true,
    });
  });

  it("writes no profile for the guest's own start page", async () => {
    const profile = path.join(dir, "browser");
    await prepareGuestBrowserProfile(profile, undefined);
    await expect(readFile(path.join(profile, "Default", "Preferences"))).rejects.toThrow(/ENOENT/);
  });
});
