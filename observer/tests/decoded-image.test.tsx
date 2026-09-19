// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useDecodedImage } from "../lib/use-decoded-image";

it("promotes the decoded DOM node, rejects late loads, and keeps retry honest", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  function Surface({ href }: { href: string | null }) {
    const image = useDecodedImage(href);
    return <div data-status={image.status}>{href && image.slots.map((slot) => <img key={slot.key} src={slot.href}
      onLoad={(event) => { void image.loaded(event.currentTarget, slot.key); }} onError={() => image.errored(slot.key)} />)}<button onClick={image.retry}>Retry</button></div>;
  }
  const render = async (href: string | null) => { await act(async () => root.render(<Surface href={href} />)); };
  const load = async (image: HTMLImageElement, decode = Promise.resolve()) => {
    Object.defineProperties(image, { naturalWidth: { value: 390 }, naturalHeight: { value: 844 }, decode: { value: () => decode } });
    await act(async () => { image.dispatchEvent(new Event("load")); });
  };
  try {
    await render("first.png"); const first = container.querySelector("img")!; await load(first);
    await render("slow.png"); const slow = container.querySelectorAll("img")[1]!;
    let finish!: () => void; const decoding = new Promise<void>((resolve) => { finish = resolve; }); await load(slow, decoding);
    expect(container.querySelector("img")).toBe(first);
    await render("selected.png"); const selected = container.querySelectorAll("img")[1]!; await load(selected);
    expect(container.querySelector("img")).toBe(selected);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await act(async () => finish()); expect(container.querySelector("img")).toBe(selected);
    await render("missing.png"); const missing = container.querySelectorAll("img")[1]!;
    await act(async () => missing.dispatchEvent(new Event("error")));
    expect(container.firstElementChild?.getAttribute("data-status")).toBe("error");
    expect(container.querySelector("img")).toBe(selected);
    await act(async () => container.querySelector("button")!.click());
    const retry = container.querySelectorAll("img")[1]!; expect(retry).not.toBe(missing); await load(retry);
    expect(container.querySelector("img")).toBe(retry);
    expect(container.firstElementChild?.getAttribute("data-status")).toBe("ready");
    await render(null);
    expect(container.querySelector("img")).toBeNull();
    await render("missing.png");
    expect(container.firstElementChild?.getAttribute("data-status")).toBe("loading");
    expect(container.querySelector("img")).not.toBe(retry);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
