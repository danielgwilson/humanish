import { readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  parseBrowserPersonaJourneyFromScenario,
  type BrowserPersonaJourney,
} from "../actors/scripted-browser.js";
import { parseResolvedPersona, type ResolvedPersona } from "../lab/persona.js";
import { digestText } from "../evidence/redaction.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  type PreparedSelectedOutputDirectory,
} from "./selected-output-paths.js";
import type { RunBundle } from "./bundle.js";
import {
  implicitProjectDirectoryExists,
  inspectImplicitProjectPath,
  readImplicitProjectFile,
} from "./locate.js";
import { escapeRegExp } from "./primitives.js";

const builtinPersona = {
  id: "builtin-synthetic-new-user",
  name: "Built-in Synthetic New User",
  source: "builtin:synthetic-new-user",
  sourceDigest: "builtin",
};

const builtinScenario = {
  id: "builtin-first-run-smoke",
  title: "Built-in First-Run Smoke",
  goal: "Create a public-safe dry-run contract bundle from built-in defaults.",
  source: "builtin:first-run-smoke",
  sourceDigest: "builtin",
};

async function listImplicitProjectDirectory(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<string[]> {
  if (!(await implicitProjectDirectoryExists(projectRoot, relativePath))) {
    return [];
  }
  const directory = path.join(
    projectRoot.physicalPath,
    ...relativePath.replace(/\\/g, "/").split("/"),
  );
  const names = await readdir(directory);
  await assertPreparedSelectedOutputDirectory(projectRoot);
  for (const name of names) {
    assertSafeOutputPathSegment(name, "Implicit project directory entry");
    await inspectImplicitProjectPath(projectRoot, `${relativePath.replace(/\\/g, "/")}/${name}`);
  }
  return names;
}

export async function loadDryRunSelection(
  projectRoot: PreparedSelectedOutputDirectory,
  humanishSource: "present" | "missing",
): Promise<{
  browserJourney?: BrowserPersonaJourney;
  browserJourneyFailure?: string;
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (humanishSource === "missing") {
    return {
      persona: builtinPersona,
      resolvedPersona: parseResolvedPersona(
        {},
        { id: builtinPersona.id, name: builtinPersona.name },
      ),
      scenario: builtinScenario,
      warnings,
    };
  }

  const personaPath = "humanish/personas/synthetic-new-user.yaml";
  const scenarioPath = "humanish/scenarios/first-run-smoke.yaml";
  const personaText = await readImplicitProjectFile(projectRoot, personaPath);
  const scenarioText = await readImplicitProjectFile(projectRoot, scenarioPath);
  const browserJourneySelection = await loadBrowserPersonaJourneySelection(projectRoot);

  if (personaText === null) {
    warnings.push(`${personaPath} was not found; using built-in persona defaults.`);
  }

  if (scenarioText === null) {
    warnings.push(`${scenarioPath} was not found; using built-in scenario defaults.`);
  }

  let resolvedPersona: ResolvedPersona;
  if (personaText === null) {
    resolvedPersona = parseResolvedPersona(
      {},
      { id: builtinPersona.id, name: builtinPersona.name },
    );
  } else {
    const parsedPersona = parsePersonaYaml(personaText);
    if (parsedPersona.failed) {
      warnings.push(
        `${personaPath} could not be parsed as YAML; using built-in persona trait defaults.`,
      );
    }
    resolvedPersona = parseResolvedPersona(
      parsedPersona.value,
      {
        id: "synthetic-new-user",
        name: "Synthetic New User",
      },
      warnings,
    );
    resolvedPersona.sourceDigest = digestText(personaText ?? "");
  }

  return {
    ...(browserJourneySelection.journey ? { browserJourney: browserJourneySelection.journey } : {}),
    ...(browserJourneySelection.failure
      ? { browserJourneyFailure: browserJourneySelection.failure }
      : {}),
    persona:
      personaText === null
        ? builtinPersona
        : {
            id: readYamlScalar(personaText, "id") ?? "synthetic-new-user",
            name: readYamlScalar(personaText, "name") ?? "Synthetic New User",
            source: personaPath,
            sourceDigest: digestText(personaText),
          },
    resolvedPersona,
    scenario:
      scenarioText === null
        ? builtinScenario
        : {
            id: readYamlScalar(scenarioText, "id") ?? "first-run-smoke",
            title: readYamlScalar(scenarioText, "title") ?? "First-run smoke",
            goal:
              readYamlScalar(scenarioText, "goal") ?? "Run a public-safe first-run smoke scenario.",
            source: scenarioPath,
            sourceDigest: digestText(scenarioText),
          },
    warnings: [...warnings, ...browserJourneySelection.warnings],
  };
}

async function loadBrowserPersonaJourneySelection(
  projectRoot: PreparedSelectedOutputDirectory,
): Promise<{
  failure?: string;
  journey?: BrowserPersonaJourney;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const names = await listImplicitProjectDirectory(projectRoot, "humanish/scenarios");
  const files = names
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((left, right) => {
      if (left === "first-run-smoke.yaml") return -1;
      if (right === "first-run-smoke.yaml") return 1;
      return left.localeCompare(right);
    });

  for (const name of files) {
    const relativePath = path.join("humanish", "scenarios", name);
    const text = await readImplicitProjectFile(projectRoot, relativePath);
    if (text === null) {
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch {
      return {
        failure: `${relativePath} could not be parsed as YAML; browser persona journey failed closed.`,
        warnings,
      };
    }

    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw,
      relativePath,
      sourceDigest: digestText(text),
    });
    if (parsed.failure) {
      return {
        failure: parsed.failure,
        warnings,
      };
    }
    if (parsed.journey) {
      return {
        journey: parsed.journey,
        warnings,
      };
    }
  }

  return { warnings };
}

function readYamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"));
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(/^["']|["']$/g, "");
}

function parsePersonaYaml(text: string): { value: unknown; failed: boolean } {
  try {
    return { value: parseYaml(text), failed: false };
  } catch {
    return { value: {}, failed: true };
  }
}
