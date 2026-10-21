import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/_throwaway*",
      "**/zz-*",
      "**/zzz-*",
      "**/*.scratch.test.ts",
    ],
    restoreMocks: true,
    // The repo default; render tests over 40 participants pass 5 s on a loaded box.
    testTimeout: 20_000,
  },
});
