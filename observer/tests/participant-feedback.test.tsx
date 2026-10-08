// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ParticipantFeedback } from "../components/participant-feedback";
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";

it("pages through original statements, excludes other evidence kinds and keeps exact source links", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  stream.actor!.items.push(
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `statement-${i}`,
      kind: "message" as const,
      lifecycle: "completed" as const,
      title: `Statement ${i}`,
      text: `Original statement number ${i}.`,
    })),
    {
      id: "not-statement",
      kind: "reasoning",
      lifecycle: "completed",
      title: "Thinking",
      text: "Reasoning is not participant feedback.",
    },
    {
      id: "harness-notice",
      kind: "notice",
      lifecycle: "completed",
      title: "Harness notice",
      text: "Runtime notice is not participant feedback.",
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(container.querySelectorAll("[data-feedback-entry]")).toHaveLength(20);
    expect(container.textContent).toContain("7–26 of 26");
    expect(container.textContent).not.toContain("Reasoning is not");
    expect(container.textContent).not.toContain("Runtime notice is not");
    expect(
      container.querySelector('[data-feedback-entry="statement-24"] a')?.getAttribute("href"),
    ).toBe("#/lane/lane-1/f/4/e/statement-24");
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(container.querySelectorAll("[data-feedback-entry]")).toHaveLength(6);
    expect(container.textContent).toContain("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE");
    expect(container.textContent).toContain("1–6 of 26");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("retains the structured closing account without duplicating its readable message projection", async () => {
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  stream.actor!.debrief = {
    trigger: "stop_when",
    status: "completed",
    reason: "Recorded ending.",
    messageId: "lane-1-final",
    report: {
      summary: "Original closing summary.",
      frictionReports: ["Original friction report."],
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(container.textContent).toContain("Original closing summary.");
    expect(container.textContent).toContain("Original friction report.");
    expect(container.querySelectorAll("[data-feedback-entry]")).toHaveLength(0);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "#/lane/lane-1/f/4/e/lane-1-final",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("does not crash or hide original statements when an older optional closing account is malformed", async () => {
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  stream.actor!.debrief = {
    report: { summary: "Malformed optional closing account", frictionReports: 17 },
  } as unknown as NonNullable<NonNullable<typeof stream.actor>["debrief"]>;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("could not be read");
    expect(container.textContent).toContain("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const impression = (id: string, text: string) => ({
  id,
  kind: "message" as const,
  lifecycle: "completed" as const,
  title: "participant impression",
  text,
});

it("groups a participant's impressions by kind under what they said at the end", async () => {
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  const paper = "On the paper form I write the dose next to the drug name.";
  const small = "The dose field label was too small to read.";
  const saves = "The two Save buttons looked the same.";
  stream.actor!.items.push(
    impression("impression-1", `Impression (unlike my work): ${paper}`),
    impression("impression-2", `Impression (unclear): ${small}`),
    impression("impression-3", `Impression (unclear): ${saves}`),
  );
  stream.actor!.impressions = {
    status: "collected",
    items: [
      { kind: "unlike_my_work", text: paper, messageId: "impression-1" },
      { kind: "unclear", text: small, messageId: "impression-2" },
      { kind: "unclear", text: saves, messageId: "impression-3" },
    ],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    const region = container.querySelector('[aria-label="What they said at the end"]');
    expect(region?.querySelector("h3")?.textContent).toBe("What they said at the end");
    const groups = [...(region?.querySelectorAll("section") ?? [])].map((group) => ({
      label: group.getAttribute("aria-label"),
      texts: [...group.querySelectorAll("li .verbatim")].map((item) => item.textContent),
    }));
    expect(groups).toEqual([
      { label: "Confusing or hard to read", texts: [small, saves] },
      { label: "Different from how they do it", texts: [paper] },
    ]);
    expect(region?.querySelector("a")?.getAttribute("href")).toMatch(/\/e\/impression-2$/);
    expect(
      [...container.querySelectorAll("[data-feedback-entry]")].map((entry) =>
        entry.getAttribute("data-feedback-entry"),
      ),
    ).not.toContain("impression-1");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  [
    {
      status: "not_collected",
      reason: "the participant ended the session without a structured closing account",
    },
    "Not collected: the participant ended the session without a structured closing account.",
  ],
  [{ status: "collected", items: [] }, "They named none."],
  [
    { status: "collected", items: [{ kind: "liked", text: 17 }] },
    "The recorded impressions could not be read.",
  ],
])("says what became of the impressions when they read %j", async (impressions, said) => {
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  stream.actor!.impressions = impressions as NonNullable<
    NonNullable<typeof stream.actor>["impressions"]
  >;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(
      container.querySelector('[aria-label="What they said at the end"]')?.textContent,
    ).toContain(said);
    expect(container.textContent).toContain("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows no impressions heading for a trace recorded before impressions", async () => {
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  delete stream.actor!.impressions;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(container.textContent).not.toContain("What they said at the end");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

type Stream = Parameters<typeof ParticipantFeedback>[0]["stream"];

async function inspectRendered(
  prepare: (stream: Stream) => void,
  inspect: (container: HTMLElement) => void,
) {
  const data = fixtures.fixture(),
    stream = data.streams[0]!;
  prepare(stream);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    inspect(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

it.each([
  [6, 6, "Worked well"],
  [7, 0, "The recorded impressions could not be read."],
])(
  "reads %i recorded impressions as %i listed, since a participant gives at most six",
  async (count, listed, said) => {
    await inspectRendered(
      (stream) => {
        stream.actor!.impressions = {
          status: "collected",
          items: Array.from({ length: count }, (_, i) => ({
            kind: "liked" as const,
            text: `Liked thing ${i}.`,
            messageId: `impression-${i}`,
          })),
        };
      },
      (container) => {
        const region = container.querySelector('[aria-label="What they said at the end"]');
        expect(region?.querySelectorAll("li")).toHaveLength(listed);
        expect(region?.textContent).toContain(said);
      },
    );
  },
);

it.each([
  [8, 8],
  [9, 0],
])(
  "reads a closing account with %i friction reports as %i listed, since a report holds at most eight",
  async (count, listed) => {
    await inspectRendered(
      (stream) => {
        stream.actor!.debrief = {
          trigger: "stop_when",
          status: "completed",
          reason: "Recorded ending.",
          report: {
            summary: "Original closing summary.",
            frictionReports: Array.from({ length: count }, (_, i) => `Friction ${i}.`),
          },
        };
      },
      (container) => {
        expect(container.querySelectorAll(".participant-feedback > .blk li")).toHaveLength(listed);
        expect(container.querySelector('[role="status"]') === null).toBe(listed > 0);
      },
    );
  },
);
