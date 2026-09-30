import { parse as parseYaml } from "yaml";
import { parseResolvedPersona, type ResolvedPersona } from "../lab/persona.js";
import { digestText } from "../evidence/redaction.js";
import type { PreparedSelectedOutputDirectory } from "./selected-output-paths.js";
import type { RunBundle } from "./bundle.js";
import { readImplicitProjectFile } from "./project.js";
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

export async function loadDryRunSelection(
  projectRoot: PreparedSelectedOutputDirectory,
  humanishSource: "present" | "missing",
): Promise<{
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
    warnings,
  };
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
