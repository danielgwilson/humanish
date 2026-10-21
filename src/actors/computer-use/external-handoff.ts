// A link the participant's browser hands to another app: mailto:, tel:, sms: and the like. The study
// desktop has no mail, phone or messaging app, so it writes the link down instead of opening one
// (src/substrates/e2b/desktop-handoff.ts), and the participant loop records the handoff and tells
// the participant what happened. The recipients of a mailto link are all the run keeps of it: a
// prefilled subject or body can hold anything the page put there.

/** A link handed to another app, as the run keeps it. */
export interface ExternalHandoff {
  /** The link's scheme in lowercase, without the colon. */
  readonly scheme: string;
  /** A mailto link's recipient addresses: its path, to, cc and bcc. */
  readonly recipients?: readonly string[];
}

/** How much of one link, and how many links per observation, a desktop hands on. */
export const EXTERNAL_HANDOFF_LIMITS = Object.freeze({
  recipients: 10,
  addressLength: 254,
  perObservation: 20,
});

const SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/i;
// The browser opens these itself, so a desktop never hands one to another app.
const BROWSER_SCHEMES = new Set(["http", "https", "file"]);
const ADDRESS = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;
const RECIPIENT_FIELDS = new Set(["to", "cc", "bcc"]);

/** The handoff a link makes, or undefined for a link the browser opens itself. */
export function externalHandoffOf(url: string): ExternalHandoff | undefined {
  const scheme = SCHEME.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme === undefined || BROWSER_SCHEMES.has(scheme)) return undefined;
  if (scheme !== "mailto") return { scheme };
  return { scheme, recipients: mailtoRecipients(url.trim().slice(scheme.length + 1)) };
}

/** RFC 6068: addresses in the path and in to, cc and bcc fields, comma-separated and percent-encoded. */
function mailtoRecipients(link: string): string[] {
  const queryAt = link.indexOf("?");
  const fields = [queryAt === -1 ? link : link.slice(0, queryAt)];
  if (queryAt !== -1)
    for (const pair of link.slice(queryAt + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals === -1) continue;
      if (RECIPIENT_FIELDS.has(decoded(pair.slice(0, equals)).toLowerCase()))
        fields.push(pair.slice(equals + 1));
    }
  const recipients = new Set<string>();
  for (const field of fields)
    for (const part of decoded(field).split(",")) {
      const address = (/<([^<>]*)>/.exec(part)?.[1] ?? part).trim();
      if (address.length <= EXTERNAL_HANDOFF_LIMITS.addressLength && ADDRESS.test(address))
        recipients.add(address);
    }
  return [...recipients].slice(0, EXTERNAL_HANDOFF_LIMITS.recipients);
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The trace's record of a handoff: the scheme and any recipients. */
export function externalHandoffSummary(handoff: ExternalHandoff): string {
  const recipients = handoff.recipients ?? [];
  return recipients.length === 0
    ? `${handoff.scheme}:`
    : `${handoff.scheme}: ${recipients.join(", ")}`;
}

/**
 * What the participant is told on its next turn. Its next screenshot shows no app window, so the
 * note says the link worked and why the page did not change.
 */
export function externalHandoffNote(handoff: ExternalHandoff): string {
  const recipients = handoff.recipients ?? [];
  const unseen = "This computer does not show that app, so the page stays as it was";
  switch (handoff.scheme) {
    case "mailto":
      return recipients.length === 0
        ? `The email link worked: your email app started a new blank message. ${unseen}, and nothing was sent.`
        : `The email link worked: your email app started a new message to ${recipients.join(", ")}. ${unseen}, and nothing was sent.`;
    case "tel":
    case "callto":
      return `The phone link worked: your phone app started a call to the number. ${unseen}, and no call was placed.`;
    case "sms":
    case "mms":
      return `The message link worked: your messaging app started a new message. ${unseen}, and nothing was sent.`;
    default:
      return `The link asked to open another app for a ${handoff.scheme}: link. This computer has no app for it, so nothing opened.`;
  }
}
