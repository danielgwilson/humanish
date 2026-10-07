// The words a reader sees for one participant. Routes write the caption as the stream label, and
// the Observer, the TUI and findings show that label, so every surface names the participant the
// same way. The participant's taxonomy and ids stay in the bundle data, out of the caption.

/** Ids `participantIdAt` makes for an undeclared roster entry. They number a position. */
const NUMBERED_ID = /^(lane|role)-\d+$/;

/** A participant, as much of it as a caption reads. */
export interface CaptionFacts {
  /** The roster id. */
  readonly id: string;
  /** The persona, which names the participant when the roster id is only a number. */
  readonly personaId: string;
  /** The participant's device, when it has one. */
  readonly device?: { readonly name: string; readonly preset: { readonly isMobile: boolean } };
}

/** An id in words: `lobby-host` reads "Lobby host". */
function inWords(id: string): string {
  const words = id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .join(" ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A phone or a tablet. A desktop of any size goes unnamed, since most participants use one. */
function deviceInWords(device: CaptionFacts["device"]): string | undefined {
  if (device === undefined) return undefined;
  if (device.preset.isMobile) return "phone";
  return device.name === "tablet" ? "tablet" : undefined;
}

/** "Lobby host", or "Player two, phone" for a participant on a phone. */
export function participantCaption(participant: CaptionFacts): string {
  const name = inWords(NUMBERED_ID.test(participant.id) ? participant.personaId : participant.id);
  const device = deviceInWords(participant.device);
  return device === undefined ? name : `${name}, ${device}`;
}
