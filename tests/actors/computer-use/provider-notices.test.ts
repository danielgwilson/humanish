import { describe, expect, it } from "vitest";

import {
  runComputerUseLoop,
  type CuaProvider,
  type CuaTurn,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

// A provider can attach facts about a reply that no other turn field carries, such as a reply
// billed at a tier the rate table does not price. The trace records each as a warning notice,
// whichever request the reply answered.

const notice = {
  title: "participant reply billed outside the rate table",
  text: "The reply was served in the us inference region, which bills 1.1x.",
};

const turn = (patch: Partial<CuaTurn>): CuaTurn => ({
  actions: [],
  pendingSafetyChecks: [],
  done: false,
  ...patch,
});

function provider(turns: CuaTurn[], extra: Partial<CuaProvider> = {}): CuaProvider {
  return {
    id: "fixture",
    version: "1",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: false,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    nextTurn: async () => turns.shift() ?? turn({ done: true, message: "Done." }),
    ...extra,
  };
}

async function noticesOf(model: CuaProvider, stopWhen = false) {
  let acted = false;
  const result = await runComputerUseLoop({
    instructions: "Add one entry.",
    provider: model,
    executor: {
      observe: async () => ({ stateSignature: String(acted), text: acted ? "saved" : "" }),
      execute: async () => {
        acted = true;
      },
    },
    persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks,
    now: Date.now,
    timeoutMs: 60_000,
    ...(stopWhen ? { stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] } } : {}),
  });
  return result.trace.items.filter((item) => item.title === notice.title);
}

describe("notices a provider attaches to a reply", () => {
  it("are recorded as warnings for a participant turn", async () => {
    const recorded = await noticesOf(provider([turn({ done: true, notices: [notice] })]));
    expect(recorded).toEqual([expect.objectContaining({ status: "warn", text: notice.text })]);
  });

  it("are recorded for a reply set aside at its output limit", async () => {
    const recorded = await noticesOf(
      provider([turn({ interruption: "output_limit", notices: [notice] })], {
        outputLimitRetry: true,
      }),
    );
    expect(recorded).toHaveLength(1);
  });

  it("are recorded for a closing reply", async () => {
    const recorded = await noticesOf(
      provider([turn({ actions: [{ kind: "click", x: 1, y: 2 }] })], {
        debrief: async () => turn({ done: true, notices: [notice] }),
      }),
      true,
    );
    expect(recorded).toHaveLength(1);
  });
});
