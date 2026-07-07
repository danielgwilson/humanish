import { readFile } from "node:fs/promises";
import path from "node:path";

export const ENV_FILE_RESULT_SCHEMA = "homun.env-file-result.v1";

export interface EnvFileLoadResult {
  schema: typeof ENV_FILE_RESULT_SCHEMA;
  ok: boolean;
  cwd: string;
  envFile: string;
  loaded: string[];
  skipped: string[];
  error?: {
    code: "HOMUN_ENV_FILE_NOT_FOUND" | "HOMUN_ENV_FILE_INVALID";
    message: string;
  };
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function loadEnvFile(
  cwd: string,
  envFile: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<EnvFileLoadResult> {
  const resolvedCwd = path.resolve(cwd);
  const envPath = path.resolve(resolvedCwd, envFile);
  const loaded: string[] = [];
  const skipped: string[] = [];

  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return {
      schema: ENV_FILE_RESULT_SCHEMA,
      ok: false,
      cwd: resolvedCwd,
      envFile,
      loaded,
      skipped,
      error: {
        code: "HOMUN_ENV_FILE_NOT_FOUND",
        message: `Env file was not readable: ${envFile}`
      }
    };
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseEnvLine(lines[index] ?? "");
    if (parsed === null) {
      continue;
    }

    if (!parsed.ok) {
      return {
        schema: ENV_FILE_RESULT_SCHEMA,
        ok: false,
        cwd: resolvedCwd,
        envFile,
        loaded,
        skipped,
        error: {
          code: "HOMUN_ENV_FILE_INVALID",
          message: `Invalid env assignment on line ${index + 1}.`
        }
      };
    }

    if (env[parsed.name] !== undefined) {
      skipped.push(parsed.name);
      continue;
    }

    env[parsed.name] = parsed.value;
    loaded.push(parsed.name);
  }

  return {
    schema: ENV_FILE_RESULT_SCHEMA,
    ok: true,
    cwd: resolvedCwd,
    envFile,
    loaded,
    skipped
  };
}

type ParsedEnvLine =
  | { ok: true; name: string; value: string }
  | { ok: false };

function parseEnvLine(line: string): ParsedEnvLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const separator = assignment.indexOf("=");
  if (separator <= 0) {
    return { ok: false };
  }

  const name = assignment.slice(0, separator).trim();
  if (!envNamePattern.test(name)) {
    return { ok: false };
  }

  const rawValue = assignment.slice(separator + 1).trim();
  const value = unquoteEnvValue(rawValue);
  if (value === null) {
    return { ok: false };
  }

  return { ok: true, name, value };
}

function unquoteEnvValue(value: string): string | null {
  if (!value) {
    return "";
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" || first === "'") && last !== first) {
    return null;
  }

  if (first === "\"" && last === "\"") {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  if (first === "'" && last === "'") {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, "");
}
