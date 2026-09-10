import type { ObserverData } from "./observer-data";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof value[key] === "string");
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const list = (value: unknown, check: (item: unknown) => boolean, max = 100_000): boolean => Array.isArray(value) && value.length <= max && value.every(check);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalStrings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => optionalString(value[key]));
const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";
const size = (value: unknown) => object(value) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0;
const event = (value: unknown) => object(value) && strings(value, ["id", "at", "level", "type", "message"]);
const link = (value: unknown) => object(value) && strings(value, ["label", "href", "kind"]);
const item = (value: unknown): boolean => object(value) && strings(value, ["id", "kind", "title"])
  && optionalStrings(value, ["text", "at", "status"])
  && (value.screenshotRef === undefined || (object(value.screenshotRef) && typeof value.screenshotRef.path === "string" && optionalString(value.screenshotRef.redaction)))
  && (value.coord === undefined || (object(value.coord) && finite(value.coord.x) && finite(value.coord.y)));

/** Admit the fields used by the UI, including nested optional evidence. A bad poll
 * must not replace a usable snapshot. Unknown additive fields remain compatible. */
export function isObserverData(value: unknown): value is ObserverData {
  if (!object(value) || value.schema !== "humanish.observer-data.v1" || value.schemaVersion !== 1
    || typeof value.generatedAt !== "string" || !object(value.run)
    || !strings(value.run, ["runId", "mode", "status", "title", "createdAt"])
    || !optionalStrings(value.run, ["participantsLine", "tasksLine"])
    || !object(value.run.persona) || !strings(value.run.persona, ["name"])
    || !object(value.run.scenario) || !strings(value.run.scenario, ["title"])
    || !list(value.run.knownGaps, (v) => typeof v === "string")
    || !list(value.run.lifecycle, (v) => object(v) && strings(v, ["at", "event", "message"]))
    || !object(value.summary) || !["streams", "active", "blocked", "warnings"].every((k) => finite(value.summary && (value.summary as Record<string, unknown>)[k]))
    || !object(value.publicSafety) || typeof value.publicSafety.note !== "string"
    || value.publicSafety.publishable !== false || !list(value.artifactLinks, link)
    || !list(value.events, event) || !Array.isArray(value.laneGroups)
    || !list(value.streams, validStream, 10_000)) return false;
  const share = value.publicSafety.share;
  if (share !== undefined && (!object(share) || !strings(share, ["status", "verifiedAt"])
    || !["share_ready", "local_only", "blocked"].includes(share.status as string)
    || !list(share.reasons, (v) => typeof v === "string"))) return false;
  const cost = value.cost;
  if (cost !== undefined && (!object(cost) || !(cost.estimatedTotalUsd === null || finite(cost.estimatedTotalUsd)) || typeof cost.ratesAsOf !== "string" || !optionalBoolean(cost.placeholder))) return false;
  const runtime = value.runtime;
  if (runtime !== undefined && (!object(runtime) || !strings(runtime, ["state", "observedAt", "source"])
    || !["running", "finished", "interrupted", "unknown"].includes(runtime.state as string)
    || runtime.source !== "local-run-status" || !Number.isFinite(Date.parse(runtime.observedAt as string)))) return false;
  const ids = (value.streams as Array<Record<string, unknown>>).map((stream) => (stream as { id: string }).id);
  return new Set(ids).size === ids.length;
}

function validStream(value: unknown): boolean {
  if (!object(value) || !strings(value, ["id", "label", "status", "statusLabel", "kind", "kindLabel", "terminalPlain"])
    || typeof value.id !== "string" || !value.id || value.id.length > 256
    || !object(value.sim) || !strings(value.sim, ["personaId", "summary"]) || !finite(value.sim.index)
    || !optionalStrings(value.sim, ["mode", "currentStep"])
    || !list(value.timeline, event) || !optionalStrings(value, ["laneId", "transport", "updatedAt", "url"])
    || !optionalBoolean(value.liveEnded)) return false;
  const viewport = value.viewport;
  if (viewport !== undefined && !size(viewport)) return false;
  const geometry = value.desktopGeometry;
  if (geometry !== undefined && (!object(geometry) || !object(geometry.screen)
    || !size(geometry.screen.requested) || (geometry.screen.verified !== undefined && !size(geometry.screen.verified)))) return false;
  const embed = value.embed;
  if (embed !== undefined && (!object(embed) || typeof embed.kind !== "string" || !optionalStrings(embed, ["url", "title"]))) return false;
  const ui = value.ui;
  if (ui !== undefined && (!object(ui) || !optionalStrings(ui, ["route", "state", "intent"]))) return false;
  const assignment = value.assignment;
  if (assignment !== undefined && (!object(assignment) || !strings(assignment, ["mission"]) || !optionalString(assignment.focus)
    || (assignment.tasks !== undefined && !list(assignment.tasks, (task) => object(task) && strings(task, ["id", "goal"]))))) return false;
  if (value.ending !== undefined && (!object(value.ending) || !strings(value.ending, ["cause", "label"]))) return false;
  const actor = value.actor;
  if (actor !== undefined && (!object(actor) || !strings(actor, ["provider", "reason", "completionReason"])
    || !finite(actor.durationMs) || !object(actor.ids) || !optionalString(actor.ids.model) || !object(actor.redaction)
    || typeof actor.redaction.screenshots !== "string" || !list(actor.items, item))) return false;
  if (object(actor)) {
    const affordance = actor.affordanceUse;
    if (affordance !== undefined && (!object(affordance) || !object(affordance.counts)
      || !Object.values(affordance.counts).every(finite) || !finite(affordance.shortcutTotal))) return false;
    const estimate = actor.estimatedCost;
    if (estimate !== undefined && (!object(estimate) || !(estimate.estimatedCostUsd === null || finite(estimate.estimatedCostUsd))
      || !(estimate.ratesAsOf === null || typeof estimate.ratesAsOf === "string"))) return false;
  }
  const live = value.liveActor;
  if (live !== undefined && (!object(live) || typeof live.updatedAt !== "string" || !list(live.items, item))) return false;
  if (value.artifacts !== undefined && !list(value.artifacts, (v) => object(v) && strings(v, ["label", "path", "kind"]))) return false;
  return true;
}
