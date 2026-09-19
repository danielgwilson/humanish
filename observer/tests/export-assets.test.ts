// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { exportScreenshotHref } from "../lib/export-assets";
import { screenshotHref, runArtifactHref } from "../lib/artifact-href";

const hash = "a".repeat(64);
const reference = `humanish-asset:${hash}`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=";
function doc(mime = "image/png", base64 = png, tag = "script", type = "application/octet-stream") {
  return new DOMParser().parseFromString(`<${tag} id="humanish-image-${hash}" type="${type}" data-mime="${mime}">${base64}</${tag}>`, "text/html");
}
afterEach(() => vi.unstubAllGlobals());

it("decodes a registered raster once and releases the duplicate base64 DOM text", async () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:synthetic-owned-raster");
  vi.stubGlobal("URL", { createObjectURL });
  const document = doc();
  expect(exportScreenshotHref(reference, document)).toBe("blob:synthetic-owned-raster");
  expect(exportScreenshotHref(reference, document)).toBe("blob:synthetic-owned-raster");
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  const blob = createObjectURL.mock.calls[0]![0] as Blob;
  expect(blob.type).toBe("image/png");
  expect(blob.size).toBe(atob(png).length);
  expect(document.getElementById(`humanish-image-${hash}`)).toBeNull();
});

it.each([
  ["image/svg+xml", png, "script", "application/octet-stream"],
  ["text/html", png, "script", "application/octet-stream"],
  ["image/png", "AAAA<script>", "script", "application/octet-stream"],
  ["image/png", "a", "script", "application/octet-stream"],
  ["image/png", png, "div", "application/octet-stream"],
  ["image/png", png, "script", "application/json"]
])("refuses an unregistered/unsafe raster %s", (mime, base64, tag, type) => {
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL });
  expect(exportScreenshotHref(reference, doc(mime, base64, tag, type))).toBeNull();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("scopes cached references to their document and never accepts arbitrary Blob URLs", () => {
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:synthetic-owned-raster") });
  expect(exportScreenshotHref(reference, doc())).toBe("blob:synthetic-owned-raster");
  expect(exportScreenshotHref(reference, doc().implementation.createHTMLDocument())).toBeNull();
  for (const value of ["blob:unregistered", "humanish-asset:../anything", "humanish-asset:__proto__", reference]) {
    expect(screenshotHref(value)).toBeNull();
    expect(runArtifactHref(value)).toBeNull();
  }
});
