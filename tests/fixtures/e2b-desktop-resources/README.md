# E2B resource observation fixture

`observed-resources.json` projects two retained September 5, 2026 stock desktop
allocations returned by instance `desktop.getInfo()` on `@e2b/desktop` 2.3.3
(base SDK 2.46.1). The values were copied from the retained allocation receipts;
they were not invented from SDK documentation. Only `cpuCount` and `memoryMB`
are preserved. Provider identifiers, timestamps, and all other metadata are
omitted. E2B's `memoryMB` quantity is MiB; 8192 means 8 GiB for pricing.

The fixture proves the observed field names and resource values. Its replay
through the cost builder is deterministic proof, not a new live allocation.
Tests that substitute other resource sizes are explicit synthetic variations.
