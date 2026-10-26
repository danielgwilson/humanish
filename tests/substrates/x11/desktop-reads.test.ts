import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import type { CuaAction } from "../../../src/actors/computer-use/loop.js";
import { executeX11Action, type X11Transport } from "../../../src/substrates/x11/desktop.js";
import { HOSTED_X11_DIALECT } from "../../../src/substrates/x11/translator.js";

// The runner's two reads, `read_pointer` and `zoom`, over a fake transport that returns what a
// custom transport might.

function transport(port: Partial<X11Transport>): X11Transport {
  return {
    input: async () => {},
    prepareText: async () => ({ paste: async () => {}, close: async () => {} }),
    wait: async () => {},
    capture: async () => PNG.sync.write(new PNG({ width: 4, height: 3 })),
    ...port,
  };
}

function execute(port: X11Transport, action: CuaAction) {
  return executeX11Action(
    action,
    { transport: port, dialect: HOSTED_X11_DIALECT },
    new AbortController().signal,
  );
}

const readPointer: CuaAction = { kind: "read_pointer" };
const zoom = (width: number, height: number): CuaAction => ({
  kind: "zoom",
  region: { x: 1, y: 1, width, height },
});

describe("a pointer read", () => {
  it("is refused on a transport that cannot read the pointer", async () => {
    await expect(execute(transport({}), readPointer)).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
  });

  it.each([[{ x: 1.5, y: 2 }], [{ x: -1, y: 2 }], [{ x: Number.NaN, y: 0 }]])(
    "reports %j as an invalid response",
    async (point) => {
      await expect(
        execute(transport({ readPointer: async () => point }), readPointer),
      ).rejects.toMatchObject({ code: "invalid_response", disposition: "not_dispatched" });
    },
  );
});

describe("a zoom", () => {
  it("returns the region at the frame's own pixels", async () => {
    const result = await execute(transport({}), zoom(3, 2));
    expect(result?.kind).toBe("frame");
    const crop = PNG.sync.read((result as { screenshot: Buffer }).screenshot);
    expect([crop.width, crop.height]).toEqual([3, 2]);
  });

  it("is refused when the region leaves the captured frame", async () => {
    await expect(execute(transport({}), zoom(4, 2))).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
  });

  it("reports a capture that is not a PNG as an invalid response", async () => {
    await expect(
      execute(transport({ capture: async () => Buffer.from("not a png") }), zoom(1, 1)),
    ).rejects.toMatchObject({ code: "invalid_response", disposition: "not_dispatched" });
  });
});
