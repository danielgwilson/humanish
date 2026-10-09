import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from "react";
import type { ObserverData, ObserverStream } from "./observer-data";
import { recordingSource, recordingState, type RecordingSource } from "./recording-source";
import { formatHash, parseHash, pushHash, type HashRoute } from "./route";
import { reportFindingId, reportHash, resolveReportMoment, type StudyReport } from "./study-report";

/** Where a recording is opened from, and so where its return button leads. */
type RecordingOrigin =
  | { kind: "finding"; findingId: string }
  | { kind: "concerns" }
  | { kind: "design" }
  | { kind: "comparison" };

interface OpenOptions {
  /** 0-based frame to open on; none opens the recording at its default moment. */
  frame?: number | null;
  /** A recorded entry within that frame's capture interval. */
  eventId?: string | undefined;
  /** Where the recording returns to; the participants grid when absent. */
  from?: RecordingOrigin;
  /** Open in replay even without a frame address. */
  replay?: boolean;
  /** Leave the study clock where it is: paging, the grid, a note. */
  keepClock?: boolean;
}

export interface ObserverNavigation {
  /** The participant address in the hash. */
  route: HashRoute;
  /** The participant the address names; null on the grid, the report and the comparison. */
  selected: ObserverStream | null;
  /** Where the open recording returns to. */
  source: RecordingSource;
  /** The report's addressed finding ("" for none) while the report shows, else null. */
  findingId: string | null;
  /** The report's "Concerns considered" disclosure. */
  concernsOpen: boolean;
  /** The comparison shows. */
  comparison: boolean;
  /** The participants chosen for the comparison, at most three. */
  compareIds: string[];
  /** The grid fills the frame without the library. Escape and the report leave it. */
  monitoring: boolean;
  /** Counts navigations: each participant or grid open, and each browser history move. */
  revision: number;
  /** The last navigation left the study clock where it was. */
  preservePlayback: boolean;
  /** For the main content element: focus lands there, and each view keeps its scroll position. */
  content: { ref: RefObject<HTMLElement | null>; onScroll: (event: UIEvent<HTMLElement>) => void };
  openParticipant: (id: string, options?: OpenOptions) => void;
  toGrid: () => void;
  /** Opens the next (1) or previous (-1) participant, at a moment the source finding cites. */
  step: (delta: number) => void;
  /** Goes back to where the recording was opened from and focuses what was used there. */
  returnToSource: () => void;
  openReport: (findingId?: string) => void;
  /** Addresses a finding chosen in the report and brings its row into view. */
  selectFinding: (findingId: string) => void;
  setConcernsOpen: (open: boolean) => void;
  toggleCompare: (id: string) => void;
  /** Opens the chosen participants, at the comparison's last address when they are unchanged. */
  openComparison: () => void;
  /** The comparison reports its address as its clock moves. */
  rememberComparison: (hash: string) => void;
  monitor: (on: boolean) => void;
}

const compareRoute = () => window.location.hash.startsWith("#/compare");
const routeCompareIds = () =>
  new URLSearchParams(window.location.hash.split("?")[1]).getAll("lane").slice(0, 3);
const findingButton = (id: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[data-finding]")].find(
    (button) => button.dataset.finding === id,
  );

/** The comparison address for `ids`: the remembered one, clock and all, when it names them all. */
function comparisonAddress(ids: string[], remembered: string): string {
  const previousIds = new URLSearchParams(remembered.split("?")[1]).getAll("lane");
  if (previousIds.length === ids.length && ids.every((id) => previousIds.includes(id)))
    return remembered;
  const query = new URLSearchParams();
  ids.forEach((id) => query.append("lane", id));
  return `#/compare?${query}`;
}

/** The first moment the source finding cites for `streamId` that the recording still resolves. */
function citedMoment(
  data: ObserverData | null,
  report: StudyReport | undefined,
  source: RecordingSource,
  streamId: string,
) {
  if (!data || source.kind !== "finding") return undefined;
  return report?.findings
    .find((finding) => finding.id === source.findingId)
    ?.moments.filter((moment) => moment.streamId === streamId)
    .map((entry) => resolveReportMoment(data, streamId, entry.eventId))
    .find(Boolean);
}

/** Focus the element `find` returns once the next view has painted. */
function focusAfterPaint(find: () => HTMLElement | null | undefined): void {
  const afterPaint =
    window.requestAnimationFrame ??
    ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  afterPaint(() => find()?.focus({ preventScroll: true }));
}

/**
 * The Observer's views (participants grid, one participant, comparison, report) and the moves
 * between them. The hash holds the address, so a reload, a copied link and browser history land
 * on the same view; `history.state` holds where an open recording came from, checked against the
 * report before it is trusted.
 */
export function useObserverNavigation({
  data,
  report,
  findingsAvailable,
  reviewing,
}: {
  data: ObserverData | null;
  report: StudyReport | undefined;
  /** The run has a findings view; a report address without one shows the participants. */
  findingsAvailable: boolean;
  /** The study clock is reviewing, so paging opens the next participant in replay. */
  reviewing: boolean;
}): ObserverNavigation {
  const runId = data?.run.runId ?? "";
  const streams = data?.streams ?? [];
  const sourceIn = (state: unknown) =>
    recordingSource(
      state,
      runId,
      report?.findings.map((finding) => finding.id) ?? [],
      report?.concernReviews !== undefined,
      !!report?.designFindings?.length,
    );
  const [reportRoute, setReportRoute] = useState(() => reportFindingId(window.location.hash));
  const [concernsOpen, setConcernsOpen] = useState(false);
  const [source, setSource] = useState(() => sourceIn(window.history.state));
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [revision, setRevision] = useState(0);
  const [preservePlayback, setPreservePlayback] = useState(false);
  const [comparison, setComparison] = useState(compareRoute);
  const [compareIds, setCompareIds] = useState<string[]>(routeCompareIds);
  const [monitoring, setMonitoring] = useState(false);
  const comparisonLocation = useRef(compareRoute() ? window.location.hash : "");
  const rememberComparison = useCallback((hash: string) => {
    comparisonLocation.current = hash;
  }, []);

  const onNavigate = useEffectEvent(() => {
    setReportRoute(reportFindingId(window.location.hash));
    setSource(sourceIn(window.history.state));
    setRoute(parseHash(window.location.hash));
    setComparison(compareRoute());
    if (compareRoute()) setCompareIds(routeCompareIds());
    // Internal participant history changes the view of the running clock. A
    // copied/reloaded or externally changed evidence address is a fresh seek.
    setPreservePlayback(window.history.state?.humanishStudyNavigation === runId);
    setRevision((value) => value + 1);
  });
  useEffect(() => {
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("popstate", onNavigate);
    return () => {
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("popstate", onNavigate);
    };
  }, []);

  const selected = streams.find((stream) => stream.id === route.laneId) ?? null;
  const reportShown = findingsAvailable && reportRoute !== null;
  const contentRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const view = reportShown ? "findings" : comparison ? "comparison" : (selected?.id ?? "grid");
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = scrollPositions.current.get(view) ?? 0;
  }, [view]);

  const open = (
    id: string | null,
    from: RecordingSource,
    { frame = null, eventId, replay = false, keepClock = false }: OpenOptions,
  ) => {
    setReportRoute(null);
    pushHash(formatHash(id, frame, replay ? "replay" : null, eventId), {
      ...(id ? recordingState(from) : {}),
      ...(keepClock ? { humanishStudyNavigation: runId } : {}),
    });
    setSource(from);
    setRoute(parseHash(window.location.hash));
    setComparison(false);
    setPreservePlayback(keepClock);
    setRevision((value) => value + 1);
    if (id) focusAfterPaint(() => contentRef.current);
  };
  const openParticipant = (id: string, options: OpenOptions = {}) => {
    const from = options.from;
    open(
      id,
      !from
        ? { runId, kind: "participants" }
        : from.kind === "comparison"
          ? { runId, kind: "comparison", hash: comparisonLocation.current || window.location.hash }
          : { runId, ...from },
      options,
    );
  };
  const toGrid = () => open(null, { runId, kind: "participants" }, { keepClock: true });
  const step = (delta: number) => {
    if (!streams.length) return;
    const index = selected ? streams.findIndex((stream) => stream.id === selected.id) : 0;
    const next = streams[(index + delta + streams.length) % streams.length];
    if (!next) return;
    const moment = citedMoment(data, report, source, next.id);
    open(next.id, source, {
      frame: moment?.frameIndex ?? null,
      eventId: moment?.eventId,
      replay: reviewing,
      keepClock: source.kind === "participants",
    });
  };
  const openReport = (findingId = "") => {
    pushHash(reportHash(findingId));
    setReportRoute(findingId);
    setRoute(parseHash(""));
    setComparison(false);
    setMonitoring(false);
  };
  const selectFinding = (findingId: string) => {
    openReport(findingId);
    if (findingId)
      focusAfterPaint(() => {
        const target = findingButton(findingId);
        target?.scrollIntoView({ block: "nearest" });
        return target;
      });
  };
  const returnToSource = () => {
    if (source.kind === "finding") {
      openReport(source.findingId);
      focusAfterPaint(() => findingButton(source.findingId));
    } else if (source.kind === "concerns") {
      setConcernsOpen(true);
      openReport();
      focusAfterPaint(() => document.querySelector<HTMLElement>(".report-concerns > summary"));
    } else if (source.kind === "design") {
      openReport();
      focusAfterPaint(() => document.getElementById("design-findings-heading"));
    } else if (source.kind === "comparison") {
      pushHash(source.hash);
      setComparison(true);
      setCompareIds(routeCompareIds());
      setRoute(parseHash(""));
      focusAfterPaint(() => contentRef.current);
    } else {
      toGrid();
      focusAfterPaint(() => contentRef.current);
    }
  };
  const toggleCompare = (id: string) =>
    setCompareIds((old) =>
      old.includes(id) ? old.filter((v) => v !== id) : old.length < 3 ? [...old, id] : old,
    );
  const openComparison = () => {
    const ids = compareIds.filter((id) => streams.some((stream) => stream.id === id));
    if (!ids.length) return;
    pushHash(comparisonAddress(ids, comparisonLocation.current));
    setComparison(true);
    setRoute(parseHash(""));
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest(
        "input,select,textarea,[contenteditable=true],[role=dialog],[role=menu],[role=combobox],[role=listbox]",
      )
    )
      return;
    if (event.key === "Escape" && !document.fullscreenElement) {
      if (monitoring) setMonitoring(false);
      else if (selected) returnToSource();
      else if (comparison) toGrid();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    route,
    selected,
    source,
    findingId: reportShown ? reportRoute : null,
    concernsOpen,
    comparison,
    compareIds,
    monitoring,
    revision,
    preservePlayback,
    content: {
      ref: contentRef,
      onScroll: (event) => scrollPositions.current.set(view, event.currentTarget.scrollTop),
    },
    openParticipant,
    toGrid,
    step,
    returnToSource,
    openReport,
    selectFinding,
    setConcernsOpen,
    toggleCompare,
    openComparison,
    rememberComparison,
    monitor: setMonitoring,
  };
}
