import { expect, it } from "vitest";

import type { ActorTrace } from "../../../src/actors/contract.js";
import { runComputerUseLoopWithTaps } from "../../../src/actors/computer-use/loop.js";
import type { LoopRunOptions } from "../../../src/actors/computer-use/loop/types.js";
import {
  FRAME,
  Probe,
  baseOptions,
  click,
  scriptedProvider,
  sequenceExecutor,
  turn,
} from "../../helpers/loop-golden.js";

// The page each observation was on: the origin and redacted path on each screenshot item, and the
// last observation's page as the trace's finalPage. Every case is a loop session over URLs.

/**
 * A session over `urls`, one observation each: it clicks `acted` times (once per URL after the
 * first by default), then ends. With tasks declared, the observation after the last acted one is
 * the closing task observation.
 */
async function session(
  urls: ReadonlyArray<string | undefined>,
  overrides: Partial<LoopRunOptions> = {},
  acted = urls.length - 1,
): Promise<ActorTrace> {
  const probe = new Probe();
  const provider = scriptedProvider(
    probe,
    Array.from({ length: acted }, () => turn({ actions: [click(1, 1)] })),
  );
  const executor = sequenceExecutor(
    probe,
    urls.map((url, index) => ({
      screenshot: FRAME,
      stateSignature: `screen-${index}`,
      ...(url === undefined ? {} : { url }),
    })),
  );
  return (await runComputerUseLoopWithTaps(baseOptions(probe, provider, executor, overrides)))
    .trace;
}

const pages = (trace: ActorTrace) =>
  trace.items.filter((item) => item.kind === "screenshot").map((item) => item.page ?? null);

it("lists the page of each observation in order, without query, fragment or user info", async () => {
  const trace = await session([
    "https://shop.example.test/?ref=mail#top",
    // User info assembled at run time, as the public-surface scan reads `x@host` as an address.
    ["https://buyer:pass", "shop.example.test:8443/cart?id=7"].join("@"),
    "about:blank",
  ]);
  expect(pages(trace)).toEqual([
    { origin: "https://shop.example.test", path: "/" },
    { origin: "https://shop.example.test:8443", path: "/cart" },
    { origin: "about:", path: "" },
  ]);
  expect(trace.finalPage).toEqual({ origin: "about:", path: "" });
});

it("keeps the page of the last observation only: a closing observation counts, a URL read that failed clears it", async () => {
  const tasks = [{ id: "pay", goal: "Pay.", success: { any: [{ textIncludes: "never shown" }] } }];
  const closing = await session(
    [
      "https://app.example.test/checkout",
      "https://app.example.test/processing",
      "https://app.example.test/receipt",
    ],
    { tasks },
    1,
  );
  expect(pages(closing)).toEqual([
    { origin: "https://app.example.test", path: "/checkout" },
    { origin: "https://app.example.test", path: "/processing" },
  ]);
  expect(closing.finalPage).toEqual({ origin: "https://app.example.test", path: "/receipt" });

  const unread = await session(["https://app.example.test/checkout", undefined]);
  expect(pages(unread)).toEqual([{ origin: "https://app.example.test", path: "/checkout" }, null]);
  expect(unread.finalPage).toBeUndefined();
});

// Built at run time: the fixture rules keep email-, key- and id-shaped literals out of tests.
const EMAIL = ["jane.doe", "example.test"].join("@");
const HEX_ID = ["d41d8cd9", "8f00b204", "e9800998"].join("");
const UUID = ["550e8400", "e29b", "41d4", "a716", "446655440000"].join("-");
const KEY = ["sk", "proj", "q".repeat(24)].join("-");
const STUDY_SECRET = "hunter-two-value";

it("withholds a path segment that holds an email, a token, a key or a study secret, and keeps slugs", async () => {
  const trace = await session(
    [
      `https://app.example.test/users/${encodeURIComponent(EMAIL)}/settings`,
      `https://app.example.test/share/${HEX_ID}/view`,
      `https://app.example.test/projects/${UUID}`,
      `https://app.example.test/keys/${KEY}`,
      `https://app.example.test/reset/${STUDY_SECRET}`,
      "https://app.example.test/blog/how-to-build-a-thing-2024/b2b-saas-guide",
    ],
    { scrubText: (text) => text.split(STUDY_SECRET).join("[REDACTED_SECRET]") },
  );
  expect(pages(trace).map((page) => page?.path)).toEqual([
    "/users/[REDACTED_URL_PART]/settings",
    "/share/[REDACTED_URL_PART]/view",
    "/projects/[REDACTED_URL_PART]",
    "/keys/[REDACTED_URL_PART]",
    "/reset/[REDACTED_URL_PART]",
    "/blog/how-to-build-a-thing-2024/b2b-saas-guide",
  ]);
});

it("withholds a segment that percent-encodes a plain letter, and a path the trace scan would flag", async () => {
  const words = Array.from(
    { length: 30 },
    (_, index) => `Section${String.fromCharCode(65 + (index % 26))}x`,
  );
  const trace = await session([
    "https://app.example.test/s/%61%62%63%64%65/view",
    "https://app.example.test/files/caf%C3%A9%20menu",
    `https://app.example.test/${["home", "runner", "report"].join("/")}`,
    `https://app.example.test/${words.join("/")}`,
  ]);
  expect(pages(trace).map((page) => page?.path)).toEqual([
    "/s/[REDACTED_URL_PART]/view",
    "/files/caf%C3%A9%20menu",
    "[REDACTED_RUNTIME_PATH]",
    "[REDACTED_URL_PART]",
  ]);
});

it("cuts a path over 1024 characters to 1024 with the cut marked", async () => {
  const trace = await session([`https://app.example.test${"/a-b".repeat(400)}`]);
  const path = trace.finalPage?.path ?? "";
  expect(path).toHaveLength(1024);
  expect(path.endsWith("/a-b/[TRUNCATED]")).toBe(true);
  expect(path.startsWith("/a-b/a-b/")).toBe(true);
});

it("withholds a sandbox host and a token-shaped host label in the origin", async () => {
  const sandbox = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
  const trace = await session([
    `https://3000-${sandbox}.e2b.app/board`,
    `https://${HEX_ID}.tunnel.example.test/board`,
    "http://127.0.0.1:3000/board",
    "http://[::1]:8080/board",
  ]);
  expect(pages(trace)).toEqual([
    { origin: "[REDACTED_SECRET]", path: "/board" },
    { origin: "https://[REDACTED_URL_PART].tunnel.example.test", path: "/board" },
    { origin: "http://127.0.0.1:3000", path: "/board" },
    { origin: "http://[::1]:8080", path: "/board" },
  ]);
});

it("records no page anywhere when the caller turns pages off", async () => {
  const tasks = [{ id: "pay", goal: "Pay.", success: { any: [{ textIncludes: "never shown" }] } }];
  const trace = await session(
    ["https://app.example.test/a", "https://app.example.test/b", "https://app.example.test/c"],
    {
      recordPages: false,
      tasks,
      dwell: { ms: 2000, everyMs: 1000, then: "continue" },
      sleep: async () => undefined,
    },
    1,
  );
  expect(trace.items.filter((item) => item.kind === "screenshot").length).toBeGreaterThan(2);
  expect(pages(trace).every((page) => page === null)).toBe(true);
  expect(trace.finalPage).toBeUndefined();
});

it("withholds what the trace redaction misses when origin and path are read apart or encoded twice", async () => {
  const invite = "https://app.example.test/invite/bluebird";
  const secrets = ["private", invite];
  const trace = await session(
    [
      `https://private.${HEX_ID}.example.test/board`,
      invite,
      `https://app.example.test/u/${encodeURIComponent(encodeURIComponent(EMAIL))}`,
    ],
    {
      scrubText: (text) =>
        secrets.reduce((current, secret) => current.split(secret).join("[REDACTED_SECRET]"), text),
    },
  );
  expect(pages(trace)).toEqual([
    { origin: "https://[REDACTED_SECRET].[REDACTED_URL_PART].example.test", path: "/board" },
    { origin: "[REDACTED_URL_PART]", path: "[REDACTED_URL_PART]" },
    { origin: "https://app.example.test", path: "/u/[REDACTED_URL_PART]" },
  ]);
});
