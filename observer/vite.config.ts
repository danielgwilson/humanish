import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The production build is ONE self-contained HTML file (#426): it must render from
// file://, offline, years after the run — so every asset (JS, CSS, fonts) is inlined
// and nothing may reference the network. tests/artifact-smoke.test.ts enforces both.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") }
  },
  build: {
    // Fonts (woff2) must become data: URIs, not emitted assets.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096
  }
});
