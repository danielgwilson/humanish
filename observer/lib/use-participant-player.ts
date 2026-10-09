import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isActiveStream, isServedOrigin, liveEmbedUrl } from "./live";
import { buildPlayerModel, type PlayerModel } from "./player-model";
import type { ObserverNavigation } from "./use-observer-navigation";
import type { StudyPlayback, StudyPlayerControl } from "./use-study-playback";

/**
 * The selected participant's player: the model it shows, whether it follows the study clock, and
 * the control that clock gives it. A recording opened from the participants follows the study
 * clock, unless it has captures the clock cannot place (no timestamps and no recording media). One
 * opened from the report or the comparison plays on its own, and the study clock pauses while it
 * shows. Each navigation's address is applied to the clock once. `updating` says
 * the feed still receives updates: a live address follows the latest capture only then, and when
 * updates stop a following player freezes on the last frame.
 */
export function useParticipantPlayer(
  runId: string,
  navigation: Pick<
    ObserverNavigation,
    "selected" | "route" | "source" | "revision" | "preservePlayback" | "findingId" | "comparison"
  >,
  playback: StudyPlayback,
  updating: boolean,
): { model: PlayerModel | null; shared: boolean; control: StudyPlayerControl | undefined } {
  const { selected, route, source, revision, preservePlayback } = navigation;
  const model = useMemo(
    () =>
      selected && !(route.eventId && route.frame === null)
        ? (buildPlayerModel(selected) ??
          (selected.recording ||
          (isActiveStream(selected) && ["browser", "ui", "codex-ui"].includes(selected.kind)) ||
          (isServedOrigin(window.location.protocol) && liveEmbedUrl(selected) !== null)
            ? { frames: [], rows: [], avgFrameMs: 1500, paced: "avg" as const }
            : null))
        : null,
    [selected, route.eventId, route.frame],
  );
  const selectedLane = selected ? playback.recording.lanes.get(selected.id) : undefined;
  // A poll may add or remove timestamps. Only deliberate navigation changes
  // clock ownership; switching mid-review would expose another clock's state.
  const navigationKey = `${runId}:${revision}`;
  const ownershipKey = JSON.stringify([navigationKey, selected?.id ?? null, source.kind]);
  const eligible = !!selected && !!model && source.kind === "participants";
  const [owned, setOwned] = useState<{ key: string; shared: boolean } | null>(null);
  const ownership =
    owned?.key === ownershipKey
      ? owned
      : {
          key: ownershipKey,
          shared:
            selectedLane?.media !== null || selectedLane?.times !== null || !selectedLane?.model,
        };
  if (eligible && owned !== ownership) setOwned(ownership);
  const shared = eligible && ownership.shared;
  const appliedNavigation = useRef("");
  const navigationPending =
    shared &&
    appliedNavigation.current !== navigationKey &&
    !(preservePlayback && playback.reviewing);
  const sharedControl = selected && shared ? playback.playerControl(selected.id) : undefined;
  // Child passive effects can run before the layout-effect state update below
  // commits. Never let that initial latest projection overwrite an incoming
  // exact address, especially an unavailable frame the caller needs to inspect.
  const control =
    sharedControl && navigationPending
      ? {
          ...sharedControl,
          reviewing: true,
          moment: { kind: "no-captures" as const },
          unavailableFrame: true,
        }
      : sharedControl;
  useLayoutEffect(() => {
    if (appliedNavigation.current === navigationKey) return;
    if (!selected) return;
    if (!shared) return;
    appliedNavigation.current = navigationKey;
    if (preservePlayback && playback.reviewing) return;
    if (route.mode === "live" && updating) playback.latest();
    else if (route.frame !== null) playback.selectFrame(selected.id, route.frame, route.eventId);
    else if (route.mode !== "replay" && updating && isActiveStream(selected)) playback.latest();
    else if (model?.frames.length)
      playback.selectFrame(
        selected.id,
        route.mode === "live" ? model.frames.length - 1 : 0,
        route.eventId,
      );
    else playback.seek(playback.recording.startMs ?? Number.NaN);
  }, [navigationKey, selected, shared, preservePlayback, route, model, updating, playback]);
  const reportShown = navigation.findingId !== null;
  const { comparison } = navigation;
  const { pause } = playback;
  useEffect(() => {
    if (reportShown || comparison || (selected && !shared)) pause();
  }, [reportShown, comparison, selected, shared, pause]);
  const previousUpdating = useRef(updating);
  useEffect(() => {
    if (previousUpdating.current && !updating && selected && shared && !playback.reviewing) {
      if (model?.frames.length) playback.selectFrame(selected.id, model.frames.length - 1);
      else playback.seek(playback.atMs ?? Number.NaN);
    }
    previousUpdating.current = updating;
  }, [updating, selected, shared, model, playback]);
  return { model, shared, control };
}
