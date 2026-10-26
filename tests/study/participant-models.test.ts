// A study picks its participant with actor.model, and the participant model table says which vendor
// serves it. These cases pin each resolution rule at the parser, the brain the planner builds, and
// the per-participant checks of effort and screen size, all before a run id exists.
import { describe, expect, it } from "vitest";

import { PARTICIPANT_MODELS } from "../../src/actors/computer-use/models.js";
import { MODEL_RATES, participantRate } from "../../src/run/pricing.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";

const ROOT = process.cwd();

function study(actor: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parseStudy({
    schema: STUDY_SCHEMA,
    id: "participant-models",
    route: "computer-use",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    actor: { mission: "Add a task.", ...actor },
    ...extra,
  });
}

const refusal = (result: ReturnType<typeof study>): string =>
  result.ok ? "accepted" : result.error.message;

/** The brain and key requirement a live plan of the study gets. */
function planned(actor: Record<string, unknown>) {
  const parsed = study(actor);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = planStudy(parsed.config, { cwd: ROOT, dryRun: false });
  if (!result.ok) throw new Error(result.refusal.message);
  const plan = result.planned.plan;
  if (plan.route !== "computer-use") throw new Error(`planned ${plan.route}`);
  return {
    brain: plan.runner.brain,
    keys: plan.requirements.flatMap((requirement) =>
      requirement.kind === "key" ? [requirement.name] : [],
    ),
  };
}

describe("actor.type: computer-use", () => {
  it("runs a listed model on the vendor the table names, with that vendor's key", () => {
    expect(planned({ type: "computer-use", model: "claude-haiku-5-5" })).toEqual({
      brain: {
        kind: "provider-key",
        vendor: "anthropic",
        model: "claude-haiku-5-5",
        declaredModel: "claude-haiku-5-5",
      },
      keys: ["E2B_API_KEY", "ANTHROPIC_API_KEY"],
    });
  });

  it("runs the OpenAI default when the study names no model", () => {
    expect(planned({ type: "computer-use" }).brain).toEqual({
      kind: "provider-key",
      vendor: "openai",
      model: "gpt-6.1-sol",
    });
  });

  it("runs the named vendor's default when the study names a provider and no model", () => {
    expect(planned({ type: "computer-use", provider: "anthropic" }).brain).toMatchObject({
      vendor: "anthropic",
      model: "claude-haiku-5-5",
    });
  });

  it("accepts a provider that agrees with the table", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5", provider: "anthropic" })),
    ).toBe("accepted");
  });

  it("refuses a provider that disagrees with the table", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5", provider: "openai" })),
    ).toBe(
      'actor.provider "openai" does not serve claude-haiku-5-5, which runs on anthropic. Remove actor.provider.',
    );
  });

  it("runs an unlisted model on the provider the study names, unpriced", () => {
    expect(
      planned({ type: "computer-use", model: "claude-sonnet-9", provider: "anthropic" }),
    ).toEqual({
      brain: {
        kind: "provider-key",
        vendor: "anthropic",
        model: "claude-sonnet-9",
        declaredModel: "claude-sonnet-9",
      },
      keys: ["E2B_API_KEY", "ANTHROPIC_API_KEY"],
    });
    expect(participantRate("claude-sonnet-9")).toBeUndefined();
  });

  it("refuses an unlisted model without a provider, naming the listed models and the escape", () => {
    const message = refusal(study({ type: "computer-use", model: "claude-sonnet-9" }));
    expect(message).toMatch(/^actor\.model "claude-sonnet-9" is not a participant model/);
    expect(message).toMatch(/claude-haiku-5-5, computer-use-preview/);
    expect(message).toMatch(/set actor\.provider/);
  });

  it("refuses a provider humanish does not run", () => {
    expect(refusal(study({ type: "computer-use", provider: "acme" }))).toMatch(
      /^actor\.provider must be one of: openai, anthropic/,
    );
  });
});

describe("actor.type: openai-computer-use", () => {
  it("still runs any model id on OpenAI", () => {
    expect(planned({ type: "openai-computer-use", model: "gpt-9-preview" }).brain).toMatchObject({
      vendor: "openai",
      model: "gpt-9-preview",
    });
  });

  it("refuses a model the table puts on another vendor, even with a cap that would price it", () => {
    const message = refusal(
      study({ type: "openai-computer-use", model: "claude-haiku-5-5" }, { caps: { maxUsd: 1 } }),
    );
    expect(message).toBe(
      "actor.type openai-computer-use runs openai models, and claude-haiku-5-5 runs on anthropic. Set actor.type: computer-use, which takes the vendor from actor.model.",
    );
  });

  it("refuses actor.provider", () => {
    expect(refusal(study({ type: "openai-computer-use", provider: "openai" }))).toMatch(
      /^actor\.provider applies only to actor\.type: computer-use/,
    );
  });
});

describe("effort, per participant", () => {
  it("refuses a level the listed model does not accept", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5", reasoningEffort: "none" })),
    ).toBe(
      "actor.reasoningEffort is none, which is not a level claude-haiku-5-5 accepts. Use one of: low, medium, high, xhigh, max.",
    );
  });

  it("refuses a participant's own level over an accepted actor level", () => {
    const message = refusal(
      study(
        { type: "computer-use", model: "claude-haiku-5-5", reasoningEffort: "medium" },
        { participants: [{ id: "a" }, { id: "b", reasoningEffort: "minimal" }] },
      ),
    );
    expect(message).toMatch(/^participants\[1\]\.reasoningEffort is minimal/);
  });

  it("checks an OpenAI model's level against its model page", () => {
    expect(
      refusal(
        study({ type: "openai-computer-use", model: "gpt-6.1-sol", reasoningEffort: "none" }),
      ),
    ).toMatch(/^actor\.reasoningEffort is none, which is not a level gpt-6\.1-sol accepts/);
  });

  it("checks an unlisted model's level against its vendor's documented levels only", () => {
    expect(
      refusal(
        study({
          type: "computer-use",
          model: "claude-sonnet-9",
          provider: "anthropic",
          reasoningEffort: "none",
        }),
      ),
    ).toMatch(/not a level anthropic documents for its models/);
    expect(
      refusal(
        study({ type: "openai-computer-use", model: "gpt-9-preview", reasoningEffort: "none" }),
      ),
    ).toBe("accepted");
  });
});

describe("screen size", () => {
  const custom = (resolution: [number, number]) => ({
    execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution } },
  });

  it("refuses a desktop over Claude's visual-token limit with sides under 2,000 px", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5" }, custom([2000, 2000]))),
    ).toMatch(/2000x2000 \(5184 visual tokens\)/);
  });

  it("refuses a desktop side over 2,000 px", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5" }, custom([2100, 900]))),
    ).toMatch(/up to 2000 px a side/);
  });

  it("accepts the wide preset for Claude and any size for OpenAI", () => {
    expect(
      refusal(
        study(
          { type: "computer-use", model: "claude-haiku-5-5" },
          {
            execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "wide" } },
          },
        ),
      ),
    ).toBe("accepted");
    expect(refusal(study({ type: "computer-use" }, custom([2100, 900])))).toBe("accepted");
  });
});

describe("the participant model table", () => {
  it("lists every model humanish prices for participants, and no other", () => {
    const priced = Object.keys(MODEL_RATES).filter((model) => participantRate(model) !== undefined);
    expect(Object.keys(PARTICIPANT_MODELS).sort()).toEqual(priced.sort());
  });

  it("refuses OpenAI Fast mode for a Claude participant", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5", serviceTier: "fast" })),
    ).toMatch(/Fast mode rate for model "claude-haiku-5-5"/);
  });

  it("takes maxOutputTokens for any API participant", () => {
    expect(
      refusal(study({ type: "computer-use", model: "claude-haiku-5-5", maxOutputTokens: 4096 })),
    ).toBe("accepted");
  });
});
