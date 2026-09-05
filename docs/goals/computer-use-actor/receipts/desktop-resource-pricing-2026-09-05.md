# Desktop compute estimates use observed allocation sizes

Date: September 5, 2026. Focused correction under [#298](https://github.com/danielgwilson/humanish/issues/298).

Humanish 0.81.0 used a 2-vCPU/4-GiB placeholder for every desktop minute.
Two retained stock desktop `getInfo()` observations instead report
`cpuCount: 8` and `memoryMB: 8192`, using `@e2b/desktop` 2.3.3 and base SDK 2.46.1.
The [public E2B sheet](https://e2b.dev/pricing), checked September 5, lists
$0.000112/s for eight vCPU and $0.0000045/GiB/s for RAM. Eight GiB therefore
gives $0.000148/s, or $0.00888/minute, versus the old $0.00276/minute.

The independent computer-use route now reads resource metadata once, after
journaling its owned sandbox handle. The read is bounded at one second and
cannot prevent cleanup. Each desktop cost line records the public lane ID,
observed CPU/MiB, resource source, measured minutes, and derived per-second rate.
Different templates are priced separately. Missing/malformed metadata and sizes
outside the published standard sheet remain unpriced. A kept desktop or
unconfirmed teardown adds an unknown remaining-lifetime line.

The legacy rate helper keeps a labeled 8-vCPU/8-GiB planning assumption. Runtime
estimates do not use it as a fallback. Existing bundles retain their recorded
prices and old aggregate desktop lines remain readable. Model caps still cover
model estimates only; this change does not introduce a provider spending limit.

## Retained-input replay

Two original run bundles and their allocation receipts were read without
modification. Their resource quantities, recorded host-measured minutes, and
confirmed cleanup status were supplied to the changed resource reader and cost
builder. The expected totals were computed separately from the public per-second
rates, and both matched to the estimator's six-decimal rounding.

| Retained run | Recorded minutes | Original desktop estimate | Revised desktop estimate |
| --- | ---: | ---: | ---: |
| `evening-todomvc-original-keyboard-only-1` | 0.7266666667 | $0.002006 | $0.006453 |
| `evening-todomvc-original-keyboard-only-2` | 0.7463166667 | $0.002060 | $0.006627 |

This is deterministic replay of live-recorded inputs, not a fresh live run of
the changed integration. No provider was called for the replay. Full inputs and
outputs remain operator-held; the public fixture preserves only the two CPU/RAM
shapes, with identifiers and all other metadata removed.

Tests cover both captured shapes, synthetic custom sizes, mixed known/unknown
fan-out, missing/nonfinite duration, metadata absence/errors/timeout and late
rejection, unconfirmed cleanup, and no-allocation previews. Real orchestration
tests prove metadata failures still leave the acquired handle reclaimed.
The full release gate passed 2,062 core and 49 TUI tests (10 skipped).

## Limits

The measured span begins after acquiring and journaling the handle; it omits
earlier provider allocation/startup time. The estimate excludes plan fees,
credits, negotiated enterprise prices, and other services used by the subject.
The public sheet establishes per-second running compute but no minimum charge
or startup rounding semantics; no such rule is invented here. These estimates
are not invoices. Shared-world, scripted-browser, and terminal routes do not
yet emit these per-desktop cost lines. The broader operator rate override in
#298 remains open.
