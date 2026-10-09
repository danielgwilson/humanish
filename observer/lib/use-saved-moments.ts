import { useCallback, useMemo, useState } from "react";
import type { ObserverStream } from "./observer-data";
import { buildPlayerModel, frameEntry, type PlayerModel } from "./player-model";
import type { PlayerView } from "./player-state";
import { isMoments, usePreference, type SavedMoment } from "./preferences";
import { savedEntryLabels } from "./saved-entry-labels";

/** What the saved-moments control shows and does. */
export interface SavedMomentsControl {
  moments: SavedMoment[];
  entryLabels: Map<string, string>;
  canSave: boolean;
  /** Browser storage took the last change; when false the list lasts for this visit only. */
  stored: boolean;
  message: string;
  onSave: () => void;
  /** True when the moment opened; false leaves a message saying why it could not. */
  onOpen: (moment: SavedMoment) => boolean;
  onRemove: (moment: SavedMoment) => void;
}

const sameMoment = (a: SavedMoment, b: SavedMoment) =>
  a.runId === b.runId &&
  a.streamId === b.streamId &&
  a.itemId === b.itemId &&
  a.eventId === b.eventId;

/**
 * The run's saved moments, kept in browser storage, and the message from the last save or open.
 * The message shows until the next navigation, which `revision` counts. A save takes the frame and entry the selected participant's player reports through
 * `onViewChange`, once it is paused in replay. An open checks that the recording still holds the
 * frame and entry before it calls `open`.
 */
export function useSavedMoments({
  runId,
  streams,
  selected,
  model,
  open,
  revision,
}: {
  runId: string;
  streams: ObserverStream[];
  selected: ObserverStream | null;
  model: PlayerModel | null;
  open: (streamId: string, frame: number, eventId: string | undefined) => void;
  revision: number;
}): {
  control: SavedMomentsControl;
  onViewChange: (view: PlayerView) => void;
} {
  const [saved, setSaved, stored] = usePreference("moments", [] as SavedMoment[], isMoments);
  const [written, setWritten] = useState({ text: "", revision });
  const message = written.revision === revision ? written.text : "";
  const setMessage = (text: string) => setWritten({ text, revision });
  const [view, setView] = useState<(PlayerView & { streamId: string }) | null>(null);
  const entryLabels = useMemo(() => savedEntryLabels(streams), [streams]);
  const selectedId = selected?.id;
  const onViewChange = useCallback(
    (next: PlayerView) => {
      if (selectedId !== undefined) setView({ ...next, streamId: selectedId });
    },
    [selectedId],
  );
  const onSave = () => {
    if (
      !selected ||
      !model ||
      !view ||
      view.streamId !== selected.id ||
      view.frame === null ||
      view.mode === "live"
    ) {
      setMessage("Pause on a recorded frame before saving a moment.");
      return;
    }
    const frame = model.frames[view.frame];
    if (!frame) {
      setMessage("That frame is no longer available.");
      return;
    }
    if (view.eventId && !frameEntry(model, view.eventId, view.frame)) {
      setMessage("That recorded entry is no longer available.");
      return;
    }
    const moment: SavedMoment = {
      runId,
      streamId: selected.id,
      itemId: frame.itemId,
      frame: frame.index,
      savedAt: new Date().toISOString(),
      ...(view.eventId ? { eventId: view.eventId } : {}),
    };
    setSaved([...saved.filter((m) => !sameMoment(m, moment)).slice(-49), moment]);
    setMessage("Moment saved.");
  };
  const onOpen = (moment: SavedMoment) => {
    const stream = streams.find((s) => s.id === moment.streamId);
    const recorded = stream ? buildPlayerModel(stream) : null;
    const frame = recorded?.frames.find((f) => f.itemId === moment.itemId);
    if (!recorded || !frame) {
      setMessage("This saved frame is no longer in the available recording.");
      return false;
    }
    if (moment.eventId && !frameEntry(recorded, moment.eventId, frame.index)) {
      setMessage("This saved entry is no longer in its recorded capture interval.");
      return false;
    }
    open(moment.streamId, frame.index, moment.eventId);
    return true;
  };
  const canSave =
    !!selected &&
    view?.streamId === selected.id &&
    view.mode === "replay" &&
    view.frame !== null &&
    (!view.eventId || (!!model && !!frameEntry(model, view.eventId, view.frame)));
  return {
    control: {
      moments: saved.filter((m) => m.runId === runId),
      entryLabels,
      canSave,
      stored,
      message,
      onSave,
      onOpen,
      onRemove: (moment) => setSaved(saved.filter((m) => !sameMoment(m, moment))),
    },
    onViewChange,
  };
}
