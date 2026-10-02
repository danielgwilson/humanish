# Desktop startup retains cleanup ownership (#581)

On 2026-09-05, four sequential provider probes exercised the guarded loader at
`25c5116` with `@e2b/desktop` 2.3.3 and `e2b` 2.46.1. Two injected a failure in
the first desktop bootstrap command after the real API allocation and SDK
constructor. Two allowed normal desktop startup, then checked the display with
`xdpyinfo -display :0`.

| Probe | Operation | Result | Cleanup | Exact-ID verification | Total wall time |
| --- | --- | --- | --- | --- | --- |
| 1 | Fail after allocation | Create rejected with `cleanup: killed` | Guard killed its instance | Not found | 0.931 s |
| 2 | Fail after allocation | Create rejected with `cleanup: killed` | Guard killed its instance | Not found | 0.781 s |
| 3 | Normal startup | Display ready | Caller killed returned instance | Not found | 1.508 s |
| 4 | Normal startup | Display ready | Caller killed returned instance | Not found | 2.083 s |

All four used the stock desktop template, a 1280 × 800 display, a two-minute
provider timeout, and `onTimeout: kill`. There were no model calls. Provider
billing was unavailable; the 5.303 seconds above measure total probe wall time,
not a billed usage total. The retained operator receipt includes allocation IDs
and per-instance lifecycle events; these connection identifiers are omitted here.

The installed SDK's unguarded `create` constructs an instance and then starts
Xvfb/XFCE. A bootstrap exception loses that instance before the caller receives
it. The guard captures its bound `kill` method during construction and awaits
bounded cleanup before surfacing the startup failure. Cleanup failure or timeout
suppresses the normal transient-create retry. No account-wide lookup is used.

The regression suite runs the real installed SDK in debug mode, with its provider
allocator forbidden and local command/kill fault ports. It proves constructor
ordering, both template overloads, failures in Xvfb/display verification/XFCE,
concurrent ownership isolation, cleanup-before-retry, already-gone cleanup, and
bounded unconfirmed cleanup. This conformance suite must pass when SDK
dependencies change.

Not verified by the live probes: API failures before a constructor returns,
provider cleanup failure/timeout, concurrent live creates, or a real intermittent
provider bootstrap outage. Those first failures still have no acquired handle;
the provider timeout remains their backstop. Forced failures prove the ownership
boundary without depending on an intermittent outage recurring.
