// Letting a study CREATE STUDIES: the narrowest credential grant that makes the end-to-end
// dogfood test possible, and nothing wider.
//
// THE TEST THIS EXISTS FOR: humanish is built on the premise that a coding agent sets it up for
// someone. We have proved the agent can install it, scaffold, run a dry study and report — but not
// that it can take someone all the way to a REAL study, because a live run needs an E2B key and
// the terminal lane deliberately ships no provider-credential channel at all.
//
// WHY THIS IS NOT JUST "SET allowProviderCredentials: true". That policy records intent; it grants
// nothing, on purpose. Handing an autonomous agent inside a sandbox a credential that spends money
// is the single most dangerous thing this codebase could do, and the existing contract presumes any
// injected key is exfiltratable. So the grant is built to bound the blast radius by CONSTRUCTION
// rather than by trust:
//
//   1. A DISTINCT variable. The grant reads HUMANISH_NESTED_E2B_API_KEY, never E2B_API_KEY, so no
//      operator can make this happen by having the usual variable exported.
//   2. It must NOT be the operator's own key. E2B scopes keys to a project, and every sandbox is
//      created and billed within the project its key belongs to. Refusing a matching value forces
//      a SEPARATE project, which is what makes "bounded" true rather than hopeful.
//   3. Command-scoped injection only, exactly like the runtime LLM key — never Sandbox.create envs.
//   4. A sweep afterwards, scoped to that same key, which can therefore only see and kill what the
//      grant made. What it killed is recorded.
//
// The operator still has to do the one thing only they can: create the project and set a spending
// limit on it (E2B exposes budgets and project creation in the console, with no API for either).
//
// WHERE THIS SHOULD GO NEXT. E2B ships two better channels that we cannot use yet or have not
// verified: workload identity (short-lived audience-scoped tokens -- the OWASP ASI03 baseline
// control, private beta), and per-host egress request transforms (public beta) which would attach
// the credential at the proxy so the key never exists inside the sandbox at all. Rationale and
// sequencing in docs/contracts/nested-sandbox-grant.md.

/** The ONLY variable this grant reads. Deliberately not E2B_API_KEY. */
export const NESTED_KEY_NAME = "HUMANISH_NESTED_E2B_API_KEY";

/** What the granted study receives, under the name its own tooling expects. */
export const NESTED_INJECTED_NAME = "E2B_API_KEY";

export type NestedGrantFailure =
  | { ok: false; code: "HUMANISH_NESTED_GRANT_MISSING"; message: string }
  | { ok: false; code: "HUMANISH_NESTED_GRANT_NOT_SCOPED"; message: string };

export type NestedGrantResult =
  | { ok: true; envs: Record<string, string>; keyName: string }
  | NestedGrantFailure;

/**
 * Resolve the grant, or refuse with a reason the operator can act on.
 *
 * `operatorKey` is the operator's own E2B key — the one humanish itself is using to run this
 * study. If the grant equals it, the nested study would create sandboxes in the SAME project and
 * bill against the same budget as everything else the operator does, which is precisely the bound
 * this feature claims to provide. Refusing is the whole point.
 */
export function resolveNestedSandboxGrant(args: {
  env: NodeJS.ProcessEnv;
  operatorKey: string;
}): NestedGrantResult {
  const granted = (args.env[NESTED_KEY_NAME] ?? "").trim();
  if (granted.length === 0) {
    return {
      ok: false,
      code: "HUMANISH_NESTED_GRANT_MISSING",
      message:
        `This lab lets its participant create studies of its own, which needs ${NESTED_KEY_NAME}. `
        + "Set it to an E2B key from a SEPARATE project with a spending limit — never your usual "
        + "key. Every sandbox E2B creates is billed to the project its key belongs to, and that "
        + "separation is what bounds what an autonomous agent can spend."
    };
  }
  const operator = args.operatorKey.trim();
  if (operator.length > 0 && granted === operator) {
    return {
      ok: false,
      code: "HUMANISH_NESTED_GRANT_NOT_SCOPED",
      message:
        `${NESTED_KEY_NAME} is the same key humanish is already using. That would put the `
        + "participant's sandboxes in your own project, against your own budget, with no bound on "
        + "what it can spend. Create a separate E2B project, set a spending limit on it, and use "
        + "that project's key here."
    };
  }
  return { ok: true, keyName: NESTED_KEY_NAME, envs: { [NESTED_INJECTED_NAME]: granted } };
}

export interface NestedSweepResult {
  /** How many sandboxes the grant's project still had running when the study ended. */
  found: number;
  /** How many of those were killed. */
  killed: number;
  /** Present when the sweep itself could not run; the run records the gap rather than hiding it. */
  error?: string;
}

export interface SandboxLister {
  /** apiKey is REQUIRED, not optional as in the SDK: E2B falls back to process.env.E2B_API_KEY
   *  when it is absent, which would point this sweep at the OPERATOR's project and kill sandboxes
   *  the grant never made. The whole safety argument rests on this one argument being present. */
  list(options: { apiKey: string }): { nextItems(): Promise<unknown[]> };
  connect(id: string, options: { apiKey: string }): Promise<{ kill(): Promise<unknown> }>;
}

/**
 * Kill everything the granted key can still see.
 *
 * Scoped by construction: an E2B key sees only its own project, so this can only reach sandboxes
 * the grant itself made. A grant without a sweep would be an unbounded lease — the agent finishes,
 * its sandboxes keep running, and the budget drains after nobody is watching.
 */
export async function sweepNestedSandboxes(args: {
  apiKey: string;
  lister: SandboxLister;
}): Promise<NestedSweepResult> {
  const apiKey = args.apiKey.trim();
  if (apiKey.length === 0) {
    // Fail closed rather than sweep: with no key the SDK reads process.env.E2B_API_KEY and this
    // becomes an account-wide kill against the operator's own project.
    return { found: 0, killed: 0, error: "refused to sweep: no granted key to scope the sweep to" };
  }
  try {
    const items = await args.lister.list({ apiKey }).nextItems();
    let killed = 0;
    for (const item of items) {
      const id = (item as { sandboxId?: string }).sandboxId;
      if (typeof id !== "string" || id.length === 0) continue;
      try {
        const sandbox = await args.lister.connect(id, { apiKey });
        await sandbox.kill();
        killed += 1;
      } catch {
        // Counted as found-but-not-killed rather than silently dropped.
      }
    }
    return { found: items.length, killed };
  } catch (error) {
    return { found: 0, killed: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PROVE the grant is in a different project than the operator, rather than assuming it.
 *
 * Comparing key VALUES (above) catches the obvious mistake, but not the subtle one: two different
 * keys can belong to the SAME project, in which case the "separate budget" bound this feature
 * claims does not exist. E2B scopes every key to exactly one project and a key can only list its
 * own project's sandboxes, so there is a direct test — if the granted key can see the sandbox the
 * operator just created, the two keys share a project.
 *
 * OWASP ASI03:2026 (Identity & Privilege Abuse) makes per-agent identity with task-scoped
 * credentials the baseline control, and ASI08 prescribes strict environment separation to stop
 * cascading failures. E2B ships no short-lived-token flow, so a separate project is the strongest
 * boundary available here; this check is what turns it from a claim into a verified precondition.
 * Runs BEFORE the credential is injected, and fails closed on violation.
 */
export async function verifyNestedGrantIsolation(args: {
  apiKey: string;
  operatorSandboxId: string;
  lister: Pick<SandboxLister, "list">;
}): Promise<{ isolated: true } | { isolated: false; reason: string }> {
  const apiKey = args.apiKey.trim();
  if (apiKey.length === 0) return { isolated: false, reason: "no granted key to verify" };
  let visible: unknown[];
  try {
    visible = await args.lister.list({ apiKey }).nextItems();
  } catch (error) {
    // An unverifiable grant is a refused grant: this is the only bound we have.
    return {
      isolated: false,
      reason: `could not verify project isolation: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const sharesProject = visible.some(
    (item) => (item as { sandboxId?: string }).sandboxId === args.operatorSandboxId
  );
  if (sharesProject) {
    return {
      isolated: false,
      reason:
        `${NESTED_KEY_NAME} can see this run's own sandbox, so it belongs to the SAME E2B project `
        + "as the operator key. Different key values are not enough — the project is the billing "
        + "and resource boundary. Create a separate project, set a spending limit on it, and use a "
        + "key from that project."
    };
  }
  return { isolated: true };
}
