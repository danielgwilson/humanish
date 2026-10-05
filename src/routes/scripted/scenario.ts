// Resolve a scripted-browser study's `scenario` to a committed scenario file and parse its
// `browser.steps` into the journey the actor runs. The ref is an id or a repo-relative path that must
// stay inside the project; provenance records it repo-relative with the scenario's digest.

import { parse as parseYaml } from "yaml";
import path from "node:path";
import { parseBrowserPersonaJourneyFromScenario } from "../../actors/scripted-browser/journey.js";
import type { BrowserPersonaJourney } from "../../actors/scripted-browser/types.js";
import { digestText } from "../../evidence/redaction.js";
import {
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
} from "../../run/contained-output.js";

// Same public-safe token shape the study id uses; an id-style `scenario` must match it before
// it is interpolated into a repo path.
const SCENARIO_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

interface ResolvedScriptedScenario {
  ok: true;
  journey: BrowserPersonaJourney;
  /** Repo-relative provenance path (clamped inside the target cwd, fail-closed). */
  source: string;
  sourceDigest: string;
}

/**
 * Resolve and consume `scenario`. Path-style refs (contain a separator or end .yaml/.yml)
 * resolve against cwd and are clamped inside it: a ../../ escape is rejected, never recorded
 * as repo-relative provenance. Id-style refs must be public-safe tokens and resolve to
 * humanish/scenarios/<ref>.yaml (then .yml). Every failure mode is fail-closed. planScriptedStudy
 * has already refused a missing or blank ref.
 */
export async function resolveScriptedScenario(
  projectRoot: PreparedSelectedOutputDirectory,
  ref: string,
): Promise<ResolvedScriptedScenario | { ok: false; message: string }> {
  const trimmed = ref.trim();

  let absolutePath: string;
  let source: string;
  if (scenarioRefLooksLikePath(trimmed)) {
    absolutePath = path.resolve(projectRoot.physicalPath, trimmed);
    const relative = path.relative(projectRoot.physicalPath, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        ok: false,
        message: `scenario must stay inside the project directory, and "${trimmed}" does not: the run records it relative to the project.`,
      };
    }
    source = relative.split(path.sep).join("/");
  } else {
    if (!SCENARIO_REF_ID_PATTERN.test(trimmed)) {
      return {
        ok: false,
        message: `scenario must be a public-safe scenario id or a .yaml path inside the repo (got "${trimmed}").`,
      };
    }
    const candidates = [
      path.posix.join("humanish", "scenarios", `${trimmed}.yaml`),
      path.posix.join("humanish", "scenarios", `${trimmed}.yml`),
    ];
    const found = await firstExistingFile(projectRoot, candidates);
    if (!found) {
      return {
        ok: false,
        message: `scenario "${trimmed}" was not found (looked for ${candidates.join(", ")}).`,
      };
    }
    source = found;
    absolutePath = path.join(projectRoot.physicalPath, found);
  }

  const relativeScenarioPath = path.relative(projectRoot.physicalPath, absolutePath);
  const scenarioBytes = await readContainedRegularFile(projectRoot, relativeScenarioPath);
  if (!scenarioBytes) {
    return { ok: false, message: `scenario "${trimmed}" could not be read (${source}).` };
  }
  const text = scenarioBytes.toString("utf8");

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return {
      ok: false,
      message: `${source} could not be parsed as YAML; the scripted scenario failed closed.`,
    };
  }

  const sourceDigest = digestText(text);
  const parsed = parseBrowserPersonaJourneyFromScenario({
    raw,
    relativePath: source,
    sourceDigest,
  });
  if (parsed.failure) {
    return { ok: false, message: parsed.failure };
  }
  if (!parsed.journey) {
    return {
      ok: false,
      message: `${source} declares no browser steps, and the scripted-browser actor needs a scenario with browser.steps.`,
    };
  }

  return { ok: true, journey: parsed.journey, source, sourceDigest };
}

function scenarioRefLooksLikePath(ref: string): boolean {
  return (
    ref.endsWith(".yaml") ||
    ref.endsWith(".yml") ||
    ref.includes("/") ||
    ref.includes("\\") ||
    ref.startsWith(".")
  );
}

async function firstExistingFile(
  projectRoot: PreparedSelectedOutputDirectory,
  candidates: string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await readContainedRegularFile(projectRoot, candidate)) !== null) {
      return candidate;
    }
  }
  return null;
}
