// The words a reader sees for one participant. Routes write the caption as the stream label, and
// the Observer, the TUI and findings show that label, so every surface names the participant the
// same way. The participant's taxonomy and ids stay in the bundle data, out of the caption.

/** Ids `participantIdAt` makes for an undeclared roster entry. They number a position. */
const NUMBERED_ID = /^(lane|role)-\d+$/;

/** A participant, as much of it as a caption reads. */
export interface CaptionFacts {
  /** The roster id, on a route that has a roster. */
  readonly id?: string;
  /** The persona, which names the participant when there is no roster id or it is only a number. */
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
  const { id, personaId } = participant;
  const name = inWords(id === undefined || NUMBERED_ID.test(id) ? personaId : id);
  const device = deviceInWords(participant.device);
  return device === undefined ? name : `${name}, ${device}`;
}

/** The fields of a saved stream that name its participant. */
export interface SavedCaptionFacts {
  readonly label: string;
  /** The computer-use participant id. */
  readonly laneId?: string;
  readonly personaId?: string;
}

/**
 * The caption a saved stream shows: its label, which a route writes with `participantCaption`.
 * Earlier releases wrote ids and taxonomy into the label (`lane-01 · browser`, `CUA participant
 * <id>: <study>`, `Concurrent persona <id> (type:<t> / ...) · <study>`), so a stream saved that way
 * is captioned again from the id it names, without a device.
 */
export function savedCaption(stream: SavedCaptionFacts): string {
  const { label, laneId, personaId } = stream;
  const sharedWorldId = /^Concurrent persona (\S+)/.exec(label)?.[1];
  if (sharedWorldId !== undefined) {
    return participantCaption({ id: sharedWorldId, personaId: personaId ?? sharedWorldId });
  }
  const computerUse =
    label.startsWith("CUA ") || (laneId !== undefined && label === `${laneId} · browser`);
  if (computerUse && personaId !== undefined) {
    return participantCaption({ ...(laneId === undefined ? {} : { id: laneId }), personaId });
  }
  return label;
}
