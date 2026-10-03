import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  probeKeySources,
  type KeyResolutionDeps,
  type KeySourceProbe,
} from "../keys/key-resolution.js";
import { nodeSupportsTui, terminalSurfaceMessage, TUI_BUNDLE_URL } from "../tui/contract.js";
import {
  detectLocalAgents,
  localAgentDoctorMessage,
  NO_LOCAL_AGENT_MESSAGE,
  type DetectedLocalAgent,
  type DetectLocalAgentsOptions,
} from "../actors/local-agent/cli.js";
import {
  studySetupChecks,
  studiesByRequiredKey,
  type StudySetupCheckArgs,
} from "../study/doctor.js";
import {
  prepareSelectedOutputDirectory,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";
import {
  implicitProjectDirectoryExists,
  readImplicitProjectFile,
  validateCwd,
} from "../run/project.js";

const DOCTOR_SCHEMA = "humanish.doctor-result.v1";

/**
 * A row's verdict, as the human output prints it. A "note" is advisory: it never fails the run, so
 * its `ok` is true. "not_checked" goes with `checked: false`.
 */
type DoctorStatus = "ok" | "missing" | "not_checked" | "note";

export interface DoctorResult {
  schema: typeof DOCTOR_SCHEMA;
  ok: boolean;
  cwd: string;
  checks: Array<{
    name: string;
    ok: boolean;
    status: DoctorStatus;
    message: string;
    /**
     * Additive + optional. `false` means the check never ran: the directory could not be read, so
     * there is nothing to report about it either way. Absent means it ran and `ok` is its verdict.
     *
     * It exists so a failed check and an unrun one render differently. Without it an unrun row
     * shows the success text, such as `missing package.json: package.json is present and safe to
     * read` (labs/tui-self-study.yaml).
     */
    checked?: boolean;
  }>;
}

/**
 * Version 2.3.1 stopped holding a launched background command's event stream open. Version 2.3.2
 * also requires an e2b release whose background command handle supports sendStdin and closeStdin,
 * which the optional speech transport needs. On older releases the CLI could stay alive minutes
 * past a written result (measured 2026-09-04 on 2.2.3: twelve minutes).
 */
export const DESKTOP_SDK_FLOOR = "2.3.2";

/** The advisory `doctor` attaches to an installed desktop SDK older than the floor, else undefined. */
export function desktopSdkAdvisory(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const parse = (value: string): number[] =>
    value
      .split(".")
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  const floor = parse(DESKTOP_SDK_FLOOR);
  if (have.length < 3 || have.some((part) => !Number.isFinite(part))) return undefined;
  const older =
    have[0]! < floor[0]! ||
    (have[0] === floor[0] &&
      (have[1]! < floor[1]! || (have[1] === floor[1] && have[2]! < floor[2]!)));
  return older
    ? `@e2b/desktop ${version} is older than ${DESKTOP_SDK_FLOOR}, the supported floor for background command cleanup and stdin handles (older releases could keep the CLI alive for minutes after its result). Update with \`npm i -D @e2b/desktop@latest\`.`
    : undefined;
}

/** The version of the @e2b/desktop that `import("@e2b/desktop")` resolves to from here, if readable. */
async function installedDesktopSdkVersion(): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const manifest = createRequire(import.meta.url).resolve("@e2b/desktop/package.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** A row as a check writes it. Doctor derives `status`; an advisory row sets "note" itself. */
export type DoctorCheckDraft = Omit<DoctorResult["checks"][number], "status"> & {
  status?: "note";
};
type DoctorCheck = DoctorCheckDraft;
type StudySetup = Awaited<ReturnType<typeof studySetupChecks>>;

export async function doctor(
  cwdInput: string,
  options: {
    lab?: string;
    env?: NodeJS.ProcessEnv;
    localAgents?: DetectLocalAgentsOptions;
    /** Where the key probe looks for vendor stores; tests point it at a temp home. */
    keyDeps?: KeyResolutionDeps;
    /** The hosted Codex participant's operator handshake; tests replace it. */
    codexParticipantReadiness?: StudySetupCheckArgs["codexParticipantReadiness"];
  } = {},
): Promise<DoctorResult> {
  const cwd = path.resolve(cwdInput);
  const cwdOk = await validateCwd(cwd)
    .then((error) => error === null)
    .catch(() => false);
  if (!cwdOk) {
    const checks = uncheckedProjectChecks(
      "this directory does not exist, or humanish cannot read it",
      "not checked: the target directory could not be read",
    );
    return { schema: DOCTOR_SCHEMA, ok: false, cwd, checks: withStatus(checks) };
  }

  let projectRoot: PreparedSelectedOutputDirectory;
  try {
    projectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
  } catch {
    const checks = uncheckedProjectChecks(
      "target directory failed containment validation",
      "not checked: the containment check failed first",
    );
    return { schema: DOCTOR_SCHEMA, ok: false, cwd, checks: withStatus(checks) };
  }

  const env = options.env ?? process.env;
  const agents = await detectLocalAgents({ ...options.localAgents, env });
  const { probes, receivingKey } = await probeDoctorKeys(cwd, env, options.lab, options.keyDeps);
  const keyPresent = (name: string) =>
    probes.some((probe) => probe.name === name && probe.source !== null);
  const setup = options.lab
    ? await studySetupChecks({
        cwd,
        lab: options.lab,
        env,
        agents,
        keyPresent,
        ...(options.codexParticipantReadiness === undefined
          ? {}
          : { codexParticipantReadiness: options.codexParticipantReadiness }),
      })
    : undefined;
  // Without --lab, each key row names the labs that need it instead of failing.
  const keyUsers = setup ? undefined : await studiesByRequiredKey(cwd, keyPresent);
  const checks: DoctorCheck[] = [
    ...(await projectChecks(projectRoot)),
    await desktopSdkCheck(setup),
    terminalSurfaceCheck(),
    ...localAgentChecks(agents),
    ...keyChecks(probes, receivingKey, setup, keyUsers),
    ...(setup?.checks ?? [
      {
        name: "setup route",
        ok: true,
        message:
          "General capabilities only. Use humanish doctor --study <study> for the selected participant's requirements and separate analysis readiness.",
      },
    ]),
  ];

  return {
    schema: DOCTOR_SCHEMA,
    ok: checks.every((check) => check.ok),
    cwd,
    checks: withStatus(checks),
  };
}

function withStatus(checks: readonly DoctorCheck[]): DoctorResult["checks"] {
  return checks.map((check) => ({
    ...check,
    status: check.ok ? (check.status ?? "ok") : check.checked === false ? "not_checked" : "missing",
  }));
}

/** The rows for a target directory doctor could not open: the failure, then three unrun checks. */
function uncheckedProjectChecks(targetMessage: string, reason: string): DoctorCheck[] {
  return [
    { name: "target cwd", ok: false, message: targetMessage },
    { name: "package.json", ok: false, checked: false, message: reason },
    { name: "humanish source", ok: false, checked: false, message: reason },
    { name: "runtime ignore", ok: false, checked: false, message: reason },
  ];
}

async function safeCheck(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

/** The target directory, its package.json, the humanish/ source and the .humanish/ ignore rule. */
async function projectChecks(projectRoot: PreparedSelectedOutputDirectory): Promise<DoctorCheck[]> {
  return [
    {
      name: "target cwd",
      ok: true,
      message: "target directory exists",
    },
    await (async () => {
      try {
        const contents = await readImplicitProjectFile(projectRoot, "package.json");
        return {
          name: "package.json",
          ok: true,
          message:
            contents === null
              ? "package.json is absent; it is optional for humanish, so npm-script integration is skipped"
              : "package.json is present and safe to read",
        };
      } catch {
        return {
          name: "package.json",
          ok: false,
          message: "package.json could not be safely read",
        };
      }
    })(),
    await sourceCheck(projectRoot),
    await runtimeIgnoreCheck(projectRoot),
  ];
}

// Each row says what it found, and a failing one names the command that fixes it.
async function sourceCheck(projectRoot: PreparedSelectedOutputDirectory) {
  const ok = await safeCheck(() => implicitProjectDirectoryExists(projectRoot, "humanish"));
  return {
    name: "humanish source",
    ok,
    message: ok
      ? "committed humanish/ source directory is present and safe to read"
      : "no readable humanish/ source directory; run humanish init --yes",
  };
}

async function runtimeIgnoreCheck(projectRoot: PreparedSelectedOutputDirectory) {
  const ok = await safeCheck(
    async () =>
      (await readImplicitProjectFile(projectRoot, ".gitignore"))?.includes(".humanish/") ?? false,
  );
  return {
    name: "runtime ignore",
    ok,
    message: ok
      ? ".gitignore lists .humanish/"
      : ".gitignore does not list .humanish/; run humanish init --yes",
  };
}

/**
 * The optional peer dep every live browser and terminal route needs. `npx -y humanish` does not
 * pull optional peers, so without this check an adopter's first live run fails on it, safely and at
 * $0, but as a burned first impression on the flagship path. Answering it here means the readiness
 * command actually answers readiness.
 */
async function desktopSdkCheck(setup: StudySetup | undefined): Promise<DoctorCheck> {
  const present = await safeCheck(async () => {
    try {
      await import("@e2b/desktop");
      return true;
    } catch {
      return false;
    }
  });
  const version = present ? await installedDesktopSdkVersion() : undefined;
  const advisory = desktopSdkAdvisory(version);
  // Without --lab nothing selects a desktop route yet, so an absent SDK is advisory.
  const advisoryOnly = !present && setup === undefined;
  return {
    name: "e2b desktop sdk",
    ok: present || advisoryOnly || setup?.desktop === false,
    ...(advisoryOnly ? { status: "note" as const } : {}),
    message: present
      ? `optional peer @e2b/desktop ${version ?? "(version unread)"} is installed; provider access is not tested${advisory === undefined ? "" : `. ${advisory}`}`
      : setup?.desktop === false
        ? "optional peer @e2b/desktop is absent; not required by the selected route"
        : "optional peer @e2b/desktop is not installed: dry runs work, but a live run with a desktop participant fails when it starts. Install it with `npm i -D @e2b/desktop`.",
  };
}

/**
 * The stakeholder surface. Reported as capability, never as a gate: the TUI is optional,
 * and `doctor` is itself mostly run by agents through a pipe, where a TTY requirement says
 * nothing about whether the project is ready. So this row is always ok.
 *
 * Who is reading decides the wording, and a real first-contact study
 * (labs/first-contact.yaml) is why. An agent evaluating humanish read
 * "`humanish tui` is available in an interactive terminal", correctly concluded it was not in
 * one, and dropped it, then wrote a report for a human that never mentioned the human
 * surface at all. Discovery worked; handoff did not. A capability described to a reader who
 * cannot use it has to be phrased as something to pass on, or it reads as "not for you" and
 * dies there.
 */
function terminalSurfaceCheck(): DoctorCheck {
  const supported = nodeSupportsTui();
  const bundlePresent = existsSync(TUI_BUNDLE_URL);
  return {
    name: "terminal surface",
    ok: true,
    ...(supported && bundlePresent ? {} : { status: "note" as const }),
    message: terminalSurfaceMessage({
      supported,
      bundlePresent,
      interactive: process.stdout.isTTY === true,
      nodeVersion: process.version,
    }),
  };
}

/** Probes the live-run keys, plus the receiving-email key a real-comms lab names. */
async function probeDoctorKeys(
  cwd: string,
  env: NodeJS.ProcessEnv,
  lab: string | undefined,
  keyDeps: KeyResolutionDeps | undefined,
): Promise<{ probes: KeySourceProbe[]; receivingKey: string | null }> {
  const keyNames = new Set(["OPENAI_API_KEY", "E2B_API_KEY", "GH_TOKEN", "CODEX_API_KEY"]);
  let receivingKey: string | null = null;
  if (lab) {
    const { resolveStudyManifest } = await import("../study/discover.js");
    const resolved = await resolveStudyManifest(cwd, lab);
    if (resolved.ok && resolved.config.comms?.email?.kind === "real") {
      const { receivingRequiredKey } = await import("../comms/setup.js");
      receivingKey = await receivingRequiredKey(cwd, resolved.config.comms.email.connection);
      if (receivingKey) keyNames.add(receivingKey);
    }
  }
  const probes = await probeKeySources([...keyNames], {
    cwd,
    env,
    ...(keyDeps === undefined ? {} : { deps: keyDeps }),
  });
  return { probes, receivingKey };
}

/**
 * The operator's own coding agents, one row each, reported as a capability and never a gate: a
 * machine with none is not broken, it just needs a provider key. These rows exist because "go make
 * an API key" is where most people trying humanish stop, and a developer very often already has one
 * of these signed in. An agent that is installed but not signed in is a note.
 */
function localAgentChecks(agents: readonly DetectedLocalAgent[]): DoctorCheck[] {
  if (agents.length === 0)
    return [{ name: "local agents", ok: true, message: NO_LOCAL_AGENT_MESSAGE }];
  return agents.map((agent) => ({
    name: `local agent ${agent.bin}`,
    ok: true,
    ...(agent.authStatus === "authenticated" ? {} : { status: "note" as const }),
    message: localAgentDoctorMessage(agent),
  }));
}

/** "try-live", "try-live and local-browser", "a, b and c". */
function studyList(studies: readonly string[]): string {
  return studies.length < 2
    ? studies.join("")
    : `${studies.slice(0, -1).join(", ")} and ${studies.at(-1)}`;
}

/**
 * Provider-key discovery: which source supplies each live-run key, through the same
 * chain a live command resolves (env/--env-file, project overlay, vendor stores, the
 * humanish user store). Values never appear; sources and fill commands do.
 *
 * With --lab, a key the selected route requires fails when missing. Without it, `keyUsers` maps
 * each key to the project's labs that need it, and a key row never fails: a missing key one of
 * them needs is a note.
 */
function keyChecks(
  probes: readonly KeySourceProbe[],
  receivingKey: string | null,
  setup: StudySetup | undefined,
  keyUsers: ReadonlyMap<string, readonly string[]> | undefined,
): DoctorCheck[] {
  return probes.map((probe) => {
    const present = probe.source !== null;
    const hint =
      probe.name === receivingKey
        ? `provide ${probe.name} through process env or --env-file`
        : probe.hint;
    if (!setup) {
      const users = keyUsers?.get(probe.name) ?? [];
      const usedBy = users.length > 0 ? `used by ${studyList(users)}` : undefined;
      return {
        name: `key ${probe.name}`,
        ok: true,
        ...(present || usedBy === undefined ? {} : { status: "note" as const }),
        message: present
          ? `supplied by ${probe.source}; presence only, validity not tested${usedBy ? `; ${usedBy}` : ""}`
          : `missing; ${usedBy ?? "not used by any lab in this project"}; ${hint}`,
      };
    }
    // GH_TOKEN is needed only for private clone subjects, so its absence is informational.
    const required = setup.keys.includes(probe.name);
    // A key the lab is known not to read says so, so a present but unused key does not read as
    // one the run will use.
    const unused = setup.reads !== undefined && !setup.reads.has(probe.name);
    return {
      name: `key ${probe.name}`,
      ok: present || !required,
      message: present
        ? unused
          ? `present (${probe.source}), not used by this lab`
          : `supplied by ${probe.source}; presence only, validity not tested`
        : required
          ? `missing from every source; ${hint}`
          : `not required for the selected participant route; ${hint}`,
    };
  });
}
