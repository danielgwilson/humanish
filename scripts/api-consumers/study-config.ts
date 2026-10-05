// A StudyConfig as a library caller writes it since 0.111.0, with the keys of a humanish.study.v3
// file, and the fields a caller reads from parseStudy's config. scripts/public-api-proof.mjs
// typechecks it against the packed package; it never runs. A field renamed in StudyConfig fails
// that typecheck.
import { STUDY_SCHEMA, parseStudy, routeOf, type StudyConfig, type StudyRoute } from "humanish";

export const config: StudyConfig = {
  schema: STUDY_SCHEMA,
  id: "api-consumer",
  route: "computer-use",
  mode: "dry-run",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: {
    type: "openai-computer-use",
    mission: "Explore the app.",
    persona: "first-time-visitor",
  },
  participants: [{ id: "reader", persona: "first-time-visitor" }, { id: "skimmer" }],
  caps: { maxUsd: 2, maxTotalUsd: 4 },
  execution: { target: "e2b-desktop", timeoutMs: 600_000 },
};

export const counted: StudyConfig["participants"] = { count: 3, instruction: "Try the export." };

export const scripted: Pick<StudyConfig, "route" | "scenario" | "surfaces"> = {
  route: "scripted",
  scenario: "scripted-first-run",
  surfaces: ["desktop", "mobile"],
};

export function read(raw: unknown): {
  route: StudyRoute;
  actor: string;
  participants: StudyConfig["participants"];
  maxUsd: number | undefined;
} {
  const parsed = parseStudy(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return {
    route: routeOf(parsed.config),
    actor: parsed.config.actor.type,
    participants: parsed.config.participants,
    maxUsd: parsed.config.caps?.maxUsd,
  };
}
