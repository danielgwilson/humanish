# Headed browser guest components

These internal components implement native input and full-desktop captures for a
maintained browser-only guest. They do not enable a public local-runtime mode.
The VM owner, control transport, app network policy, installed setup and complete
study journey require separate qualification.

The driver uses the existing `CuaExecutor` contract behind
[browser control](browser-control.md). Coordinates refer to the complete Xvfb
frame, including the browser's address bar. Invalid points are refused instead
of moved to a different target. Captures must match the admitted geometry and
pass the bounded PNG validator. Browser URL/title/DOM metadata is absent in this
component; callers must not invent it from the screenshot or infer task matches.
Progress detection uses the same coarse frame signature as the hosted desktop.

## Input boundary

The actor receives the existing finite action union. Native tool paths, display,
Xauthority and guest temporary directory come from the owner. Key names map to a
closed list before reaching xdotool, whose own command syntax must never receive
arbitrary participant strings. A native wheel step is not an exact pixel-scroll
promise; one action permits at most 100 wheel steps. The entire drag is checked
before its first input.

Each input checks the current authority after asynchronous preparation. A
partial or unacknowledged input closes the executor; it is never automatically
replayed. Releasing a held button can itself click or drop, so revocation does
not inject a cleanup mouseup into the app. The owner must stop the private
browser/display. A stopped helper alone does not establish desktop or VM absence.

Text in a focused, editable top-level document uses Chromium's fixed
`Input.insertText` command over the owner's private Playwright pipe. The actor
receives no CDP, JavaScript, selector, or debugging endpoint. A separate isolated
world checks actual document focus and binds preparation to the editable element;
page changes, additional tabs, dialogs, iframe focus and ambiguous focus are
refused. The owner acquires the one page and native window before untrusted
navigation. The driver never chooses another tab or brings one to the front.
Focus can change between protocol messages; this is not atomic element-targeted
input or a general multi-window driver.

Address-bar text is admitted only after an explicit Ctrl+L action, uses printable
ASCII, and repeats that chord after checking the owned active window. Unicode
or control characters in browser chrome are refused. Clicking an arbitrary
chrome field does not authorize text entry there. Content insertion is browser
text/IME insertion, not a stream of physical key presses; keyboard shortcuts
remain native. There is no alternate-route fallback after a failed insertion.

Direct native Unicode typing and a one-transfer clipboard helper were rejected
by exact Chromium field readback. Successful process or clipboard transfer
acknowledgements did not establish successful application input. The supported
text paths likewise need application readback to establish task outcomes.

Native children use fixed paths and a minimal explicit environment. Operator
credentials and inherited Xauthority are not forwarded. Native address-bar text travels over the
helper's stdin; web text travels over the private browser pipe, never a shell. Helpers have bounded deadlines and output;
raw diagnostic text is never returned as an executor error. Only an acquired,
still-live child handle authorizes termination. If capture-helper exit cannot
be confirmed, its private files stay for runtime-owner reclamation.

## Build and proof

The source-only [guest recipe](https://github.com/danielgwilson/humanish/blob/main/runtime/browser-guest/README.md) builds a
pinned Debian/Chromium/Xvfb development base with package/source references and
notices. It is not a redistributed release image or a VM qualification receipt.
A native ARM64 build and its exact browser behavior are separate from amd64.

After building the development image and JavaScript, run the scoped native proof
with its exact local image ID:

```sh
HUMANISH_GUEST_IMAGE=sha256:<image-id> pnpm guest-desktop:proof
```

This launches an ordinary disposable container with no network, host mounts or
host devices. Chromium retains its sandbox. The harness downloads and verifies
the hash-pinned upstream Playwright Docker seccomp profile, which permits the
user namespaces needed by that sandbox. This container configuration is a test
environment, not the proposed Firecracker boundary. The harness retains failed
attempts, full-frame captures, synthetic app readback and exact-container cleanup
under ignored `.humanish/guest-desktop-proof/`.

The proof covers visible browser chrome, address-bar navigation, Unicode and
rapid/large/stalled-renderer text insertion, page/focus rejection, pointer and
keyboard input, native scrolling and cancellation. CI reruns this proof for
changes to the guest driver, image recipe, protocol or dependency lockfile. Its deterministic fixture is not a model participant,
a run bundle, a host network policy, an independent watchdog or a Linux/Mac
installed study. Those remain separate gates before local runtime support.
