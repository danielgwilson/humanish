// The prompt one computer-use participant reads: persona, device and surface lines, the mission,
// the task goals, the per-participant focus and the closing-line directive. withInboxMission adds
// the email inbox at run time. Shared by the computer-use and concurrent shared-world routes.

import type { ActorPersonaRef } from "../../actors/contract.js";
import { recipientInboxUrl } from "../../comms/capture-surface.js";
import { digestText } from "../../evidence/redaction.js";
import type { DevicePreset } from "../../study/device-presets.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
  type ResolvedPersona,
} from "../../study/persona.js";
import { renderTaskPrompt, type StudyTask } from "../../study/tasks.js";
import type { DesktopParticipantRun } from "./types.js";

export const DEFAULT_MISSION =
  "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.";

/**
 * The participant's outcome as one fixed first line of its last message. The
 * free-text computer-use provider has no schema to fill; a fixed line is the next best thing, and
 * the loop reads it into the trace's declaredOutcome. Prompt-only control is weak in general, so
 * adherence is measured (declaredOutcome present or absent on the trace) and the regex over the
 * paragraph stays as the fallback when the line is missing. This is a report format, deliberately
 * not a behavioural instruction: it says how to label the ending, never how to act.
 */
export const CLOSING_LINE_DIRECTIVE =
  "When you stop, make the FIRST line of your last message exactly one of these three, on its own line: " +
  "REACHED THE GOAL. / DID NOT REACH THE GOAL. / BLOCKED. " +
  "Then, from the next line, say what you did, what confused you, and where you hesitated.";

/** The persona id a computer-use participant gets when neither it nor its actor names one. */
export const FALLBACK_PERSONA_ID = "cua-operator";

/** Compose one participant's actor prompt: persona line + device line + mission + per-participant
 *  steer. At N=1 (homogeneous, no roster) this reproduces the prior composeInstructions byte-for-byte. */
export function composeParticipantInstructions(args: {
  mission: string;
  persona?: string;
  instruction?: string;
  /** The lab's declared protocol. Only the participant-facing `goal` halves are rendered
   *  into the prompt; the `success` criteria never appear here. */
  tasks?: readonly StudyTask[];
  device: { name: string; preset: DevicePreset };
  /** The compiled persona for `args.persona`, when its committed file resolved. Supplying it
   *  makes the persona shape behavior: its traits become directives in the prompt and land in
   *  traitsApplied, instead of appearing as a bare `Persona: <id>.` label. Absent (unsafe id,
   *  no committed file, unparseable YAML) keeps the fallback: the bare line and an empty
   *  traitsApplied, never fabricated traits. Resolved by the caller so this stays pure. */
  resolvedPersona?: ResolvedPersona;
  /**
   * desktop-cli: the surface under study is a terminal window, not a page. Said plainly
   * because a participant whose every prior world was a browser will look for one, and because a
   * capability nobody declares is one the recording cannot later be read against. It states that a
   * terminal is open and does not say what to type in it: naming commands would answer the question the
   * study is asking.
   */
  surface?: "desktop-cli";
}): { instructions: string; persona: ActorPersonaRef } {
  const { name, preset } = args.device;
  const deviceLine = preset.isMobile
    ? `You are a mobile user on a ${name} device (${preset.width}x${preset.height} @${preset.deviceScaleFactor}x). Expect a mobile/touch layout.`
    : `You are a desktop user (${name}, ${preset.width}x${preset.height}).`;
  // The protocol as the participant reads it: numbered goals, nothing else. The success criteria
  // are the researcher's instrument and must never reach this prompt: a persona told how it will
  // be measured optimizes for the measurement instead of using the product (src/study/tasks.ts).
  const taskLines = renderTaskPrompt(args.tasks ?? []);
  // A resolved persona contributes its compiled directives (friction tolerance, skill bias,
  // accessibility behavior, constraints) through the same persona.ts compiler the terminal route
  // uses, so one persona file means one behavior across every route.
  const personaLine = args.resolvedPersona
    ? renderPersonaPromptSection(args.resolvedPersona)
    : args.persona
      ? `Persona: ${args.persona}.`
      : undefined;
  const traitsApplied = args.resolvedPersona
    ? personaToDirectives(args.resolvedPersona).traitsApplied
    : [];
  const surfaceLine =
    args.surface === "desktop-cli"
      ? "A terminal window is already open on this desktop, and there is a terminal in the dock at the bottom of the screen if you want another. Everything you need is on this machine; there is no browser task here."
      : undefined;
  const parts = [
    personaLine,
    deviceLine,
    surfaceLine,
    args.mission,
    taskLines,
    args.instruction ? `Lane focus: ${args.instruction}` : undefined,
    CLOSING_LINE_DIRECTIVE,
  ].filter((part): part is string => Boolean(part));
  const instructions = parts.join("\n\n");
  return {
    instructions,
    persona: {
      id: args.persona ?? FALLBACK_PERSONA_ID,
      traitsApplied,
      ...(args.resolvedPersona ? { brief: personaBrief(args.resolvedPersona) } : {}),
      promptDigest: digestText(instructions, 16),
    },
  };
}

/** Runtime-inject the persona inbox instruction into a participant's prompt. The inbox URL is a
 *  runtime loopback/getHost address (not secret), so, mirroring the lobby-code runtime injection, this
 *  augments only the instructions the model receives; the authored prompt + its digest are unchanged.
 *  Returns a new spec (never mutates). Shared by the CUA + concurrent shared-world routes. */
export function withInboxMission(
  spec: DesktopParticipantRun,
  inboxUrl: string,
  address?: string,
  receiving = false,
): DesktopParticipantRun {
  // No assigned identity means no participant inbox; never fall back to the shared operator view.
  if (!address?.trim()) return spec;
  // Captured mail is routed to the assigned identity. Supply that identity and inbox
  // access without requiring the participant to wait or complete the email flow.
  const identity = ` Your email address is ${address} — when the app asks for an email address, enter exactly that.`;
  if (receiving)
    return {
      ...spec,
      instructions: `${spec.instructions}\n\nEmail inbox:${identity} This is a fresh test identity; it does not replace an existing account's email address. When the app says it sent email, open ${inboxUrl} to check your inbox. Delivery may take a little time. Decide whether to wait or continue based on your situation. Report what you observe if mail is missing or unavailable. The inbox may block remote images or undeclared destinations; those are harness limitations.`,
    };
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nEmail inbox:${identity} Your inbox is available at ${recipientInboxUrl(inboxUrl, address)} in the browser. It contains captured email addressed to your test identity. Delivery may take a little time. Decide whether to check it, wait or stop based on your situation and what you observe.`,
  };
}
