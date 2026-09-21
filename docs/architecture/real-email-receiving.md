# Real email receiving

A supported browser study can give each participant a fresh AgentMail inbox. The
application sends real email to that address; Humanish polls it on the host and
publishes a private inbox surface on that participant's desktop. The participant
can read the original email, switch to a plain view and follow an approved link.

Use local capture when you can redirect the app's send configuration and want to
avoid hosted mail. Use real receiving when the app must send normally or delivery
itself is part of the flow. These are separate modes; do not combine their settings.
SMS and participant outbound mail are not supported.

## Setup

Open `humanish tui`, press **c**, and add an AgentMail key. Hidden entry saves it
in the existing user key store and checks authentication without creating an inbox.
The project profile stores only the provider and environment-variable name.
Environment and explicit env-file values retain precedence over saved keys.
A rejected or unavailable authentication check does not delete the saved key.
Authentication does not prove inbox creation/deletion permissions, quota or delivery.
This release requires an organization-scoped key.

Connections can preview and save a receiving-enabled local lab copy. The preview
discloses hosted email, model processing, local review and separate provider charges.
The original manifest is preserved. Select the new exact path when launching.

The same operations are available to agents:

```bash
humanish keys set agentmail
humanish comms connections add agentmail --json
humanish comms check --online --json
humanish comms configure --lab humanish/labs/signup.yaml --json
# Review the returned path, disclosures and planToken, then:
humanish comms configure --lab humanish/labs/signup.yaml --apply --plan-token <digest> --json
humanish lab run .humanish/local/labs/signup-receiving.yaml --json --no-open
```

Direct manifest authoring selects a saved connection:

```yaml
comms:
  email:
    connection: agentmail
    # Optional: additional trusted email-link destinations, exact origins only.
    allowedOrigins:
      - https://accounts.example.test
```

The target origin is automatically allowed. On provisioned subjects, the declared
serve origin and optional `linkOrigin` use the existing target-origin rewrite.
Review additional origins as destinations the participant is allowed to open from
mail. This policy governs the inbox surface, not all later browser navigation.

Supported execution is hosted computer use with app-url, clone or local-tree
subjects, including concurrent shared-world studies. Sequential shared-world,
local-agent, scripted, terminal, desktop-cli, in-process and local-app routes reject
real receiving before allocation. Connection mode cannot declare capture options,
recipients or borrowed mailbox IDs. A fresh address is not an existing account;
assignments must allow signup or arranging mail to the new identity.

## What a run does

1. Resolve the selected connection and host credential. Reject forwarding that
   management credential through target environment names, aliases or literals.
2. Authenticate and durably record each acquisition intent in private host state.
   Acquire all participant addresses before starting desktops.
3. Give each participant its address and loopback inbox URL. No management key or
   other participant's mailbox is installed in its desktop. Each surface has only
   its own list/message/plain/JSON routes, with no send endpoint or aggregate inbox.
4. Poll received mail, register scrub targets, sanitize/render and atomically
   publish the complete inbox snapshot. Repeated reads can fill temporarily missing
   bodies and inline images without changing local message identity.
5. Before desktop teardown, perform a bounded final read, save evidence, stop the
   inbox surface and request deletion. Confirm provider absence; otherwise retain
   unresolved cleanup for recovery. Provider deletion is not an erasure guarantee.

The original view preserves supported email structure and inline PNG/JPEG/GIF/WebP
images. Parsed HTML removes active content; response CSP blocks scripts, forms,
frames and remote assets. Remote images show an explicit unavailable placeholder.
Links use the same origin policy in original, plain and JSON views. Attachment
bytes are fetched only through the fixed provider API and its observed CDN host;
provider authorization never goes to the CDN. General attachments, arbitrary remote
images and raw-MIME fallback are unsupported. Raster checks are bounded signature
checks, not a guarantee that every malformed image will decode in a browser.

Collection is bounded by request time, request/page count, bytes, images and a
100-message retained inbox limit. Limits, failed reads, blocked content and failed
publication are recorded as coverage limitations. Inbox pages require reload to
show later messages. No webhook/public mail ingress is required on the host.

## Evidence and publication

`comms/receiving.json` uses `humanish.comms-receiving.v2`. It records local IDs,
counts, timestamps and lifecycle/coverage status, without raw mail, provider IDs,
addresses or stable content digests. The final run bundle embeds that projection.
Receipt, successful inbox publication, participant reading and target success are
separate claims; analysis receives this distinction and the harness limitations.
A missing message alone does not establish that the application failed to send.
Immediate automatic analysis scrubs known exact values from generated narration
using a bounded, invocation-local registry. It never saves that registry. Later
analysis cannot reconstruct it; screenshots may still expose mail content, and the
publication restriction applies to both immediate and later findings.

Mail is hosted by AgentMail. Its content can reach the hosted desktop, actor model,
screenshots, narration and analysis model. Such runs carry a durable
`real-communications` publication restriction: verification returns `local_only`,
public feedback/exposure and shareable exports remain gated, and screenshot
blurring does not clear the restriction. Local Observer review and explicitly local
HTML export remain available. Local-only publication is not local-only processing.

## Interrupted-run recovery

Process interruption can bypass normal final reads and teardown. Inspect recovery
state after stopping a run; do not assume Ctrl+C or killing a process deleted its
inboxes:

```bash
humanish comms recover --json
humanish comms recover --run <run-id> --apply --json
```

Connections also exposes pending cleanup. Recovery only uses private host journals
under `$XDG_STATE_HOME/humanish/comms` (default `~/.local/state/humanish/comms`),
with private directories/files and bound project, connection, account and scope.
A live or unknown owner blocks takeover. The adapter checks resource/client identity
before deletion; it cannot delete an inbox named only in a run artifact. Lost
creation responses can be reconciled through the recorded idempotent client ID.
Do not delete private journals while resources remain unresolved. Moving/replacing
the project or changing account/scope can intentionally prevent recovery.

If final evidence persistence fails, the provider inbox is retained as unresolved
rather than discarding the last retrievable copy. Explicit recovery is a deletion
operation, not message-history reconstruction. Sandbox reclamation remains a
separate operation.
