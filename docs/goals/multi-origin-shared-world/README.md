# Multi-origin shared-world current status

Status date: 2026-07-14

The core multi-origin design direction is ratified, but implementation is not
authorized and no runtime or schema support exists.

The dated [`design.md`](design.md) packet remains the historical design record
and is kept verbatim. This file records the later program decision:

- use the additive `subject.apps` / per-lane app-provenance direction if the
  implementation gate opens;
- keep existing single-origin bundles compatible;
- do not implement until a real adopter proves that cross-origin behavior is
  required and a single-origin deployment or downstream facade would distort
  that behavior;
- surface the implementation packet to the maintainer for review before build
  work starts.

Issue [#239](https://github.com/danielgwilson/humanish/issues/239) is the public
tracker. A shipped single-origin capability or synthetic fixture does not open
this gate by itself.
