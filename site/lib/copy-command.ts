export type CopyOutcome = "success" | "failure";
export type CopyEvent = "install_copy_success" | "install_copy_failure";

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** Copy feedback follows the browser result; analytics cannot change that result. */
export async function copyCommand(
  text: string,
  clipboard: ClipboardWriter | undefined,
  report: (event: CopyEvent) => void
): Promise<CopyOutcome> {
  let outcome: CopyOutcome = "failure";
  try {
    if (clipboard) {
      await clipboard.writeText(text);
      outcome = "success";
    }
  } catch {
    // Permission denial, missing API and synchronous browser errors need manual copying.
  }

  try {
    // Fixed event names only: never send the copied command or browser error details.
    report(outcome === "success" ? "install_copy_success" : "install_copy_failure");
  } catch {
    // An unavailable analytics script must not turn a successful copy into a failure.
  }
  return outcome;
}
