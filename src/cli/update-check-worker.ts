// Started detached by startRefreshWorker in update-check.ts, with the cache path as its argument.
import { refreshUpdateCache } from "./update-check.js";

const cachePath = process.argv[2];
if (cachePath !== undefined) await refreshUpdateCache({ cachePath });
