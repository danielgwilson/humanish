/**
 * The note for an instruction file Codex added from the operator's Codex home: the participant
 * also read it, so its persona may follow the operator's instructions.
 */
export function operatorInstructionsWarning(
  files: readonly string[] | undefined,
): string | undefined {
  if (files === undefined || files.length === 0) return undefined;
  return `Codex also gave this participant ${files.join(" and ")} from your Codex home (CODEX_HOME, or ~/.codex), as it does for every Codex thread. The participant may follow those instructions as well as its persona. humanish does not change that file.`;
}
