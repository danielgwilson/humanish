# AgentMail receiving wire fixtures

These projections derive from successful live first-party API captures on
2026-09-20, retained outside the public repository. The experiment exercised
read-only authentication, two fresh inboxes, replayed creation, scoped received
messages, full message content, inline-image download descriptors, pagination,
and asynchronous deletion through a not-found readback.

HTTP status, response structure, enum labels, content types, byte sizes and
error codes are preserved. Identifiers, account metadata, addresses, timestamps,
headers, text and HTML were replaced with fictional fixture values. Signed
URLs were already withheld in private captures; the fixture uses the observed
`https://cdn.agentmail.to` origin and a synthetic path/query. No original account
identifier, address, email body, credential or signed URL is included.

The page-one/page-two captures came from an unfiltered listing (sent and received
copies); tests derive adversarial receiving-only pagination variants explicitly.
The 68-byte image is the synthetic one-pixel PNG used by the live experiment.
Mutated fixtures in tests exercise failures and are not claims of additional
observed provider behavior. These fixtures establish transport contracts only,
not participant behavior or target-app delivery.
