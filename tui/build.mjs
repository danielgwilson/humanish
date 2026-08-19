// Bundle the Ink app to ONE file that ships inside the humanish package.
//
// Why bundle at all: `npx humanish tui` has to work first-try. Ink pulls ~25 transitive
// dependencies, and making them optional peers does not work — npm does not install optional
// peerDependencies, so the command would fail on exactly the fresh machine it most needs to work
// on. Making them ordinary dependencies would instead put that tree in every user's install,
// including the agents who never open a terminal UI. Bundling puts the bytes in the tarball and
// nothing in the user's node_modules.
//
// The bundle is a VIEW LAYER ONLY. Everything humanish knows how to do — reading the run index,
// projecting it, launching runs — is injected by the CLI (see src/tui-contract.ts), so this file
// never becomes a second copy of the product's logic that can drift from the tested one.

import { build } from "esbuild";

// Ink imports `react-devtools-core` at module scope and only USES it when DEV is set. Marking it
// `external` leaves a static import that Node resolves eagerly at load, so the published bundle
// would crash on a machine that (correctly) does not have this optional peer installed. It has to
// be replaced with an empty module, not externalized.
const stubOptionalPeers = {
  name: "stub-optional-peers",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {}; export const connectToDevTools = () => {};",
      loader: "js"
    }));
  }
};

const result = await build({
  entryPoints: ["src/entry.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/tui-app.js",
  jsx: "automatic",
  minify: true,
  // Minified, but function names survive so a stack trace in a user's bug report still names
  // something real.
  keepNames: true,
  plugins: [stubOptionalPeers],
  // Several of Ink's dependencies are still CommonJS (signal-exit@3 among them). Bundled into an
  // ESM output, esbuild's `__require` shim throws on any `require("node:*")`. Defining a real
  // `require` in module scope makes the shim delegate to it instead.
  banner: {
    js: [
      "import { createRequire as __humanishCreateRequire } from 'node:module';",
      "const require = __humanishCreateRequire(import.meta.url);"
    ].join("\n")
  },
  metafile: true,
  logLevel: "warning"
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`tui bundle: ${(bytes / 1024).toFixed(0)}KB`);
