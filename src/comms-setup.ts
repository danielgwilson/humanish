import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { readCommsConnections } from "./comms-connections.js";
import { discoverProviderKeys } from "./key-resolution.js";
import { AgentMailReceivingError, createAgentMailReceiver } from "./comms-agentmail.js";
import type { ReceivingAdapter } from "./comms-receiving-types.js";
import { parseLabConfig } from "./lab-config.js";
import { resolveLabManifest } from "./labs.js";
import { assertPreparedSelectedOutputDirectory, prepareManagedHumanishOutputDirectory, prepareSelectedOutputDirectory, readContainedRegularFile, writeContainedOutputFile } from "./selected-output-paths.js";

export interface CommsCheckResult {
  schema: "humanish.comms-check.v1"; ok: boolean; connection: string; online: boolean;
  credentialPresent: boolean; authenticated: boolean | null; ready: boolean | null;
  permissions: "unknown"; capacity: "unknown"; checkedAt: string | null;
  code: string; message: string;
}
export async function checkCommsConnection(args: {
  cwd: string; connection?: string; env: NodeJS.ProcessEnv; online?: boolean;
  makeAdapter?: (apiKey: string) => ReceivingAdapter;
}): Promise<CommsCheckResult> {
  const base: CommsCheckResult = { schema: "humanish.comms-check.v1", ok: false,
    connection: args.connection ?? "agentmail", online: args.online === true,
    credentialPresent: false, authenticated: null, ready: null, permissions: "unknown", capacity: "unknown",
    checkedAt: null, code: "configuration_unavailable", message: "Could not read this email connection. Check Connections or .humanish/local/comms.yaml." };
  try {
    const connection = (await readCommsConnections(args.cwd)).connections[base.connection];
    if (!connection) return { ...base, ready: false, code: "connection_missing", message: "Save an AgentMail connection in Connections first." };
    const env = { ...args.env };
    await discoverProviderKeys({ cwd: args.cwd, env, announce: () => {} });
    const key = env[connection.apiKeyEnv]?.trim();
    if (!key) return { ...base, ready: false, code: "credential_missing", message: "The configured credential is missing. Add it in Connections or provide it with --env-file." };
    base.credentialPresent = true;
    if (!args.online) return { ...base, ok: true, code: "local_setup_present", message: "Connection and key are present. Authentication, permissions, capacity and delivery are not checked. Use --online for a read-only authentication check." };
    base.checkedAt = new Date().toISOString();
    const identity = await (args.makeAdapter ?? (apiKey => createAgentMailReceiver({ apiKey })))(key).authenticate({ timeoutMs: 8_000 });
    if (identity.scopeType !== "organization") return { ...base, ready: false, authenticated: true, code: "scope_unsupported", message: "Authenticated, but this release requires an organization-scoped key to acquire fresh inboxes." };
    return { ...base, ok: true, authenticated: true, code: "authenticated", message: "Authentication passed. Inbox permissions, available capacity and delivery remain untested; this check created no resources." };
  } catch (error) {
    const code = error instanceof AgentMailReceivingError ? error.code : "check_unavailable";
    const rejected = code === "agentmail_auth_rejected";
    return { ...base, code, ...(rejected ? { authenticated: false, ready: false } : {}),
      message: rejected ? "AgentMail rejected this credential or its permissions. Check the effective key source and replace it if needed. The saved key was kept."
        : "The connection check could not complete. The saved key was kept; retry when the provider is available." };
  }
}

export async function receivingRequiredKey(cwd: string, connectionName: string): Promise<string | null> {
  try { return (await readCommsConnections(cwd)).connections[connectionName]?.apiKeyEnv ?? null; }
  catch { return null; }
}

export interface CommsConfigureResult {
  schema: "humanish.comms-configure.v1"; ok: boolean; applied: boolean; message: string;
  path?: string; planToken?: string; connection?: string;
}
/** Save a local copy, never rewrite a committed manifest or silently shadow it by handle. */
export async function configureCommsLab(args: {
  cwd: string; lab: string; connection: string; apply?: boolean; planToken?: string;
}): Promise<CommsConfigureResult> {
  const base = { schema: "humanish.comms-configure.v1" as const, ok: false, applied: false };
  try {
    if (!(await readCommsConnections(args.cwd)).connections[args.connection]) return { ...base, message: "Save the selected connection first." };
    const source = await resolveLabManifest(args.cwd, args.lab);
    if (!source.ok) return { ...base, message: "The selected lab could not be read safely." };
    const root = await prepareSelectedOutputDirectory(args.cwd, args.cwd);
    const rel = path.relative(root.requestedPath, path.resolve(args.cwd, source.path)).replace(/\\/g, "/");
    const bytes = await readContainedRegularFile(root, rel);
    if (!bytes || bytes.length > 1024 * 1024) return { ...base, message: "The lab is missing or too large." };
    const raw: unknown = parse(bytes.toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base, message: "The lab must be a mapping." };
    const lab = raw as Record<string, unknown>;
    const existing = lab.comms as { email?: { connection?: string } } | undefined;
    if (existing?.email && existing.email.connection === undefined) return { ...base, message: "This lab uses local capture. Preserve it or make a separate lab before selecting real email." };
    lab.comms = { ...(existing ?? {}), email: { connection: args.connection } };
    const validated = parseLabConfig(lab);
    if (!validated.ok) return { ...base, message: "This lab does not support real email receiving. Use a hosted computer-use app-url, clone or local-tree route; shared-world must be concurrent." };
    const filename = path.basename(source.path).replace(/\.ya?ml$/, "").replace(/-receiving$/, "") + "-receiving.yaml";
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,110}\.yaml$/.test(filename)) return { ...base, message: "Use a simple lab filename before configuring email." };
    const destination = `.humanish/local/labs/${filename}`;
    let prior: Buffer | null;
    try { prior = await readContainedRegularFile(root, destination); } catch { return { ...base, message: "The local destination could not be read safely." }; }
    const content = stringify(lab);
    const token = createHash("sha256").update(bytes).update("\0").update(prior ?? "missing").update("\0").update(destination).update("\0").update(args.connection).digest("hex");
    const plan = { ...base, ok: true, path: destination, planToken: token, connection: args.connection,
      message: `Save ${destination} with fresh AgentMail inboxes. Email is hosted; actor and analysis models may see content. Recordings require local review and cannot be automatically published. Provider charges are separate. Launch this exact path.` };
    if (!args.apply) return plan;
    if (args.planToken !== undefined && args.planToken !== token) return { ...base, message: "The lab or destination changed since preview. Preview again before saving." };
    const directory = await prepareManagedHumanishOutputDirectory(args.cwd, "local", "labs");
    const lockPath = path.join(directory.physicalPath, ".comms-configure.lock");
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const identity = await lock.stat();
    try {
      const currentSource = await readContainedRegularFile(root, rel);
      const currentDestination = await readContainedRegularFile(root, destination);
      if (!currentSource?.equals(bytes) || (prior === null ? currentDestination !== null : !currentDestination?.equals(prior))) return { ...base, message: "Files changed while saving. Preview again." };
      await writeContainedOutputFile(directory, filename, content, "utf8");
    } finally {
      await lock.close();
      await assertPreparedSelectedOutputDirectory(directory);
      const current = await lstat(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
    }
    return { ...plan, applied: true, message: `Saved ${destination}. Start that exact lab path; the original manifest was preserved.` };
  } catch { return { ...base, message: "Could not configure this lab safely. Check configuration, paths and permissions; no provider resources were created." }; }
}
