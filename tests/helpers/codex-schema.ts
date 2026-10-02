import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The trimmed Codex 0.160.0 app-server schema; scripts/codex-schema-fixture.ts writes it. */
export const CODEX_SCHEMA_FIXTURE = fileURLToPath(
  new URL("../fixtures/restricted-codex/app-server-schema", import.meta.url),
);

/** True for the launcher's `app-server generate-json-schema` spawn. */
export const isSchemaSpawn = (args: readonly string[]): boolean =>
  args[0] === "app-server" && args[1] === "generate-json-schema";

/** Writes the fixture schema where a `generate-json-schema --out` spawn would. */
export function writeCodexSchema(args: readonly string[]): void {
  cpSync(CODEX_SCHEMA_FIXTURE, args[args.indexOf("--out") + 1]!, { recursive: true });
}
