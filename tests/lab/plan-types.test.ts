// Shapes the plan types must refuse to hold. Each `@ts-expect-error` fails typecheck if the line
// below it compiles, so `pnpm typecheck` is the assertion; the runtime test only keeps the file
// in the suite. Each shape is written through a typed variable as well as a literal, because
// TypeScript's excess-property check covers literals only.

import { describe, expect, it } from "vitest";

import type {
  ComputerUseParticipant,
  ExternalPublicSeat,
  ProvisionedSeat,
} from "../../src/lab/plan-participants.js";
import type {
  AppUrlSubject,
  ComputerUseRunner,
  ProvisionedSubject,
  SharedWorldPlane,
  TerminalPlan,
} from "../../src/lab/plan-types.js";
import type { LabSubjectServe } from "../../src/lab/types.js";

declare const participant: ComputerUseParticipant;
declare const provisionedSeat: ProvisionedSeat;
declare const externalSeat: ExternalPublicSeat;
declare const serve: LabSubjectServe;
declare const appUrl: AppUrlSubject;
declare const liveTerminal: Extract<TerminalPlan, { dryRun: false }>;

// Never called: the declared values above exist only for the type checker.
export function refusedShapes(): unknown[] {
  const openai = { kind: "openai", model: "m" } as const;
  const caller = { kind: "caller" } as const;
  const localApp = { kind: "local-app", appUrl: "http://127.0.0.1:3000/" } as const;
  const clone = { kind: "clone", repo: "a/b", serve, env: [] } as const;

  const localAppOnDesktop = {
    desktop: "e2b-desktop",
    brain: openai,
    participants: [participant],
    subject: localApp,
  } as const;
  const cloneOnLocalVm = {
    desktop: "local-vm",
    brain: openai,
    participants: [participant],
    subject: clone,
  } as const;
  const twoInProcess = {
    desktop: "in-process",
    brain: caller,
    participants: [participant, participant],
    subject: appUrl,
  } as const;
  const seatWithTasks = { ...provisionedSeat, tasks: [{ id: "t", goal: "g" }] };
  const externalWithEntry = { ...externalSeat, entry: "/x" };
  const cloneWithoutRepo = { kind: "clone", serve, env: [] } as const;
  const inProcessOpenai = {
    desktop: "in-process",
    brain: openai,
    participants: [participant],
    subject: appUrl,
  } as const;
  const terminalWithoutMinutes = { ...liveTerminal, caps: { maxUsd: 0 } };
  const oneSeat = {
    kind: "external-public",
    appUrl: "https://x/",
    owner: "o",
    participants: [externalSeat],
  } as const;

  return [
    // @ts-expect-error 1. local-app runs only in process
    localAppOnDesktop satisfies ComputerUseRunner,
    // @ts-expect-error 2. the local VM serves only an app-url subject
    cloneOnLocalVm satisfies ComputerUseRunner,
    // @ts-expect-error 3. in-process runs one participant
    twoInProcess satisfies ComputerUseRunner,
    // @ts-expect-error 4. only computer-use lanes carry tasks
    seatWithTasks satisfies ProvisionedSeat,
    // @ts-expect-error 4, as a literal
    { ...provisionedSeat, tasks: [] } satisfies ProvisionedSeat,
    // @ts-expect-error 5. external public seats open the public URL
    externalWithEntry satisfies ExternalPublicSeat,
    // @ts-expect-error 5, as a literal
    { ...externalSeat, entry: "/x" } satisfies ExternalPublicSeat,
    // @ts-expect-error 6. a provisioned clone names its repo
    cloneWithoutRepo satisfies ProvisionedSubject,
    // @ts-expect-error 8. in process, the caller's provider is the brain
    inProcessOpenai satisfies ComputerUseRunner,
    // @ts-expect-error 9. live terminal caps need maxMinutes
    terminalWithoutMinutes satisfies TerminalPlan,
    // @ts-expect-error 10. a shared world has at least two seats
    oneSeat satisfies SharedWorldPlane,
  ];
}

describe("plan types", () => {
  it("are checked by pnpm typecheck", () => {
    expect(typeof refusedShapes).toBe("function");
  });
});
