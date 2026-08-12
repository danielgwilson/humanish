import { useEffect, useState } from "react";

import { EmptyState } from "./components/empty-state";
import { IconRail } from "./components/icon-rail";
import { ParticipantStub } from "./components/participant-stub";
import { Player } from "./components/player";
import { Sidebar } from "./components/sidebar";
import { StudyGrid } from "./components/study-grid";
import { Topbar, type GridFilters } from "./components/topbar";
import type { ObserverData } from "./lib/observer-data";
import { buildPlayerModel } from "./lib/player-model";

const NO_FILTERS: GridFilters = { status: "", kind: "", query: "" };

export function App({ data }: { data: ObserverData | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<GridFilters>(NO_FILTERS);

  const streams = data?.streams ?? [];
  const selected = selectedId !== null ? streams.find((s) => s.id === selectedId) ?? null : null;
  const playerModel = selected ? buildPlayerModel(selected) : null;

  const step = (delta: number) => {
    if (streams.length === 0) return;
    const index = selected ? streams.findIndex((s) => s.id === selected.id) : 0;
    const nextStream = streams[(index + delta + streams.length) % streams.length];
    if (nextStream) setSelectedId(nextStream.id);
  };

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
      {selected === null ? <Sidebar data={data} onRuns={() => setSelectedId(null)} /> : null}
      <div className="main">
        <Topbar
          data={data}
          selected={selected}
          filters={filters}
          onFilters={setFilters}
          onRuns={() => setSelectedId(null)}
          onStep={step}
        />
        <div className={selected && playerModel ? "content player-host" : "content"}>
          {selected ? (
            playerModel ? (
              <Player data={data} stream={selected} model={playerModel} />
            ) : (
              <ParticipantStub data={data} stream={selected} />
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
