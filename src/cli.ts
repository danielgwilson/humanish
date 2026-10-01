#!/usr/bin/env node

import { preflightObserverArtifact } from "./observer/artifact.js";
import { createProgram, normalizeCliArgv } from "./cli/program.js";

// Resolve (and in a repo checkout, build) the Observer artifact up front, so a
// problem surfaces before any run does work — never after a completed session.
preflightObserverArtifact();

await createProgram().parseAsync(normalizeCliArgv(process.argv));
