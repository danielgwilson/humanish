# Guest clipboard paste protocol

`clipboard.c` is a Linux guest helper for a controlled X11 desktop. It accepts
one UTF-8 value, owns the clipboard temporarily, and sends one native Ctrl+V
chord after the controller authorizes dispatch. It has no command, path, or
script arguments and does not run subprocesses. The owner supplies `DISPLAY`
and `XAUTHORITY`; it must run as the desktop user, never as a privileged broker.

## Wire contract

The controller starts the helper with separate stdin, stdout, and stderr pipes.
Keep stdin open through completion. All lengths count bytes, not characters.

1. Write a four-byte unsigned big-endian length, followed by exactly that many
   UTF-8 bytes. The length must be 1–65,536. NUL, malformed UTF-8, overlong
   encodings, surrogate code points, and values above U+10FFFF are rejected.
   Valid text is transferred unchanged, including combining marks and newlines.
2. Read exactly `R` (`0x52`) from stdout. This means the helper claimed CLIPBOARD
   and read back its ownership. It has sent no keyboard input. Do not pipeline
   authorization with the initial frame.
3. Recheck the session's live authority and cancellation state, then write the
   single byte `G` (`0x47`). This is the dispatch boundary. Any failure from a
   possibly written `G` onward has an uncertain outcome; do not retry it.
4. Read exactly `D` (`0x44`), then require exit status zero. `D` means a post-GO
   UTF8_STRING value was stored on an X requestor window and its SelectionNotify
   was processed by the X server without a reported protocol error. It does
   **not** prove the intended application consumed or applied the text. Observe
   the application afterward to establish that outcome.

Only `R` and `D` are written to stdout. The helper emits no payload or diagnostic
text. Unexpected input bytes, EOF, signals, parent death, and the ten-second
process deadline terminate the helper. The controller must also maintain its
own deadline and reap its exact child; it must not rely solely on this helper.
The direct parent must have a PID greater than one (use an init process for a
container controller); an already orphaned helper is rejected before setup.
An empty text action must be handled by the caller without starting a paste.

| Exit | Meaning |
| --- | --- |
| 0 | Server-confirmed payload transfer; stdout contained `R`, then `D` |
| 64 | Invalid frame, UTF-8, arguments, or authorization bytes |
| 65 | Unavailable or unsupported X server, keyboard mapping, or request size |
| 66 | Lost clipboard ownership, changed focus, held keys, or active modifiers |
| 67 | X connection, property, or event delivery failure |
| 68 | Ten-second process deadline |
| 69 | EOF, parent loss, termination signal, or controller pipe failure |
| 70 | More than 4,096 X events or 256 selection requests |

The exit code does not decide whether input was dispatched. The parent tracks
whether `G` may have been written. Cancellation is not rollback. Failure paths
exit without flushing Xlib buffers or synthesizing corrective key releases.
Interruption during the chord can leave a modifier down; the owner must retire
that desktop generation instead of continuing input under an assumed clean
keyboard state.

## Desktop and selection limits

The qualified environment has one controller, one application, a known keyboard
map with group-zero `Control_L` and `v`, and no clipboard manager or other
selection consumer. It also has no held keys, active modifiers, or keyboard
grab. The helper checks the keymap, modifier state, and unchanged X input focus
immediately before input. It briefly grabs the X server while performing the
last checks and queuing Ctrl-down, V-down, V-up, Ctrl-up; it never grabs the
keyboard, maps its private window, or changes focus. This is serialization on
the controlled guest, not an isolation boundary against hostile X clients.

The helper cannot bind a SelectionRequest to Chromium using focus-window
equality: applications can request selections through hidden windows. A
concurrent clipboard consumer could receive the transfer and cause completion
before the intended application requests it. This helper therefore does not
support arbitrary shared X desktops and does not attest recipient identity.

Only TARGETS, TIMESTAMP, and direct UTF8_STRING are supported. Pre-GO text
requests receive SelectionNotify with property None; TARGETS and TIMESTAMP may
be answered but cannot complete the operation. Requests already queued when
the dispatch check starts are drained before keyboard input, without text.
Unsupported targets, including MULTIPLE and INCR, receive refusal. This is a
restricted transfer implementation, not a general ICCCM clipboard service.
The payload must fit one ChangeProperty request with room for its header;
otherwise setup fails. No incremental-transfer or text-typing fallback exists.

Before success notification, XSync checks the property store for asynchronous
X errors. A second XSync checks notification delivery. The value resides in the
requestor's property, so closing the helper or a later clipboard owner does
not replace that transferred value. The requestor controls reading/deleting it.

## Build and qualification

Build inside the guest image's pinned Linux toolchain; retain source and binary
hashes with the image inputs. Required development packages are `gcc`,
`libc6-dev`, `libx11-dev`, and `libxtst-dev`. Only the binary and runtime shared
libraries belong in the runtime image. The XKB functions used here are in X11.

```sh
cc -std=c11 -O2 -D_FORTIFY_SOURCE=3 -fstack-protector-strong \
  -Wall -Wextra -Werror -Wpedantic -Wl,-z,relro,-z,now \
  clipboard.c -o clipboard -lX11 -lXtst
```

Qualification must distinguish direct X transfer from application behavior.
Exercise exact Unicode (CJK, emoji, combining marks), tabs/newlines, the maximum
frame, malformed frames, pre-GO requests, unsupported targets, EOF at READY,
lost ownership, changed focus, held keys, and the deadline. In the actual image,
also check the browser field and omnibox, rapid successive values, delayed
renderer handling, and cancellation before GO. A success byte alone cannot
substitute for those application checks.

The protocol follows X.Org's documented [selection owner responsibilities and
large-transfer rules](https://www.x.org/releases/X11R7.7/doc/xorg-docs/icccm/icccm.html)
and [XTest input ordering](https://www.x.org/releases/X11R7.7/doc/libXtst/xtestlib.html).
XTest itself does not synchronize application effects with injected input.
