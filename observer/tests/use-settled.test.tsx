// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettled } from "../lib/use-settled";

let container: HTMLDivElement;
let root: Root;
let latest = false;
function Probe({ value }: { value: boolean }) {
  latest = useSettled(value, 400);
  return null;
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useSettled", () => {
  it("ignores a loading state that ends before the delay", async () => {
    await act(async () => root.render(<Probe value={true} />));
    expect(latest).toBe(false);
    await act(async () => vi.advanceTimersByTime(300));
    expect(latest).toBe(false);
    await act(async () => root.render(<Probe value={false} />));
    await act(async () => vi.advanceTimersByTime(500));
    expect(latest).toBe(false);
  });
  it("reports a loading state that outlasts the delay, and clears at once when it ends", async () => {
    await act(async () => root.render(<Probe value={true} />));
    await act(async () => vi.advanceTimersByTime(450));
    expect(latest).toBe(true);
    await act(async () => root.render(<Probe value={false} />));
    expect(latest).toBe(false);
  });
});
