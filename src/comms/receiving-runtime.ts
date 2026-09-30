import { registerTransientCommsSecrets } from "../run/transient-comms-secrets.js";
import type { LabConfig } from "../lab/types.js";
import { readCommsConnections, type CommsConnection } from "./connections.js";
import { discoverProviderKeys } from "../keys/key-resolution.js";
import { createAgentMailReceiver } from "./agentmail.js";
import { startCommsReceiving } from "./receiving.js";
import { renderReceivingInbox } from "./receiving-render.js";
import type { ReceivingAdapter } from "./receiving-types.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { writeContainedOutputFile } from "../run/contained-output.js";

/** The one place a connection's provider selects its adapter. */
export function createReceivingAdapter(
  connection: CommsConnection,
  apiKey: string,
): ReceivingAdapter {
  switch (connection.provider) {
    case "agentmail":
      return createAgentMailReceiver({ apiKey });
  }
}

/** Host-only resolution. The returned credential must never cross a desktop or UI boundary. */
export async function resolveReceivingConnection(
  cwd: string,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  connection: CommsConnection;
  apiKey: string;
  adapter: ReceivingAdapter;
}> {
  const connection = (await readCommsConnections(cwd)).connections[name];
  if (!connection)
    throw new Error(
      "Email connection is missing. Open Connections in the TUI or run humanish comms connections add.",
    );
  const resolved = { ...env };
  await discoverProviderKeys({ cwd, env: resolved, announce: () => {} });
  const apiKey = resolved[connection.apiKeyEnv]?.trim();
  if (!apiKey)
    throw new Error(
      "Email connection credential is missing. Add it in Connections, or provide the configured key with --env-file.",
    );
  return { connection, apiKey, adapter: createReceivingAdapter(connection, apiKey) };
}

export async function prepareReceivingRun(args: {
  cwd: string;
  runId: string;
  config: LabConfig;
  env: NodeJS.ProcessEnv;
  participants: string[];
  runPaths: PreparedRunArtifactPaths;
  registerSecrets(values: string[]): void;
}) {
  const email = args.config.comms?.email;
  if (email?.kind !== "real") return undefined;
  const resolved = await resolveReceivingConnection(args.cwd, email.connection, args.env);
  const registerSecrets = (values: string[]): void => {
    registerTransientCommsSecrets(values);
    args.registerSecrets(values);
  };
  registerSecrets([resolved.apiKey]);
  if (
    (args.config.subject.env ?? []).some(
      (name) => name === resolved.connection.apiKeyEnv || args.env[name]?.includes(resolved.apiKey),
    ) ||
    Object.entries(args.config.subject.envValues ?? {}).some(
      ([name, value]) =>
        name === resolved.connection.apiKeyEnv || String(value).includes(resolved.apiKey),
    )
  ) {
    throw new Error(
      "The inbox management credential cannot be forwarded through subject.env or subject.envValues. Use a separate target-app sending credential.",
    );
  }
  return startCommsReceiving({
    cwd: args.cwd,
    runId: args.runId,
    connectionName: email.connection,
    apiKeyEnv: resolved.connection.apiKeyEnv,
    adapter: resolved.adapter,
    participants: args.participants,
    registerSecrets,
    render: renderReceivingInbox,
    writeEvidence: (evidence) =>
      writeContainedOutputFile(
        args.runPaths,
        "comms/receiving.json",
        `${JSON.stringify(evidence, null, 2)}\n`,
        "utf8",
      ),
  });
}

/** The restriction survives restarts and screenshot redaction; it is not a claim of local processing. */
export function receivingPublication(config: LabConfig, dryRun: boolean) {
  return !dryRun && config.comms?.email?.kind === "real"
    ? { publication: { restrictions: ["real-communications"] as ["real-communications"] } }
    : {};
}
