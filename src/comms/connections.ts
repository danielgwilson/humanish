import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import {
  COMMS_PROVIDERS,
  DEFAULT_COMMS_PROVIDER,
  isReceivingProviderId,
  type ReceivingProviderId,
} from "./providers.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile,
} from "../run/selected-output-paths.js";

const COMMS_CONNECTIONS_SCHEMA = "humanish.comms-connections.v1";
export const COMMS_CONFIG_PATH = ".humanish/local/comms.yaml";
export { COMMS_PROVIDERS };
export interface CommsConnection {
  provider: ReceivingProviderId;
  apiKeyEnv: string;
}
export interface CommsConnections {
  schema: typeof COMMS_CONNECTIONS_SCHEMA;
  connections: Record<string, CommsConnection>;
}
export interface CommsSetupResult {
  ok: boolean;
  message: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validName = (name: string): boolean =>
  /^[a-z][a-z0-9-]{0,47}$/.test(name) && name !== "constructor" && name !== "prototype";
const empty = (): CommsConnections => ({ schema: COMMS_CONNECTIONS_SCHEMA, connections: {} });

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseConnections(raw: unknown): CommsConnections {
  if (
    !record(raw) ||
    raw.schema !== COMMS_CONNECTIONS_SCHEMA ||
    !record(raw.connections) ||
    Object.keys(raw).some((key) => key !== "schema" && key !== "connections") ||
    Object.keys(raw.connections).length > 32
  )
    throw new Error("Invalid connection configuration.");
  const connections: Record<string, CommsConnection> = {};
  for (const [name, value] of Object.entries(raw.connections)) {
    if (
      !validName(name) ||
      !record(value) ||
      !isReceivingProviderId(value.provider) ||
      typeof value.apiKeyEnv !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.apiKeyEnv) ||
      Object.keys(value).some((key) => key !== "provider" && key !== "apiKeyEnv")
    )
      throw new Error("Invalid connection configuration.");
    connections[name] = { provider: value.provider, apiKeyEnv: value.apiKeyEnv };
  }
  return { schema: COMMS_CONNECTIONS_SCHEMA, connections };
}

/** Offline and non-mutating. Unsafe storage is an error, never an empty configuration. */
export async function readCommsConnections(cwd: string): Promise<CommsConnections> {
  const root = await bindExistingManagedHumanishOutputDirectory(cwd, "local");
  if (!root) {
    if (await exists(path.resolve(cwd, ".humanish", "local")))
      throw new Error("Unsafe connection directory.");
    return empty();
  }
  const file = path.join(root.physicalPath, "comms.yaml");
  if (!(await exists(file))) return empty();
  if ((await lstat(file)).size > 65_536) throw new Error("Connection configuration is too large.");
  const bytes = await readContainedRegularFile(root, "comms.yaml");
  if (!bytes || bytes.length > 65_536)
    throw new Error("Cannot safely read connection configuration.");
  // YAML diagnostics may echo the offending value; do not let them reach a status or frame.
  try {
    return parseConnections(parse(bytes.toString("utf8"), { maxAliasCount: 0 }));
  } catch {
    throw new Error("Invalid connection configuration.");
  }
}

/** Add one exact profile. No lab mutation, network, provider resources or credential values. */
export async function saveCommsConnection(
  cwd: string,
  name: string = DEFAULT_COMMS_PROVIDER.id,
  apiKeyEnv: string = DEFAULT_COMMS_PROVIDER.keyEnv,
): Promise<CommsSetupResult> {
  const provider = DEFAULT_COMMS_PROVIDER.id;
  try {
    parseConnections({
      schema: COMMS_CONNECTIONS_SCHEMA,
      connections: { [name]: { provider, apiKeyEnv } },
    });
    // Read before creating storage, so malformed or redirected existing configuration fails first.
    await readCommsConnections(cwd);
    const root = await prepareManagedHumanishOutputDirectory(cwd, "local");
    const lockPath = path.join(root.physicalPath, ".comms-setup.lock");
    const lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const identity = await lock.stat();
    try {
      await assertPreparedSelectedOutputDirectory(root);
      const config = await readCommsConnections(cwd);
      const previous = config.connections[name];
      if (previous && (previous.provider !== provider || previous.apiKeyEnv !== apiKeyEnv)) {
        return {
          ok: false,
          message: "That connection name already uses different settings. Choose another name.",
        };
      }
      config.connections[name] = { provider, apiKeyEnv };
      parseConnections(config);
      await writeContainedOutputFile(root, "comms.yaml", stringify(config), "utf8");
      return {
        ok: true,
        message:
          "Connection saved for this project. Select it in a supported lab to use fresh real inboxes.",
      };
    } finally {
      await lock.close();
      await assertPreparedSelectedOutputDirectory(root);
      const current = await lstat(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
    }
  } catch (error) {
    return {
      ok: false,
      message:
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "Connection setup is locked. Close another setup session; after an interrupted save, remove .humanish/local/.comms-setup.lock and retry."
          : "Could not save the connection. Inspect .humanish/local/comms.yaml and its directory permissions before retrying.",
    };
  }
}
