import { type BrowserLabAdapterHooks } from "../../lab/adapter-extension.js";
import type { CuaActorSessionOptions } from "../../actors/computer-use/actor.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import { type E2BDesktopModule, type E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { type DetachedTimers } from "../../substrates/detached.js";
import { renderObserver } from "../../observer/render.js";
import type { LocalTreeArchive } from "../../run/source-archive.js";

/**
 * Library-level hooks mirroring CuaActorLabHooks — the DI seams that let CI drive the FULL
 * orchestration with fakes at $0/zero-network. The fake desktop module records create/kill BY id
 * and exposes NO `list` method (the by-id teardown rail is then provable by construction).
 */
export interface SharedWorldLabHooks extends BrowserLabAdapterHooks {
  /** Lazy-load the E2B desktop module (tests inject a fake; default loadE2BDesktopModule). */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  /**
   * Runs after a sandbox is created and before anything is provisioned on it. The provisioned
   * plane calls it for the subject sandbox with no lane, then for each seat's desktop with its lane;
   * the external-public plane calls it for the seats only.
   */
  prepareDesktop?: (
    desktop: E2BDesktopSandbox,
    lane?: { laneId: string; laneIndex: number; laneCount: number },
  ) => Promise<void>;
  /**
   * Awaited after a seat's live desktop stream starts. The URL carries an auth key and must never
   * be persisted. A rejection becomes a run warning, as on the computer-use route.
   */
  onRuntimeStreamReady?: (stream: {
    laneId: string;
    sandboxId: string;
    simId: string;
    streamId: string;
    url: string;
  }) => Promise<void> | void;
  /** Awaited after a seat's sandbox is gone, for seats whose stream started. Rejections are swallowed. */
  onRuntimeStreamEnded?: (stream: {
    laneId: string;
    simId: string;
    streamId: string;
  }) => Promise<void> | void;
  /** The per-seat computer-use session runner (default: the resolved actor descriptor's). */
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /** The operator environment (keys + subject env values). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
  /**
   * Subject-provisioning phase sink (mirrors CuaActorLabHooks.onPhase): one call per
   * started/completed boundary during the ONE shared-plane provision (clone route: clone, install,
   * build, serve start, ready, subject.state seed-step groups; local-tree route: upload, extract,
   * install, build, serve start, ready, seed-step groups - no clone phase). Defaults to one stderr
   * line per event. Override in tests to capture instead of writing to real stderr.
   */
  onPhase?: (event: SubjectPhaseEvent) => void;
  /**
   * CONCURRENT route only (#164 phase 2): the harness clock used to MEASURE each actor's laneWindow
   * [start,end] (default Date.now). The deterministic heart test does NOT override this — overlap is
   * produced by a rendezvous latch in the fake runSession + measured by the REAL clock (FIX-1), so
   * the windows are real, not injected. (A test may override only for non-overlap assertions.)
   */
  now?: () => number;
  /** CONCURRENT route only: the background stateSeries prober cadence (ms). Default 1000. */
  proberCadenceMs?: number;
  /**
   * EXTERNAL-PUBLIC concurrent route only (#164 phase 2): the host-first handoff barrier deadline
   * (ms). The host seat must surface a shared-session (/lobby/CODE) URL within this budget or the run
   * fails closed with HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT and no follower opens.
   * Default 120000 (also capped by execution.timeoutMs). Tests inject a short value to exercise the
   * fail-closed path deterministically.
   */
  handoffDeadlineMs?: number;
  /**
   * EXTERNAL-PUBLIC concurrent route only: the vision reader that extracts a /lobby/CODE off a seat's
   * screenshot frame (the CDP-independent handoff relay + per-seat convergence observation). Defaults to
   * the real single-frame OpenAI read (readLobbyCodeFromFrame). Tests inject a fake so the barrier's
   * handoff + convergence proof can be exercised deterministically without a live vision call.
   */
  readLobbyCodeFromFrame?: (frame: Buffer, apiKey: string) => Promise<string | undefined>;
  /**
   * Local-tree packing DI seam (tests only, no npm dependency needed to exercise the route):
   * defaults to createLocalTreeArchive(root, opts) plus a host-side read of the produced archive
   * file into an ArrayBuffer (the SAME default routes/computer-use/lab.ts uses). Called ONCE per run, before
   * the ONE shared-plane sandbox is created, on the live local-tree route.
   */
  packLocalTree?: (args: {
    root: string;
    extraExclude?: string[];
    maxArchiveBytes?: number;
  }) => Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }>;
}
