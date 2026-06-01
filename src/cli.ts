#!/usr/bin/env node

import { normalizeCliArgv } from "./argv.js";
import { createProgram } from "./program.js";

await createProgram().parseAsync(normalizeCliArgv(process.argv));
