import { Popover } from "./ui/popover";
import type { SavedMoment } from "@/lib/preferences";

export function SavedMoments({ moments, canSave, stored, message, onSave, onOpen, onRemove }: {
  moments: SavedMoment[]; canSave: boolean; stored: boolean; message: string;
  onSave: () => void; onOpen: (moment: SavedMoment) => void; onRemove: (moment: SavedMoment) => void;
}) {
  return <Popover triggerClassName="review-tool" label="Saved moments" trigger={<>Saved moments{moments.length ? ` (${moments.length})` : ""}</>}>
    <div className="saved-moments">
      <p>Keep moments from this study in this browser.</p>
      {canSave ? <button className="review-tool" type="button" onClick={onSave}>Save current moment</button> : <p>Open a participant and pause on a frame to save it.</p>}
      <p role="status">{message}{!stored ? " Browser storage is unavailable; saved for this visit only." : ""}</p>
      {moments.length === 0 ? <p>No saved moments yet.</p> : <ul>{moments.map((m) => <li key={`${m.streamId}/${m.itemId}`}>
        <button type="button" onClick={() => onOpen(m)}>{m.streamId} · frame {m.frame + 1}</button>
        <button type="button" aria-label={`Remove saved frame ${m.frame + 1} from ${m.streamId}`} onClick={() => onRemove(m)}>Remove</button>
      </li>)}</ul>}
    </div>
  </Popover>;
}
