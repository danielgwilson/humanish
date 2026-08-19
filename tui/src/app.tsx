import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useState } from "react";

import type { TuiOptions } from "../../src/tui-contract.js";
import { fitPathToWidth } from "./fit-text.js";
import { useTerminalSize } from "./use-terminal-size.js";

/** What the shell knows about the project. `undefined` means "not read yet", never "none". */
interface ProjectState {
  runs: number;
  labs: number;
  live: number;
  unreadable: number;
}

export interface AppProps {
  options: TuiOptions;
  /** Resolves once the first frame has been rendered with real data (test + smoke seam). */
  onReady?: () => void;
}

export function App({ options, onReady }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const size = useTerminalSize(options.stdout);
  const [project, setProject] = useState<ProjectState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const index = await options.capabilities.readRunIndex(options.cwd);
        if (cancelled) return;
        const labs = new Set<string>();
        let live = 0;
        for (const run of index.runs) {
          if (run.lab?.id !== undefined) labs.add(run.lab.id);
          if (run.liveness === "running") live += 1;
        }
        setProject({ runs: index.runs.length, labs: labs.size, live, unreadable: index.unreadable.length });
      } catch (cause) {
        if (cancelled) return;
        // A surface that cannot read the project says so. It does not render zeroes, which would
        // be indistinguishable from an empty project.
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [options]);

  // Signalled from its OWN effect rather than from the fetch, so it fires after React has committed
  // the data-bearing render and Ink has written that frame. Firing it beside `setProject` reports
  // ready while the screen still says "reading runs…" — which is what the bundle smoke caught.
  useEffect(() => {
    if (project !== undefined || error !== undefined) onReady?.();
  }, [project, error, onReady]);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
  });

  return (
    <Box flexDirection="column" width={size.columns}>
      <Box justifyContent="space-between">
        <Text bold>humanish</Text>
        <Text dimColor>v{options.version.cli}</Text>
      </Box>
      <Text dimColor>{fitPathToWidth(options.cwd, size.columns)}</Text>
      <Box marginTop={1} flexDirection="column">
        {error !== undefined ? (
          <Text color="red">could not read this project: {error}</Text>
        ) : project === undefined ? (
          <Text dimColor>reading runs…</Text>
        ) : (
          <Summary project={project} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>q quit</Text>
      </Box>
    </Box>
  );
}

function Summary({ project }: { project: ProjectState }): React.ReactElement {
  if (project.runs === 0) {
    // An empty project is an ordinary state, not a failure, and it should say what to do next.
    return (
      <Box flexDirection="column">
        <Text>no runs yet</Text>
        <Text dimColor>run a lab to see it here</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        {project.runs} {project.runs === 1 ? "run" : "runs"}
        {project.labs > 0 ? ` across ${project.labs} ${project.labs === 1 ? "lab" : "labs"}` : ""}
      </Text>
      {project.live > 0 ? <Text color="green">{project.live} running now</Text> : null}
      {project.unreadable > 0 ? (
        <Text color="yellow">
          {project.unreadable} unreadable {project.unreadable === 1 ? "run" : "runs"}
        </Text>
      ) : null}
    </Box>
  );
}
