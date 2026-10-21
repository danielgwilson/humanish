// Links the participant's browser hands to another app (mailto:, tel:, sms:) on a hosted desktop.
//
// Chrome on Linux opens such a link by running `xdg-email` (mailto) or `xdg-open` (the rest) by
// name, unless an XDG desktop portal answers on the session bus; the stock desktop runs none.
// The stock desktop has no mail, phone or messaging app, so `xdg-open` ended in XFCE's "Choose
// Preferred Application" dialog, which participants reported as a fault of the app under test.
// The browser launch puts stand-ins for both commands first on the browser's search path. A stand-in
// appends the link to a log and exits; a web or file link goes on to the desktop's own command.
// The executor reads the log on each observation, and the participant loop records each link
// and tells the participant what happened. Chrome's own "Open xdg-open?" prompt for tel: and
// the other non-mailto schemes is answered by the profile preference in
// src/evidence/browser-hygiene.ts; Chrome never prompts for mailto.

import {
  EXTERNAL_HANDOFF_LIMITS,
  externalHandoffOf,
  type ExternalHandoff,
} from "../../actors/computer-use/external-handoff.js";
import { shellQuote, type Shell } from "../shell.js";

/** Where the stand-ins and their log live on the desktop. */
const EXTERNAL_LINK_DIR = "/tmp/humanish-external-links";

const LINK_LENGTH = 4096;

/** One stand-in. `$0` names the command it stands in for. */
function standIn(dir: string): string {
  const bin = `${dir}/bin`;
  return [
    "#!/bin/sh",
    "# Installed by humanish for a study participant's browser: this desktop has no app for this",
    "# link, so the link is written down for the study instead of opening a chooser dialog.",
    `bin=${shellQuote(bin)}`,
    "url=",
    'for arg in "$@"; do case "$arg" in -*) ;; *) url=$arg; break ;; esac; done',
    'case "$url" in',
    "  [Hh][Tt][Tt][Pp]:*|[Hh][Tt][Tt][Pp][Ss]:*|[Ff][Ii][Ll][Ee]:*) ;;",
    "  [A-Za-z]*:*)",
    `    printf '%s\\n' "$(printf '%s' "$url" | tr -d '\\r\\n' | cut -c 1-${LINK_LENGTH})" >> ${shellQuote(`${dir}/links.log`)}`,
    "    exit 0 ;;",
    "esac",
    // Anything else goes to the desktop's own command, found on the search path without this
    // directory.
    "set -f",
    "real=",
    "IFS=:",
    'for entry in $PATH; do [ "$entry" = "$bin" ] || real=${real:+$real:}$entry; done',
    'PATH=$real exec "${0##*/}" "$@"',
    "",
  ].join("\n");
}

/**
 * Shell lines for the browser launch script, run before the browser starts: they install the
 * stand-ins and put them first on the search path for every command the script starts after them.
 */
export function externalLinkHandlerSetup(dir: string = EXTERNAL_LINK_DIR): string {
  const bin = `${dir}/bin`;
  return [
    `mkdir -p ${shellQuote(bin)}`,
    `touch ${shellQuote(`${dir}/links.log`)}`,
    `printf '%s' ${shellQuote(standIn(dir))} > ${shellQuote(`${bin}/xdg-open`)}`,
    `cp ${shellQuote(`${bin}/xdg-open`)} ${shellQuote(`${bin}/xdg-email`)}`,
    `chmod 755 ${shellQuote(`${bin}/xdg-open`)} ${shellQuote(`${bin}/xdg-email`)}`,
    `export PATH=${shellQuote(bin)}:"$PATH"`,
  ].join("\n");
}

/**
 * Returns a read of the links handed off since the previous read, oldest first and at most
 * EXTERNAL_HANDOFF_LIMITS.perObservation at a time. Reads run one at a time, so a retried
 * observation cannot return a link twice. A line still being written is left for the next read.
 */
export function externalHandoffReader(
  shell: Pick<Shell, "run">,
  options: { requestTimeoutMs: number; dir?: string },
): () => Promise<ExternalHandoff[]> {
  const log = `${options.dir ?? EXTERNAL_LINK_DIR}/links.log`;
  let consumed = 0;
  let previous: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<ExternalHandoff[]> => {
    const result = await shell.run(
      `tail -n +${consumed + 1} ${shellQuote(log)} 2>/dev/null | head -n ${EXTERNAL_HANDOFF_LIMITS.perObservation}`,
      { requestTimeoutMs: options.requestTimeoutMs, timeoutMs: 10_000 },
    );
    const lines = result.stdout.split("\n");
    lines.pop();
    consumed += lines.length;
    return lines.flatMap((line) => {
      const handoff = externalHandoffOf(line);
      return handoff === undefined ? [] : [handoff];
    });
  };
  return () => {
    const next = previous.then(read, read);
    previous = next.catch(() => undefined);
    return next;
  };
}
