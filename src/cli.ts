#!/usr/bin/env node

import { normalizeCliArgv } from "./argv.js";
import { preflightObserverNext } from "./observer.js";
import { createProgram } from "./program.js";

// HUMANISH_OBSERVER=next resolves (and in a repo checkout, builds) the rebuilt
// Observer artifact up front, so a problem surfaces before any run does work.
preflightObserverNext();

await createProgram().parseAsync(normalizeCliArgv(process.argv));
