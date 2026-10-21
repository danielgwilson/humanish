// A link the participant's browser handed to another app (mailto:, tel:, sms:) reaches the
// participant loop on an observation. The loop records it in the trace and tells the participant
// on its next turn what happened, since the study desktop shows no app window for it.
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { externalHandoffOf } from "../../../src/actors/computer-use/external-handoff.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

const CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};
const persona: ActorPersonaRef = { id: "ines", traitsApplied: [], promptDigest: "0123456789ab" };

function frame(): Buffer {
  const png = new PNG({ width: 64, height: 48 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

class ScriptedProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = CAPS;
  readonly seen: CuaTurnRequest[] = [];
  constructor(private readonly turns: CuaTurn[]) {}
  async nextTurn(request: CuaTurnRequest): Promise<CuaTurn> {
    this.seen.push(request);
    return (
      this.turns[this.seen.length - 1] ?? {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        message: "done",
      }
    );
  }
}

class Desktop implements CuaExecutor {
  private looks = 0;
  readonly frame = frame();
  constructor(
    private readonly handoffsByLook: Record<number, CuaObservation["externalHandoffs"]>,
  ) {}
  async observe(): Promise<CuaObservation> {
    const handoffs = this.handoffsByLook[this.looks];
    this.looks += 1;
    return {
      screenshot: this.frame,
      stateSignature: `look-${this.looks}`,
      ...(handoffs === undefined ? {} : { externalHandoffs: handoffs }),
    };
  }
  async execute(_action: CuaAction): Promise<void> {}
}

function clock(): () => number {
  let t = 0;
  return () => (t += 1000);
}

const click: CuaTurn = {
  actions: [{ kind: "click", x: 10, y: 10 }],
  pendingSafetyChecks: [],
  done: false,
};

async function run(desktop: Desktop, scrubText: (text: string) => string = (text) => text) {
  const provider = new ScriptedProvider([click, click]);
  const result = await runComputerUseLoop({
    instructions: "contact the site",
    provider,
    executor: desktop,
    persona,
    redaction: defaultRedactionHooks,
    scrubText,
    timeoutMs: 10_000_000,
    now: clock(),
    idleSteps: 5,
    noProgressSteps: 5,
  });
  const handoffItems = result.trace.items.filter(
    (item) => item.title === "link opened another app",
  );
  return { provider, result, handoffItems };
}

describe("a link handed to another app", () => {
  it("is recorded once and the next turn tells the participant nothing was sent", async () => {
    const { provider, handoffItems } = await run(
      new Desktop({ 1: [{ scheme: "mailto", recipients: ["help@example.test"] }] }),
    );
    expect(handoffItems.map((item) => item.text)).toEqual(["mailto: help@example.test"]);
    const hint = provider.seen[1]?.contextHint ?? "";
    expect(hint).toContain("help@example.test");
    expect(hint).toContain("nothing was sent");
    // Told once: the turn after that one carries no handoff note.
    expect(provider.seen[2]?.contextHint ?? "").not.toContain("help@example.test");
  });

  it("names a phone link by its scheme only", async () => {
    const { provider, handoffItems } = await run(new Desktop({ 1: [{ scheme: "tel" }] }));
    expect(handoffItems.map((item) => item.text)).toEqual(["tel:"]);
    expect(provider.seen[1]?.contextHint ?? "").toContain("no call was placed");
  });

  it("puts the recipients through the trace redaction", async () => {
    const { result, handoffItems } = await run(
      new Desktop({ 1: [{ scheme: "mailto", recipients: ["inbox-7@example.test"] }] }),
      (text) => text.replaceAll("inbox-7@example.test", "[redacted]"),
    );
    expect(handoffItems.map((item) => item.text)).toEqual(["mailto: [redacted]"]);
    expect(JSON.stringify(result.trace)).not.toContain("inbox-7@example.test");
  });
});

describe("what a run keeps of a handed-off link", () => {
  it("keeps a mailto link's recipients from every recipient field and nothing else", () => {
    expect(
      externalHandoffOf(
        "MAILTO:sales%40example.test,%22Help%20Desk%22%20%3Chelp@example.test%3E?BCC=audit@example.test&subject=Quote&body=call%20me%20at%20555-0100",
      ),
    ).toEqual({
      scheme: "mailto",
      recipients: ["sales@example.test", "help@example.test", "audit@example.test"],
    });
  });

  it("keeps no recipient text that is not an address", () => {
    expect(externalHandoffOf("mailto:?subject=hello&to=not%20an%20address")).toEqual({
      scheme: "mailto",
      recipients: [],
    });
  });

  it("leaves a web or file link to the browser", () => {
    expect(externalHandoffOf("https://example.test/contact")).toBeUndefined();
    expect(externalHandoffOf("file:///tmp/report.pdf")).toBeUndefined();
    expect(externalHandoffOf("no scheme at all")).toBeUndefined();
  });
});
