# Participant inboxes

This page describes local capture. For fresh hosted inboxes, see
[real email receiving](real-email-receiving.md); that route has a separate
parsed renderer, strict remote-asset blocking and private lease lifecycle.

The catch captures application mail without sending it to an external recipient.
Humanish gives each participant an address and a matching
`/inbox/for/<address-digest>` URL. The same address scope applies to list, message,
plain view, latest-message and JSON routes. Navigating back from a missing message
stays in that scope. An unknown scope is empty; it never falls back to all mail.
A lane without an assigned address receives no inbox instruction.

This works with separate participant worlds, shared worlds, and an external catch.
Sharing an application world does not require sharing an inbox. If a lab deliberately
assigns the same address to two participants, both see that address's mail. Generated
addresses that collide after normalization are made distinct. A message addressed
to several participants appears in each recipient's inbox and retains its actual
To field.

`/inbox` remains available and is labeled **Shared operator inbox**. Address digests
are routing identifiers, not authentication credentials. The catch is study
infrastructure, not a mailbox service with hostile-tenant isolation. Keep its network
exposure appropriate for test mail. The read-only listener cannot expose the private
`/deliveries` drain, even when supplied a valid drain token. The capture listener
retains its existing optional bearer-token protection for that endpoint.

A standalone catch tracks its generated files. Reusing its directory with a changed
`--recipient` roster or an emptied delivery log removes obsolete message, latest and
recipient routes; unrelated files are untouched.

## Existing external catches

Upgrade the Humanish installation that runs `humanish comms catch` and **restart that
catch process**, as well as upgrading the installation that starts the study. Updating
only the study client leaves an older catch without participant routes.

Before allocating participants, the client checks `/health` on both `catchBaseUrl`
and a distinct `inboxBaseUrl`. Each must return the normal service marker and
`capabilities: ["recipient-inbox-v1", ...]`. Missing, malformed or older responses
fail admission with an upgrade/restart instruction. Existing email capture endpoints
and unscoped operator URLs remain available; their payload contracts are unchanged.

## Captured and remote images

The SMTP catch preserves MIME parts with a Content-ID when they contain PNG, JPEG,
GIF or WebP bytes. The generic `/emails` payload can also carry runtime-only
`inlineImages` entries with `contentId`, `contentType` and `base64`. Provider-specific
attachment fields are not converted; unsupported or missing CID references show an
explicit unavailable-image placeholder instead of pretending capture succeeded.

Captured images are limited to 12 entries, 1 MiB each and 2 MiB total. The renderer
checks canonical base64 and the declared raster format's signature before creating a
data URL. This is not a full image decoder; malformed raster content can still fail
in the browser. Inline data URLs receive the same per-image checks. SVG, arbitrary
attachment URLs and local paths are not fetched or converted.

HTTP(S) images remain browser loads with `no-referrer`. Humanish does not fetch or
proxy them server-side. Relative image URLs use the existing declared origin-rewrite
map when available; otherwise they receive an explicit placeholder. Remote URLs that
return errors retain the browser's alt-text fallback. The renderer does not claim to
repair a dead URL. The inbox retains `script-src 'none'` and the existing HTML
neutralization and origin-rewrite protections.

Raw mail and image bytes remain runtime catch data. Persisted comms evidence remains
digest-only; adding image capture does not add raw attachments to the run artifact.

## Reproduce the contract

```bash
pnpm exec vitest run tests/comms*.test.ts
pnpm exec tsx scripts/comms-inbox-proof.ts
```

The browser proof starts owned loopback HTTP, read-only inbox and SMTP listeners,
sends fictional multipart mail through the real MIME parser, and renders two recipient
inboxes in Chromium at desktop and phone sizes. It checks decoded CID/data/remote
images, unavailable sources, a genuine remote 404, recipient isolation across HTML
and JSON, navigation, script blocking, referrer suppression, directory reuse and drain
access. Screenshots and a machine-readable receipt are saved under the ignored
`.humanish/comms-inbox-proof/` directory. It uses no external email delivery, paid model
calls or hosted desktop, and makes no claim about those providers.
