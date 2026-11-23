import { describe, expect, it } from "vitest";

import { pendingRemoteRecord, readRemoteRecord } from "../../src/run/remote-record.js";

const SCHEMA = "humanish.remote-run.v1";
const DEADLINE = "2026-11-23T12:00:00.000Z";
const STARTED = "2026-11-23T10:00:00.000Z";

const record = (fields: Record<string, unknown>) => JSON.stringify({ schema: SCHEMA, ...fields });

describe("reading a run's remote.json", () => {
  it("reads no file as no record", () => {
    expect(readRemoteRecord(undefined)).toEqual({ state: "none" });
  });

  it.each([
    ["text that is not JSON", "{ copyPending: true"],
    ["JSON that is not an object", "[]"],
    ["JSON null", "null"],
    ["a JSON string", '"pending"'],
    ["another schema", JSON.stringify({ schema: "humanish.remote-run.v2", copyPending: true })],
  ])("reads %s as a record it cannot read, apart from no file", (_name, text) => {
    expect(readRemoteRecord(text)).toEqual({ state: "unreadable" });
  });

  it("reads a record whose copy is pending with every fact it names", () => {
    const text = record({
      runId: "cua-remote",
      provider: "e2b",
      route: "computer-use",
      deadline: DEADLINE,
      copyPending: true,
      startedAt: STARTED,
    });
    expect(readRemoteRecord(text)).toEqual({
      state: "pending",
      provider: "e2b",
      route: "computer-use",
      deadline: DEADLINE,
      startedAt: STARTED,
    });
  });

  it("reads a pending record written before startedAt, and one with no deadline", () => {
    expect(
      readRemoteRecord(
        record({ provider: "modal", route: "terminal", deadline: DEADLINE, copyPending: true }),
      ),
    ).toEqual({ state: "pending", provider: "modal", route: "terminal", deadline: DEADLINE });
    expect(readRemoteRecord(record({ provider: "e2b", copyPending: true }))).toEqual({
      state: "pending",
      provider: "e2b",
    });
  });

  it("leaves out a deadline, a start or a provider it cannot read", () => {
    expect(
      readRemoteRecord(
        record({ provider: "elsewhere", deadline: "soon", startedAt: 7, copyPending: true }),
      ),
    ).toEqual({ state: "pending" });
  });

  it.each([["1"], ["2026-11-23"], ["2026-11-23T12:00:00Z"], ["2026-13-40T00:00:00.000Z"]])(
    "reads a time of %s, which is not an ISO date-time as humanish writes one, as no time",
    (time) => {
      expect(
        readRemoteRecord(record({ copyPending: true, deadline: time, startedAt: time })),
      ).toEqual({ state: "pending" });
    },
  );

  it("reads a record with no schema, as the tests of its writers write one", () => {
    expect(readRemoteRecord(JSON.stringify({ copyPending: true }))).toEqual({ state: "pending" });
    expect(readRemoteRecord("{}")).toEqual({ state: "copied", lostInCopy: [] });
  });

  it("reads a record whose copy finished as copied, with nothing lost", () => {
    expect(
      readRemoteRecord(record({ provider: "e2b", route: "computer-use", deadline: DEADLINE })),
    ).toEqual({
      state: "copied",
      lostInCopy: [],
      provider: "e2b",
      route: "computer-use",
      deadline: DEADLINE,
    });
  });

  it("reads a record written before copyPending existed as copied", () => {
    // Such a record never says a copy is pending; its callers look for run.json as well.
    expect(
      readRemoteRecord(
        record({ runId: "cua-old", provider: "e2b", route: "computer-use", deadline: DEADLINE }),
      ),
    ).toMatchObject({ state: "copied", lostInCopy: [] });
  });

  it("reads the recordings a copy that gave up lost, and only their paths", () => {
    expect(
      readRemoteRecord(
        record({ provider: "modal", lostInCopy: ["recordings/p01/desktop.mp4", 7, null] }),
      ),
    ).toEqual({ state: "copied", lostInCopy: ["recordings/p01/desktop.mp4"], provider: "modal" });
  });

  it("reads back every fact of the record a remote launch writes, its study included", () => {
    const study = {
      id: "checkout-flow",
      path: "humanish/studies/checkout-flow.yaml",
      origin: "committed" as const,
    };
    const written = pendingRemoteRecord({
      runId: "cua-remote",
      provider: "modal",
      route: "computer-use",
      deadline: DEADLINE,
      startedAt: STARTED,
      study,
    });

    expect(written).toEqual({
      schema: SCHEMA,
      runId: "cua-remote",
      provider: "modal",
      route: "computer-use",
      deadline: DEADLINE,
      copyPending: true,
      startedAt: STARTED,
      study,
    });
    expect(readRemoteRecord(JSON.stringify(written))).toEqual({
      state: "pending",
      provider: "modal",
      route: "computer-use",
      deadline: DEADLINE,
      startedAt: STARTED,
      study,
    });
  });

  it("writes no study for a run that came from no study file", () => {
    const written = pendingRemoteRecord({
      runId: "cua-remote",
      provider: "e2b",
      route: "terminal",
      deadline: DEADLINE,
      startedAt: STARTED,
    });
    expect(written).not.toHaveProperty("study");
  });

  it.each([
    ["a string", "checkout-flow"],
    ["no id", { path: "humanish/studies/checkout-flow.yaml" }],
    ["an empty id", { id: "" }],
    ["null", null],
  ])("reads a record whose study is %s without one", (_name, study) => {
    expect(readRemoteRecord(record({ copyPending: true, study }))).toEqual({ state: "pending" });
  });

  it("keeps only the study fields it can read", () => {
    expect(
      readRemoteRecord(
        record({ copyPending: true, study: { id: "checkout-flow", origin: "elsewhere", path: 7 } }),
      ),
    ).toEqual({ state: "pending", study: { id: "checkout-flow" } });
  });
});
