# Captured holder network events

Two events files the in-sandbox holder wrote on 2026-10-16, under python3 3.12.3 and headless
Google Chrome 149.0.7827.114, each from a test in `tests/substrates/e2b/cdp-network-capture.test.ts`.
The holder ran with `network` and no emulation. Each run's random ports were rewritten: the site is
`http://127.0.0.1:3000` and the closed port is `http://127.0.0.1:3999`. Nothing else was changed.
Request ids, the renderer process ids inside them, both clocks and the line order are as the holder
wrote them. Chrome's own `/favicon.ico` requests appear with type `Other`.

`holder-events.ndjson` is from "writes each request case". Its allowed origins were the test's
synthetic site and the closed port; the site's second origin, `http://localhost:<port>`, was not
allowed. It holds, in order:

- the `start` line;
- `/flow` (document, 200) and `/img.png` (image, 200);
- `/ok` 200, `/err` 500, and `/slow`, finished about 300 ms after it started;
- `/redirect`, then a second request line on the same id with `redirectResponse.status` 302 and
  the address `/ok`, its query cut off, then 200;
- `POST /submit` 200. Chrome sent a body and an Authorization header; neither is in the file;
- `/drop`, failed with `net::ERR_EMPTY_RESPONSE` and no response;
- the fetch to the second origin: one request line with no address, method or type;
- `127.0.0.1:3999/closed`, failed with `net::ERR_CONNECTION_REFUSED`;
- `/next` (document), with `/img.png` again from the disk cache;
- session `1`, a tab opened after the holder attached. Its first document request is missing; its
  `/from-later-tab` fetch is there, and `/hang`, a request line with nothing after it, still open
  when Chrome stopped;
- `exit`, with the reason the holder saw when Chrome stopped.

`holder-back-forward.ndjson` is from "writes a page restored from the back-forward cache". Its
allowed origin was the site. It holds `/bf-a`, `/bf-b`, then the `/bf-restored` fetch `/bf-a`'s
`pageshow` handler sent and the `backForward` line for `/bf-a` after `/bf-b` called
`history.back()`. The test killed the holder, so the file has no `exit` line.

To capture both again:

```bash
HUMANISH_NETWORK_FIXTURE_DIR=$PWD/tests/fixtures/browser-network \
  pnpm vitest run tests/substrates/e2b/cdp-network-capture.test.ts
```
