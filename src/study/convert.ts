// Convert a humanish.lab.v2 study file to humanish.study.v3. It edits the parsed YAML document in
// place and moves each pair node, so the comments on a moved key move with it. The result lists
// every key it moved and every key it dropped. It refuses a file whose v3 form would parse or plan
// differently from the v2 source with the dropped keys removed.

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  Pair,
  parseDocument,
  Scalar,
  visit,
  YAMLMap,
  YAMLSeq,
  type Document,
} from "yaml";
import { parseLabConfig } from "./config.js";
import { focusOf } from "./parse/actors.js";
import { posInt } from "./parse/values.js";
import { planLab } from "./plan.js";
import type { StudyRoute } from "./parse/study-v3.js";
import { routeOf } from "./routing.js";
import { LAB_CONFIG_SCHEMA, STUDY_SCHEMA, type LabConfig } from "./types.js";
import { inertFieldPaths } from "./warnings.js";
import {
  deleteNodeFieldPath,
  deletePlainFieldPath,
  pairIndex,
  readFieldPath,
} from "./field-paths.js";

/** A key the conversion moved, by its v2 path and its v3 path. */
export interface MovedKey {
  readonly from: string;
  readonly to: string;
}

/** A key the conversion dropped because the study's route never reads it. */
export interface DroppedKey {
  readonly path: string;
  readonly value: unknown;
  /** The comments that sat on the dropped key, which the v3 file no longer has. */
  readonly comments?: string;
}

/** A v2 file converted to v3. */
interface StudyConversion {
  readonly text: string;
  readonly route: StudyRoute;
  readonly moved: readonly MovedKey[];
  readonly dropped: readonly DroppedKey[];
}

/** The conversion, or why the file cannot be converted as it stands. */
export type StudyConversionResult =
  | { readonly ok: true; readonly conversion: StudyConversion }
  | { readonly ok: false; readonly reason: string };

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Whether a parsed YAML value is a v3 study file. */
export function isStudyV3(raw: unknown): boolean {
  return isPlainRecord(raw) && raw.schema === STUDY_SCHEMA;
}

/** Convert one v2 file's text. `cwd` is the project the plan check plans in. */
export function convertStudyText(text: string, cwd: string): StudyConversionResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) return refuse(`it is not valid YAML: ${doc.errors[0]!.message}`);
  const anchorLine = firstAnchorLine(doc, lineCounter);
  if (anchorLine !== undefined) {
    return refuse(
      `line ${anchorLine} uses a YAML anchor or alias. Write the value out in full, then migrate.`,
    );
  }
  const raw: unknown = doc.toJS();
  if (!isPlainRecord(raw) || !isMap(doc.contents)) return refuse("it is not a YAML mapping.");
  if (raw.schema !== LAB_CONFIG_SCHEMA) return refuse(`its schema is not ${LAB_CONFIG_SCHEMA}.`);
  const source = parseLabConfig(raw);
  if (!source.ok) return refuse(`it does not parse: ${source.error.message}`);
  const route = routeOf(source.config);

  const actorRaw = Array.isArray(raw.actors) ? raw.actors[0] : undefined;
  if (route === "terminal" && isPlainRecord(actorRaw)) {
    for (const key of ["count", "laneFocus"]) {
      if (actorRaw[key] !== undefined) {
        return refuse(
          `actors[0].${key} does nothing on the terminal route, and a v3 terminal study has no participants. Remove it, then migrate.`,
        );
      }
    }
  }

  const root = doc.contents;
  const dropped: DroppedKey[] = [];
  for (const path of droppedPaths(source.config, route, raw)) {
    const value = readFieldPath(raw, path);
    const pairs = deleteNodeFieldPath(root, path);
    if (value === undefined || pairs.length === 0) continue;
    const comments = pairComments(pairs);
    dropped.push({ path, value, ...(comments === undefined ? {} : { comments }) });
  }

  const moved: MovedKey[] = [];
  // v2 reads some laneFocus values as no focus at all ({}, a valueless key, valueless fields).
  const focused = focusOf(source.config.actors[0]) !== undefined;
  const converted = convertDocument(root, route, focused, moved);
  if (!converted.ok) return converted;
  const out = doc.toString({ lineWidth: foldWidth(text), flowCollectionPadding: false });
  // Fail closed: a comment the conversion did not carry over or report stops it.
  const lost = lostComment(text, out, dropped);
  if (lost !== undefined) return refuse(`it would lose the comment "${lost}".`);

  const check = samePlans(
    raw,
    dropped.map((key) => key.path),
    out,
    cwd,
  );
  if (!check.ok) return check;
  return { ok: true, conversion: { text: out, route, moved, dropped } };
}

// Every comment line in a YAML text, trimmed.
function commentLinesOf(text: string): string[] {
  const doc = parseDocument(text);
  const found: string[] = [doc.commentBefore ?? "", doc.comment ?? ""];
  visit(doc, (_key, node) => {
    // An implicit empty value, as `id` in `{id, instruction: x}`, is a null node.
    if (typeof node !== "object" || node === null) return;
    const commented = node as { commentBefore?: string | null; comment?: string | null };
    found.push(commented.commentBefore ?? "", commented.comment ?? "");
  });
  return found
    .flatMap((comment) => comment.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
}

// The first comment line of the source that is neither in the output nor in a dropped key's report.
function lostComment(
  source: string,
  output: string,
  dropped: readonly DroppedKey[],
): string | undefined {
  const kept = new Map<string, number>();
  const reported = dropped.flatMap((key) => (key.comments ?? "").split("\n"));
  for (const line of [...commentLinesOf(output), ...reported.map((line) => line.trim())])
    if (line) kept.set(line, (kept.get(line) ?? 0) + 1);
  for (const line of commentLinesOf(source)) {
    const left = kept.get(line) ?? 0;
    if (left === 0) return line;
    kept.set(line, left - 1);
  }
  return undefined;
}

// The inert-field table's paths for the route, plus terminal `execution.timeoutMs`, which no
// terminal code reads. Parents come before their children, so a child under a dropped parent is
// reported with the parent.
function droppedPaths(config: LabConfig, route: StudyRoute, raw: PlainRecord): string[] {
  const paths = inertFieldPaths(config);
  if (route === "terminal" && readFieldPath(raw, "execution.timeoutMs") !== undefined)
    paths.push("execution.timeoutMs");
  const depth = (path: string) => path.split(".").length;
  return [...new Set(paths)].sort((left, right) => depth(left) - depth(right));
}

// Folded text is folded again on output. Most of a file's long lines end near the width its author
// folded at, so the 90th percentile of their lengths stands for it, between 80 and 120.
function foldWidth(text: string): number {
  const long = text
    .split("\n")
    .map((line) => line.length)
    .filter((length) => length > 60)
    .sort((left, right) => left - right);
  if (long.length === 0) return 80;
  const width = long[Math.min(long.length - 1, Math.floor(long.length * 0.9))]!;
  return Math.min(120, Math.max(80, width));
}

function firstAnchorLine(doc: Document, lineCounter: LineCounter): number | undefined {
  let line: number | undefined;
  visit(doc, (_key, node) => {
    const anchored =
      isAlias(node) ||
      (typeof node === "object" &&
        node !== null &&
        "anchor" in node &&
        Boolean((node as { anchor?: string }).anchor));
    if (!anchored) return undefined;
    const offset = (node as { range?: [number, number, number] }).range?.[0] ?? 0;
    line = lineCounter.linePos(offset).line;
    return visit.BREAK;
  });
  return line;
}

// Every comment on a node and everything under it.
function subtreeComments(node: unknown, found: string[]): void {
  if (typeof node !== "object" || node === null) return;
  const commented = node as { commentBefore?: string | null; comment?: string | null };
  if (commented.commentBefore) found.push(commented.commentBefore);
  if (commented.comment) found.push(commented.comment);
  if (isMap(node) || isSeq(node)) {
    for (const item of node.items) {
      if (item instanceof Pair) {
        subtreeComments(item.key, found);
        subtreeComments(item.value, found);
      } else subtreeComments(item, found);
    }
  }
}

function pairComments(pairs: readonly Pair[]): string | undefined {
  const found: string[] = [];
  for (const pair of pairs) {
    subtreeComments(pair.key, found);
    subtreeComments(pair.value, found);
  }
  const text = found
    .flatMap((comment) => comment.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function keyNode(pair: Pair): Scalar {
  return pair.key as Scalar;
}

function rename(pair: Pair, key: string): void {
  keyNode(pair).value = key;
}

function addCommentBefore(pair: Pair, comment: string | null | undefined): void {
  if (!comment) return;
  const key = keyNode(pair);
  key.commentBefore = key.commentBefore ? `${comment}\n${key.commentBefore}` : comment;
}

// Remove `key` from a mapping. A comment the mapping holds above its first key belongs to that key.
function take(map: unknown, key: string): Pair | undefined {
  if (!isMap(map)) return undefined;
  const index = pairIndex(map, key);
  if (index < 0) return undefined;
  const [pair] = map.items.splice(index, 1);
  if (index === 0 && map.commentBefore) {
    addCommentBefore(pair!, map.commentBefore);
    map.commentBefore = null;
  }
  return pair;
}

function insertAfter(map: YAMLMap, anchors: readonly string[], ...pairs: Pair[]): void {
  const anchor = anchors.map((key) => pairIndex(map, key)).find((index) => index >= 0);
  map.items.splice(anchor === undefined ? 0 : anchor + 1, 0, ...pairs);
}

// A removed section's trailing comment goes above the pair that followed the section, which is
// where it sat in the file, or to the end of the file when nothing followed.
function keepTrailingComment(
  root: YAMLMap,
  next: Pair | undefined,
  comment: string | null | undefined,
): void {
  if (!comment) return;
  if (next !== undefined) addCommentBefore(next, comment);
  else root.comment = root.comment ? `${root.comment}\n${comment}` : comment;
}

// Remove a key from a top-level section, and the section with it once it is empty. The section's
// own comments move to the promoted key.
function promote(root: YAMLMap, section: string, key: string): Pair | undefined {
  const index = pairIndex(root, section);
  if (index < 0) return undefined;
  const container = root.items[index]!;
  const pair = take(container.value, key);
  if (pair === undefined) return undefined;
  if (isMap(container.value) && container.value.items.length === 0) {
    const next = root.items[index + 1];
    root.items.splice(index, 1);
    addCommentBefore(pair, keyNode(container).commentBefore);
    keepTrailingComment(root, next, container.value.comment);
  }
  return pair;
}

function convertDocument(
  root: YAMLMap,
  route: StudyRoute,
  focused: boolean,
  moved: MovedKey[],
): { ok: true } | { ok: false; reason: string } {
  const schema = root.items[pairIndex(root, "schema")];
  if (schema && isScalar(schema.value)) schema.value.value = STUDY_SCHEMA;

  // actors[0] becomes actor, at the same position.
  const actorsPair = root.items[pairIndex(root, "actors")];
  if (!actorsPair || !isSeq(actorsPair.value) || !isMap(actorsPair.value.items[0]))
    return refuse("its actors list does not hold one actor mapping.");
  const list = actorsPair.value as YAMLSeq;
  const actor = list.items[0] as YAMLMap;
  if (list.commentBefore)
    actor.commentBefore = [list.commentBefore, actor.commentBefore].filter(Boolean).join("\n");
  if (list.comment) actor.comment = [actor.comment, list.comment].filter(Boolean).join("\n");
  rename(actorsPair, "actor");
  actorsPair.value = actor;
  moved.push({ from: "actors[0]", to: "actor" });

  let after = "actor";
  const participants = participantsPair(actor, route, focused, moved);
  if (participants !== undefined) {
    insertAfter(root, [after], participants);
    after = String(keyNode(participants).value);
  }

  const capsSection = route === "terminal" ? "scenario" : "execution";
  const caps = promote(root, capsSection, "caps");
  if (caps !== undefined) {
    insertAfter(root, [after], caps);
    moved.push({ from: `${capsSection}.caps`, to: "caps" });
  }

  // scenario.ref becomes scenario, a string, where scenario was; scenario.mode becomes mode.
  let mode: Pair | undefined;
  const scenarioIndex = pairIndex(root, "scenario");
  if (scenarioIndex >= 0) {
    const scenario = root.items[scenarioIndex]!;
    mode = take(scenario.value, "mode");
    const ref = take(scenario.value, "ref");
    if (isMap(scenario.value) && scenario.value.items.length > 0) {
      return refuse(
        `scenario still holds ${scenario.value.items.map((pair) => String(keyNode(pair).value)).join(", ")} after conversion.`,
      );
    }
    const next = root.items[scenarioIndex + 1];
    root.items.splice(scenarioIndex, 1);
    const promoted = mode ?? ref;
    // A comment on the `scenario:` line sits on the section's value, a mapping or an empty scalar,
    // when nothing took it.
    const value = scenario.value as {
      commentBefore?: string | null;
      comment?: string | null;
    } | null;
    const note = [keyNode(scenario).commentBefore, value?.commentBefore].filter(Boolean).join("\n");
    if (promoted !== undefined) addCommentBefore(promoted, note);
    else keepTrailingComment(root, next, note);
    keepTrailingComment(root, next, value?.comment);
    if (ref !== undefined) {
      rename(ref, "scenario");
      root.items.splice(scenarioIndex, 0, ref);
      moved.push({ from: "scenario.ref", to: "scenario" });
    }
    if (mode !== undefined) moved.push({ from: "scenario.mode", to: "mode" });
  }

  const routePair = new Pair(new Scalar("route"), new Scalar(route));
  // subject.topology says shared-world; route says it now, and takes its comments.
  const subject = root.items[pairIndex(root, "subject")];
  const topology =
    route === "shared-world" && subject ? take(subject.value, "topology") : undefined;
  if (topology !== undefined) {
    addCommentBefore(routePair, keyNode(topology).commentBefore);
    const value = topology.value as {
      comment?: string | null;
      commentBefore?: string | null;
    } | null;
    addCommentBefore(routePair, value?.commentBefore);
    if (value?.comment) (routePair.value as Scalar).comment = value.comment;
    moved.push({ from: "subject.topology", to: "route" });
  }

  insertAfter(
    root,
    ["description", "title", "id"],
    ...[routePair, mode].filter((pair): pair is Pair => pair !== undefined),
  );
  return { ok: true };
}

// The participant keys leave the actor for `participants`, or `surfaces` on the scripted route.
function participantsPair(
  actor: YAMLMap,
  route: StudyRoute,
  focused: boolean,
  moved: MovedKey[],
): Pair | undefined {
  const count = take(actor, "count");
  const entries = take(actor, "lanes");
  const roster = take(actor, "roster");
  let focus = take(actor, "laneFocus");
  // A `laneFocus` v2 reads as no focus converts as if absent. Every comment in it goes above the
  // count, or to the end of the actor.
  if (focus !== undefined && !focused) {
    const found: string[] = [];
    subtreeComments(focus.key, found);
    subtreeComments(focus.value, found);
    const notes = found.join("\n");
    if (count !== undefined) addCommentBefore(count, notes);
    else if (notes) actor.comment = [actor.comment, notes].filter(Boolean).join("\n");
    focus = undefined;
  }
  if (route === "scripted") {
    if (count === undefined) return undefined;
    const surfaces = new YAMLSeq();
    surfaces.flow = true;
    const two = isScalar(count.value) && Number(count.value.value) === 2;
    surfaces.items.push(new Scalar("desktop"), ...(two ? [new Scalar("mobile")] : []));
    if (isScalar(count.value) && count.value.comment) surfaces.comment = count.value.comment;
    if (isScalar(count.value)) addCommentBefore(count, count.value.commentBefore);
    rename(count, "surfaces");
    count.value = surfaces;
    moved.push({ from: "actors[0].count", to: "surfaces" });
    return count;
  }
  const list = entries ?? roster;
  if (list !== undefined) {
    if (isSeq(list.value))
      for (const item of list.value.items)
        if (isMap(item)) numericCount(item.items[pairIndex(item, "count")]);
    rename(list, "participants");
    moved.push({ from: `actors[0].${entries ? "lanes" : "roster"}`, to: "participants" });
    return list;
  }
  if (focus !== undefined) {
    const instruction = take(focus.value, "instruction");
    const homogeneous = new YAMLMap();
    // laneFocus's mapping, or the empty scalar a valueless `laneFocus:` holds, carries its comments.
    const focusValue = focus.value as {
      comment?: string | null;
      commentBefore?: string | null;
    } | null;
    if (focusValue?.comment) homogeneous.comment = focusValue.comment;
    if (focusValue?.commentBefore) homogeneous.commentBefore = focusValue.commentBefore;
    // Fields v2 read as unset (`id: null`) go with the old mapping; their comments stay.
    const rest: string[] = [];
    if (isMap(focus.value))
      for (const item of focus.value.items) {
        subtreeComments(item.key, rest);
        subtreeComments(item.value, rest);
      }
    if (rest.length > 0)
      homogeneous.comment = [homogeneous.comment, ...rest].filter(Boolean).join("\n");
    numericCount(count);
    if (count !== undefined) homogeneous.items.push(count);
    if (instruction !== undefined) homogeneous.items.push(instruction);
    rename(focus, "participants");
    focus.value = homogeneous;
    moved.push({ from: "actors[0].laneFocus", to: "participants" });
    if (count !== undefined) moved.push({ from: "actors[0].count", to: "participants.count" });
    return focus;
  }
  if (count !== undefined) {
    numericCount(count);
    rename(count, "participants");
    moved.push({ from: "actors[0].count", to: "participants" });
    return count;
  }
  return undefined;
}

// v2 reads a count written as a digit string, such as "2"; v3 takes a number, so write the number.
function numericCount(pair: Pair | undefined): void {
  if (pair === undefined || !isScalar(pair.value) || typeof pair.value.value !== "string") return;
  const count = posInt(pair.value.value);
  if (count === undefined) return;
  pair.value.value = count;
  pair.value.type = Scalar.PLAIN;
}

// JSON drops undefined fields, so two configs built through different branches compare by value.
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function samePlans(
  raw: PlainRecord,
  dropped: readonly string[],
  text: string,
  cwd: string,
): { ok: true } | { ok: false; reason: string } {
  const projected = structuredClone(raw);
  for (const path of dropped) deletePlainFieldPath(projected, path);
  const before = parseLabConfig(projected);
  if (!before.ok) {
    return refuse(`it does not parse once the unread keys are dropped: ${before.error.message}`);
  }
  const after = parseLabConfig(parseDocument(text).toJS());
  if (!after.ok) return refuse(`its v3 form does not parse: ${after.error.message}`);
  if (
    JSON.stringify(plain({ ...after.config, schema: LAB_CONFIG_SCHEMA })) !==
    JSON.stringify(plain(before.config))
  ) {
    return refuse("its v3 form parses to a different study.");
  }
  for (const dryRun of [true, false]) {
    const v2 = plain(planLab(before.config, { cwd, dryRun }));
    const v3 = plain(planLab(after.config, { cwd, dryRun }));
    if (JSON.stringify(v2) !== JSON.stringify(v3)) {
      return refuse(`its v3 form plans a different ${dryRun ? "dry" : "live"} run.`);
    }
  }
  return { ok: true };
}
