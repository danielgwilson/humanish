# Run the examples

Each folder is a complete example that ships in the npm package. After `npm install humanish`, run
one from `node_modules/humanish/examples/`. Both need Node.js 22.19 or newer, and neither needs a
key. `pnpm api:proof`, part of `pnpm release:check`, runs both against the packed package.

- [participant/](participant/README.md): bring your own participant. A synthetic loopback app is
  driven through its state contract by a `CuaExecutor` and a deterministic provider, with no
  browser, screenshots or E2B.
- [scorer/](scorer/README.md): score a run with your own rubric. One scorer module is attached to a
  dry run from a library caller and from the CLI, with no desktop or running app.
