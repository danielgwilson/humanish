import { describe, expect, it, vi } from "vitest";

// The e2b SDK's base Sandbox as observed live (e2b 2.56.0, 2026-10-21): `create` and `connect`
// construct through `new this`, a sandbox created with `allowPublicTraffic: false` carries a
// traffic access token that `connect` returns again, `getHost` names `<port>-<id>.e2b.app`, and
// `connect` to a killed id throws SandboxNotFoundError. @e2b/desktop's Sandbox extends it.
const live = new Map<string, { token?: string }>();

class FakeBaseSandbox {
  readonly trafficAccessToken?: string;
  readonly commands = { run: async (command: string) => ({ exitCode: 0, stdout: command }) };
  readonly files = { write: async () => undefined };

  constructor(readonly sandboxId: string) {
    const token = live.get(sandboxId)?.token;
    if (token !== undefined) this.trafficAccessToken = token;
  }

  static async create(options: { network?: { allowPublicTraffic?: boolean } } = {}) {
    const sandboxId = `fake-base-${live.size + 1}`;
    live.set(
      sandboxId,
      options.network?.allowPublicTraffic === false
        ? { token: `synthetic-traffic-token-${live.size + 1}` }
        : {},
    );
    return new this(sandboxId);
  }

  static async connect(sandboxId: string) {
    if (!live.has(sandboxId))
      throw Object.assign(new Error(`sandbox ${sandboxId} not found`), {
        name: "SandboxNotFoundError",
      });
    return new this(sandboxId);
  }

  static async kill(sandboxId: string) {
    return live.delete(sandboxId);
  }

  async kill() {
    return live.delete(this.sandboxId);
  }

  getHost(port: number) {
    return `${port}-${this.sandboxId}.e2b.app`;
  }
}

vi.mock("@e2b/desktop", () => ({
  Sandbox: class FakeDesktopSandbox extends FakeBaseSandbox {
    screenshot() {
      return Promise.resolve(new Uint8Array());
    }
  },
}));

const { loadE2BBaseModule } = await import("../../../src/substrates/e2b/base-module.js");

describe("E2B base-template sandboxes", () => {
  it("reach a port with the sandbox's traffic token, also after connecting by id", async () => {
    const { Sandbox } = await loadE2BBaseModule();
    const created = await Sandbox.create({ apiKey: "", network: { allowPublicTraffic: false } });
    const again = await Sandbox.connect!(created.sandboxId);
    for (const sandbox of [created, again])
      await expect(sandbox.portAccess!(7000)).resolves.toEqual({
        url: `https://7000-${created.sandboxId}.e2b.app`,
        headers: { "e2b-traffic-access-token": "synthetic-traffic-token-1" },
      });
  });

  it("refuses port access on a sandbox that accepts public traffic", async () => {
    const { Sandbox } = await loadE2BBaseModule();
    const open = await Sandbox.create({ apiKey: "" });
    await expect(open.portAccess!(7000)).rejects.toThrow("no traffic access token");
  });

  it("answers desktop calls with an error, since the base template has no desktop", async () => {
    const { Sandbox } = await loadE2BBaseModule();
    const sandbox = await Sandbox.create({ apiKey: "" });
    await expect(sandbox.screenshot()).rejects.toMatchObject({ name: "E2BDesktopOnlyError" });
    expect(() => sandbox.stream.getUrl()).toThrow("needs a desktop sandbox");
  });

  it("reports a killed sandbox gone on connect", async () => {
    const { Sandbox } = await loadE2BBaseModule();
    const { sandboxId } = await Sandbox.create({ apiKey: "" });
    await Sandbox.kill!(sandboxId);
    await expect(Sandbox.connect!(sandboxId)).rejects.toMatchObject({
      name: "SandboxNotFoundError",
    });
  });
});
