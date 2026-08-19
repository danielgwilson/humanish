# tui/ — the stakeholder terminal surface (#455)

An Ink 7 + React 19 app, bundled by esbuild into ONE file (`dist/tui-app.js`)
that ships inside the humanish package and is loaded on demand by
`humanish tui`. Every other humanish command is built so an agent can drive it;
this is the one that takes the screen and waits for a person.

The bundle is a VIEW LAYER. Everything humanish knows how to do is injected
across `src/tui-contract.ts` (repo root `src/`, not this workspace), so this
app never becomes a second implementation of "what is a run, which lab does it
belong to, is it alive" that can drift from `humanish runs`.

## Commands

From the repo root (pnpm workspace):

- `pnpm --filter humanish-tui typecheck`
- `pnpm --filter humanish-tui test` — navigation + text goldens
- `pnpm --filter humanish-tui build` — the bundle at `tui/dist/tui-app.js`
- `pnpm tui:smoke` — loads the BUILT bundle and renders a real frame
- `UPDATE_TUI_GOLDENS=1 pnpm --filter humanish-tui test` — regenerate goldens,
  deliberately, and read the diff before committing

## Layout

- `src/entry.tsx` — the bundle's only export (`startTui`); everything else is
  reached through it
- `src/app.tsx` — data load, keyboard handling, and the frame chrome
- `src/navigation.ts` — the screen stack as a pure reducer, so the whole
  navigation model is testable without a terminal
- `src/screens/` — labs, lab, run
- `src/testing/render-to-text.tsx` — the in-repo render harness
- `tests/golden/*.txt` — committed frames at 80 and 45 columns
- `build.mjs` — esbuild config, including the two bundling workarounds below

## How to verify a change

A ladder. Start at the top; only descend when the rung above genuinely cannot
answer the question.

1. **Text goldens** (`tests/`) — the default, and where narrow-width work
   belongs. These render through real yoga layout at exact widths against a
   fake stdout, so they catch the entire class of layout bug (a status column
   colliding with a name, a path wrapping to two lines, a row overflowing a
   phone-width screen) with no terminal, no subprocess, and no sleeps. They
   wait on frame PREDICATES, never timers — a fixed sleep captures whichever
   frame the scheduler happened to reach, which is how TUI suites become flaky.
   Run them at least once as `CI=true pnpm --filter humanish-tui test` before
   pushing. Ink asks `is-in-ci` whether the environment is interactive and, when
   it decides not, writes ONLY THE FINAL FRAME AT UNMOUNT — no erase sequences,
   no intermediate renders. A suite that waits for frames then passes locally
   and fails every render test in CI. Both the harness and `entry.tsx` pass
   `interactive: true` to stop an environment variable deciding this, and a test
   pins it, but the habit is cheap and catches the next divergence of this kind.

2. **Bundle smoke** (`pnpm tui:smoke`) — loads the built artifact with fake TTY
   streams. This is the only thing that catches load-time failures, and
   load-time failures are the characteristic way a bundled Ink app breaks: it
   builds clean, passes every unit test, and dies the first time a user runs it.
3. **A real terminal** — only for "does this work for a human", never for
   layout. See the hazard below before reaching for tmux.

## The tmux hazard (read this before automating a real terminal)

On 2026-08-19 this workspace's own testing crashed the machine's tmux server
twice, taking every session on it down with it. The cause is understood and
worth not rediscovering:

- `window-size manual` makes the size of a NEW window come from `default-size`
  (see `man tmux`). tmux 3.4 walks that path in `clients_calculate_size` while
  the window does not exist yet and dereferences a NULL `struct window *`.
  Both crashes faulted at a byte-identical address, and it reproduces on an
  isolated socket in three commands — a deterministic bug, not a flake.
- `-g` is what made it catastrophic rather than local. `tmux set-option -t SESS
  -g window-size manual` sets the option SERVER-WIDE; the `-t` does not scope
  it. One server means every session on the machine dies together.
- The obvious replacement does NOT work on a shared server. `new-session -x 36
  -y 14` alone yielded a 59-column pane here, because the default `window-size
  latest` sizes the window to the most recently active client and overrides
  `-x`/`-y`. Measure `#{pane_width}` before trusting a width.

So, if a real terminal is genuinely needed:

- Prefer a plain PTY over a multiplexer. A PTY has no server, no global option
  surface, and no blast radius beyond itself. This works today and needs
  nothing installed:

  ```bash
  timeout 25 script -qec 'stty cols 92 rows 30; node dist/cli.js tui' /dev/null
  ```

  The `stty` is not optional: `script` with no controlling terminal reports
  `isTTY=true` but `columns=0`, so a size set any other way is silently ignored.
  Use `node-pty` instead if a check needs to send keys and read frames back, and
  `@xterm/headless` if output ever needs parsing for colour, cursor or
  alt-screen assertions — that pairing is what the terminal-testing tools
  (xterm.js/VS Code, termless) converge on.
- If tmux is still the right tool, put it on its OWN socket
  (`tmux -L humanish-tui …`) so a tmux bug can only kill that server, and size
  windows with `resize-window -t <session> -x W -y H`, which is scoped to the
  window. Never `-g`.

## Rules

- Ink's `<Text>` props are not optional-with-undefined and this repo compiles
  with `exactOptionalPropertyTypes`, so pass colour through `src/text-props.ts`
  (`{...color(maybe)}`) rather than `color={maybe}`.
- Measure terminal size from Ink's own `useStdout`, never from a prop. Two
  different stdout objects means laying out to one width and drawing into
  another — silently, and only visibly at narrow widths.
- Two bundling workarounds in `build.mjs` are load-bearing; removing either
  produces a bundle that builds and then crashes on first run:
  `react-devtools-core` is an optional peer Ink imports at module scope and
  must be STUBBED (marking it `external` leaves a static import Node resolves
  eagerly), and several Ink dependencies are still CommonJS, so the ESM output
  needs a `createRequire` banner or esbuild's `__require` shim throws on
  `require("node:*")`.
- Keep the surface honest in the same way the evidence surfaces are: an unknown
  cost is "not recorded" and never `$0.00`, a statistic carries its denominator,
  truncation is visible, and a project that cannot be read says so instead of
  rendering an empty one.
