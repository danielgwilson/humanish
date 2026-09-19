// Renderer-owned raster entries are separate from untrusted run-data strings. A
// reference cannot load a URL, execute HTML/SVG, or escape to a sibling file.
const cache = new WeakMap<Document, Map<string, string | null>>();
const MAX_BASE64_LENGTH = Math.ceil(64 * 1024 * 1024 / 3) * 4;

export function exportScreenshotHref(reference: string, doc: Document | undefined = typeof document === "undefined" ? undefined : document): string | null {
  const match = /^humanish-asset:([a-f0-9]{64})$/.exec(reference);
  if (!match || !doc) return null;
  let images = cache.get(doc);
  if (!images) { images = new Map(); cache.set(doc, images); }
  if (images.has(reference)) return images.get(reference) ?? null;
  let href: string | null = null;
  const element = doc.getElementById(`humanish-image-${match[1]}`);
  const mime = element?.getAttribute("data-mime") ?? "";
  if (element?.tagName === "SCRIPT" && element.getAttribute("type") === "application/octet-stream"
    && /^image\/(?:png|jpeg|gif|webp)$/.test(mime)) {
    const encoded = element.textContent ?? "";
    if (encoded.length > 0 && encoded.length <= MAX_BASE64_LENGTH && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        href = URL.createObjectURL(new Blob([bytes], { type: mime }));
        // Keep one browser-owned copy, not the base64 DOM text plus every repeated
        // capture/context reference. Object URLs live for this document's lifetime.
        element.remove();
      } catch { /* Invalid raster encoding or unavailable Blob support fails closed. */ }
    }
  }
  images.set(reference, href);
  return href;
}
