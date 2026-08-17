import { useEffect, useState } from "react";

import { EmptyState } from "./components/empty-state";
import { IconRail } from "./components/icon-rail";
import { ParticipantStub } from "./components/participant-stub";
import { Player } from "./components/player";
import { Sidebar } from "./components/sidebar";
import { Drawer } from "./components/ui/drawer";
import { StudyGrid } from "./components/study-grid";
import { Topbar, type GridFilters } from "./components/topbar";
import { HISTORY_POLL_MS, OBSERVER_POLL_MS, fetchHistoryIndex, fetchObserverData, isServedOrigin, liveEmbedUrl, type HistoryIndex } from "./lib/live";
import type { ObserverData } from "./lib/observer-data";
import { buildPlayerModel } from "./lib/player-model";
import { formatHash, parseHash, pushHash } from "./lib/route";

const NO_FILTERS: GridFilters = { status: "", kind: "", query: "" };

export function App({ data: initialData }: { data: ObserverData | null }) {
  const [data, setData] = useState<ObserverData | null>(initialData);
  const [history, setHistory] = useState<HistoryIndex | null>(null);
  // Deep links (#441): the hash is the address of the current view. Selection
  // initializes from it, browser Back/Forward drive it, and UI selection writes it.
  const [selectedId, setSelectedId] = useState<string | null>(() => parseHash(window.location.hash).laneId);
  const [initialFrame, setInitialFrame] = useState<number | null>(() => parseHash(window.location.hash).frame);
  const [filters, setFilters] = useState<GridFilters>(NO_FILTERS);
  // One library control, two behaviors: on desktop it collapses the static sidebar
  // (persisted); on a phone-width viewport the sidebar is CSS-hidden, so the same
  // button opens the library as a Base UI drawer instead. The width check runs at
  // click time only — render never branches on viewport, so file:// and jsdom stay
  // deterministic.
  const [sideOpen, setSideOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("humanish-sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleLibrary = () => {
    const phone = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 880px)").matches;
    if (phone) {
      setDrawerOpen((value) => !value);
      return;
    }
    setSideOpen((value) => {
      try {
        window.localStorage.setItem("humanish-sidebar", value ? "closed" : "open");
      } catch {
        // storage unavailable (some file:// contexts): the toggle still works for the session
      }
      return !value;
    });
  };

  // Served mode (watch/serve) polls the sibling snapshot the server refreshes per
  // request and the run-library index — same cadence and silences as the legacy
  // client. A file:// artifact never touches the network.
  useEffect(() => {
    if (initialData === null || !isServedOrigin(window.location.protocol)) return;
    let cancelled = false;
    const fetchImpl: typeof fetch = (input, init) => window.fetch(input, init);
    const pollData = async () => {
      const next = await fetchObserverData(fetchImpl);
      if (!cancelled && next !== null) setData(next);
    };
    const pollHistory = async () => {
      const next = await fetchHistoryIndex(fetchImpl);
      if (!cancelled) setHistory(next);
    };
    void pollHistory();
    const dataTimer = setInterval(() => void pollData(), OBSERVER_POLL_MS);
    const historyTimer = setInterval(() => void pollHistory(), HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(dataTimer);
      clearInterval(historyTimer);
    };
  }, [initialData]);

  const streams = data?.streams ?? [];
  const selected = selectedId !== null ? streams.find((s) => s.id === selectedId) ?? null : null;
  // A live lane can stream before its first screenshot lands (the run's opening
  // minutes). The stage IS the stream then, so an injected embed URL routes to the
  // player with an empty timeline instead of the frameless evidence stub.
  const playerModel = selected
    ? (buildPlayerModel(selected) ??
      (liveEmbedUrl(selected) !== null ? { frames: [], rows: [], avgFrameMs: 1500, paced: "avg" as const } : null))
    : null;

  const step = (delta: number) => {
    if (streams.length === 0) return;
    const index = selected ? streams.findIndex((s) => s.id === selected.id) : 0;
    const nextStream = streams[(index + delta + streams.length) % streams.length];
    if (nextStream) setSelectedId(nextStream.id);
  };

  // Back/Forward restore the addressed view (pushState never fires hashchange,
  // so our own writes cannot echo here; popstate covers pushState navigation).
  useEffect(() => {
    const onRoute = () => {
      const route = parseHash(window.location.hash);
      setSelectedId(route.laneId);
      setInitialFrame(route.frame);
    };
    window.addEventListener("popstate", onRoute);
    window.addEventListener("hashchange", onRoute);
    return () => {
      window.removeEventListener("popstate", onRoute);
      window.removeEventListener("hashchange", onRoute);
    };
  }, []);

  // UI selection writes the address. Guarded on the parsed hash so restoring FROM
  // the hash (initial load, Back) never clobbers a frame address the player has
  // not consumed yet.
  useEffect(() => {
    if (parseHash(window.location.hash).laneId !== selectedId) {
      pushHash(formatHash(selectedId, null));
      setInitialFrame(null);
    }
  }, [selectedId]);

  // Escape returns to the grid. Arrow keys belong to the player (frame stepping,
  // per the review-player spec); participants page via the topbar pager.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!data) return <EmptyState />;

  const visible = streams.filter((stream) => {
    if (filters.status !== "" && stream.statusLabel !== filters.status) return false;
    if (filters.kind !== "" && stream.kindLabel !== filters.kind) return false;
    if (filters.query !== "") {
      const haystack = `${stream.label} ${stream.id} ${stream.sim.personaId}`.toLowerCase();
      if (!haystack.includes(filters.query.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="frame">
      <IconRail runsActive={selected === null} onRuns={() => setSelectedId(null)} />
      {selected === null && sideOpen ? <Sidebar data={data} history={history} onRuns={() => setSelectedId(null)} /> : null}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} label="Run library">
        <Sidebar
          data={data}
          history={history}
          onRuns={() => {
            setSelectedId(null);
            setDrawerOpen(false);
          }}
        />
      </Drawer>
      <div className="main">
        <Topbar
          data={data}
          selected={selected}
          filters={filters}
          onFilters={setFilters}
          onRuns={() => setSelectedId(null)}
          onStep={step}
          onLibrary={toggleLibrary}
          sideOpen={sideOpen}
        />
        <div className={selected && playerModel ? "content player-host" : "content"}>
          {selected ? (
            playerModel ? (
              <Player key={selected.id} data={data} stream={selected} model={playerModel} initialFrame={initialFrame} />
            ) : (
              <ParticipantStub key={selected.id} data={data} stream={selected} />
            )
          ) : (
            <StudyGrid data={data} streams={visible} onOpen={setSelectedId} />
          )}
        </div>
        <div className="statusbar">
          <span>
            run <b>{data.run.runId}</b>
          </span>
          <span>{data.run.mode}</span>
          <span className="links">
            {data.artifactLinks.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
