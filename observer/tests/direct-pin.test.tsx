// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Tooltip } from "@base-ui-components/react/tooltip";
import { ParticipantCard } from "../components/participant-card";
import type { ObserverData } from "../lib/observer-data";
import fixture from "../../tests/golden/observer-data/first-run.json";

it("pins directly without opening details or the recording, and exposes the inverse action", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const stream = (fixture as unknown as ObserverData).streams[0]!;
  let opened = 0;
  function Surface() {
    const [pinned, setPinned] = useState(false);
    return <Tooltip.Provider><ParticipantCard stream={stream} name="Avery" updating={false}
      pinned={pinned} onPin={() => setPinned(value => !value)} onOpen={() => { opened++; }} /></Tooltip.Provider>;
  }
  try {
    await act(async () => root.render(<Surface />));
    const action = host.querySelector<HTMLButtonElement>(".card-pin-toggle")!;
    expect(action.getAttribute("aria-label")).toBe("Pin participant Avery to top");
    expect(action.getAttribute("aria-pressed")).toBe("false");
    await act(async () => action.click());
    expect(host.querySelector(".card-pin-toggle")).toBe(action);
    expect(action.getAttribute("aria-label")).toBe("Unpin participant Avery from top");
    expect(action.getAttribute("aria-pressed")).toBe("true");
    expect(action.querySelector('[aria-label="Pinned participant"]')).not.toBeNull();
    expect(document.querySelector(".pop-panel")).toBeNull();
    expect(opened).toBe(0);
    await act(async () => action.click());
    expect(action.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".card-pin")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
