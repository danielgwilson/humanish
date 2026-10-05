import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStudyAnalysis, NO_ANALYSIS, type LoadedAnalysis } from "./study-analysis";
import type { ObserverData } from "./observer-data";
import {
  fetchHistoryIndex,
  fetchObserverData,
  isServedOrigin,
  type HistoryIndex,
  OBSERVER_POLL_MS,
  HISTORY_POLL_MS,
} from "./live";

export interface ObserverConnection {
  state: "connecting" | "current" | "retrying" | "offline";
  lastReceivedAt: number | null;
  /** The serving process stopped answering: several polls in a row got no response at all. */
  serverStopped?: boolean;
}

/** One failed poll is a hiccup. This many in a row, each with no response, is a stopped server. */
const SERVER_STOPPED_AFTER = 3;

export function useObserverFeed(
  initial: ObserverData | null,
  snapshot = false,
  initialAnalysis: LoadedAnalysis = NO_ANALYSIS,
) {
  const [data, setData] = useState(initial);
  const [analysis, setAnalysis] = useState(initialAnalysis);
  const currentData = useRef(data);
  currentData.current = data;
  const [history, setHistory] = useState<HistoryIndex | null>(null);
  const [connection, setConnection] = useState<ObserverConnection>({
    state: !snapshot && isServedOrigin(window.location.protocol) ? "connecting" : "offline",
    lastReceivedAt: null,
  });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((v) => v + 1), []);
  // Retry restarts polling. The count survives it, so a notice stays until a server answers.
  const unanswered = useRef(0);
  useEffect(() => {
    if (snapshot || !isServedOrigin(window.location.protocol)) return;
    let disposed = false;
    let runId = initial?.run.runId;
    let inFlight = false;
    let nextHistory = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let answered = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await window.fetch(input, init);
      answered = true;
      return response;
    };
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      answered = false;
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 15_000);
      try {
        const next = await fetchObserverData(fetchImpl, "observer-data.json", controller.signal);
        if (disposed) return;
        // A response of any status means a server is there. Only silence counts toward a stop,
        // and not while the browser itself reports no network.
        if (answered) unanswered.current = 0;
        else if (navigator.onLine !== false) unanswered.current += 1;
        if (next && (runId === undefined || next.run.runId === runId)) {
          runId = next.run.runId;
          setData(next);
          setConnection({ state: "current", lastReceivedAt: Date.now() });
        } else
          setConnection((prev) => ({
            ...prev,
            state: "retrying",
            serverStopped: unanswered.current >= SERVER_STOPPED_AFTER,
          }));
        if (Date.now() >= nextHistory) {
          const nextIndex = await fetchHistoryIndex(fetchImpl, controller.signal);
          if (!disposed && nextIndex) setHistory(nextIndex);
          nextHistory = Date.now() + HISTORY_POLL_MS;
        }
      } finally {
        clearTimeout(deadline);
        inFlight = false;
        if (!disposed)
          timer = setTimeout(
            () => void poll(),
            document.hidden ? HISTORY_POLL_MS : OBSERVER_POLL_MS,
          );
      }
    };
    const refresh = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    void poll();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [initial, revision, snapshot]);
  useEffect(() => {
    if (snapshot || !isServedOrigin(window.location.protocol)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (disposed) return;
      const observed = currentData.current;
      if (observed) {
        controller = new AbortController();
        const deadline = setTimeout(() => controller?.abort(), 15_000);
        try {
          const next = await fetchStudyAnalysis(
            (input, init) => window.fetch(input, init),
            observed,
            controller.signal,
          );
          if (!disposed && next) setAnalysis(next);
        } finally {
          clearTimeout(deadline);
        }
      }
      if (!disposed)
        timer = setTimeout(() => void poll(), document.hidden ? HISTORY_POLL_MS : OBSERVER_POLL_MS);
    };
    // Companion failures and latency never block the recording or library feed.
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [initial, revision, snapshot]);
  return { data, history, connection, retry, analysis };
}
