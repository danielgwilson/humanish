// Is this directory a humanish project at all? (#455)
//
// The surface has two very different empty states and used to render one screen for both. A
// project with no labs yet needs "write one"; a directory that is not a project — someone's home
// directory, because `npx humanish tui` is easy to type anywhere — needs to know that first. The
// second is what Daniel hit, and being told "no labs here yet" in `~` reads as a broken tool.

import { existsSync } from "node:fs";
import path from "node:path";

export const TUI_PROJECT_SCHEMA = "humanish.tui-project.v1";

export interface TuiProjectState {
  schema: typeof TUI_PROJECT_SCHEMA;
  /** A committed `humanish/` source directory: this project has been `init`-ed. */
  initialized: boolean;
  /** A `.humanish/` runtime directory: something has been run here, even if source is absent. */
  hasRuntime: boolean;
}

export function readProjectState(cwdInput: string): TuiProjectState {
  const cwd = path.resolve(cwdInput);
  return {
    schema: TUI_PROJECT_SCHEMA,
    initialized: existsSync(path.join(cwd, "humanish")),
    hasRuntime: existsSync(path.join(cwd, ".humanish"))
  };
}
