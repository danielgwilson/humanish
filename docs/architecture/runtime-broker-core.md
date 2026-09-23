# Runtime broker authority core

The source-only [broker core](https://github.com/danielgwilson/humanish/blob/main/runtime/broker/README.md)
defines bounded requests and lease decisions for a future Linux runtime owner.
It is not an installed service, resource controller, or public runtime mode.

Requests cannot supply host paths, service names, commands, user identities,
resource limits or cleanup claims. The future transport obtains the peer UID
from the operating system and checks it against owner policy. A separate
generation capability authorizes each study; default diagnostics and serialized
ledgers omit the raw capability. Repeating an acquisition or allocation attempt
does not mint a second resource.

The model reserves capacity through uncertain creation and cleanup. Expiry,
revocation, detected sleep and host-clock discontinuity cannot be undone by a
late renewal. A saved launch plan is not dispatch authority: the owner must
revalidate it immediately before starting a resource. Only a separate owner
attestation that creation has settled and the acquired resources are absent can
free a reservation. Recovery reads the ledger for reconciliation, never to resume
a study or adopt resources by their names.

The owner must persist intent before consuming effects, advance trusted time
independently of requests, and bind every resource to actual acquired OS
identities. The pure model does none of those OS operations. Its tests establish
protocol and state transitions; they do not establish peer authentication,
durable writes, process containment, watchdog timing, sleep detection or cleanup.

Installation, root-owned storage, authenticated sockets, service supervision,
artifact verification and VM/network control require separate implementation
and privileged qualification. The existing npm execution routes are unchanged.
