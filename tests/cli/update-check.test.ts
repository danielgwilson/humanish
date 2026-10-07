import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctor } from "../../src/cli/doctor.js";
import { createProgram } from "../../src/cli/program.js";
import { checkForUpdate, refreshUpdateCache } from "../../src/cli/update-check.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

describe("the update notice", () => {
  let configHome: string;
  let refreshes: string[];

  beforeEach(async () => {
    configHome = await mkdtemp(path.join(tmpdir(), "humanish-update-check-"));
    refreshes = [];
  });
  afterEach(async () => {
    await rm(configHome, { recursive: true, force: true });
  });

  async function writeCache(cache: object): Promise<void> {
    await mkdir(path.join(configHome, "humanish"), { recursive: true });
    await writeFile(path.join(configHome, "humanish", "update-check.json"), JSON.stringify(cache));
  }

  function check(now: number, overrides: Partial<Parameters<typeof checkForUpdate>[0]> = {}) {
    return checkForUpdate({
      installed: "0.105.0",
      env: { XDG_CONFIG_HOME: configHome },
      terminal: true,
      json: false,
      ownCheckout: false,
      now,
      startRefresh: (cachePath) => refreshes.push(cachePath),
      ...overrides,
    });
  }

  it("names both versions and npx humanish@latest, at most once a day on a terminal", async () => {
    await writeCache({ checkedAt: new Date(NOW - HOUR).toISOString(), latest: "0.112.0" });

    const first = check(NOW);
    expect(first).toContain("0.105.0");
    expect(first).toContain("0.112.0");
    expect(first).toContain("npx humanish@latest");
    expect(first).not.toContain("\n");
    expect(check(NOW + HOUR)).toBeUndefined();
    expect(check(NOW + 25 * HOUR)).toBe(first);
  });

  it.each([
    ["in a pipe", { terminal: false }],
    ["for --json", { json: true }],
    ["in CI", { env: { CI: "true" } }],
    ["with DO_NOT_TRACK", { env: { DO_NOT_TRACK: "1" } }],
    ["with HUMANISH_TELEMETRY_DISABLED", { env: { HUMANISH_TELEMETRY_DISABLED: "1" } }],
    ["with HUMANISH_NO_UPDATE_CHECK=1", { env: { HUMANISH_NO_UPDATE_CHECK: "1" } }],
    ["for a study participant", { env: { HUMANISH_STUDY_PARTICIPANT: "1" } }],
    ["from humanish's own checkout", { ownCheckout: true }],
  ] as const)("says nothing and asks the registry nothing %s", async (_case, overrides) => {
    await writeCache({ checkedAt: new Date(NOW - 2 * 24 * HOUR).toISOString(), latest: "0.112.0" });
    const env = "env" in overrides ? { ...overrides.env, XDG_CONFIG_HOME: configHome } : undefined;

    expect(check(NOW, { ...overrides, ...(env === undefined ? {} : { env }) })).toBeUndefined();
    expect(refreshes).toEqual([]);
  });

  it("starts one background registry check a day and none while the cache is fresh", async () => {
    const cachePath = path.join(configHome, "humanish", "update-check.json");

    expect(check(NOW)).toBeUndefined();
    expect(refreshes).toEqual([cachePath]);
    check(NOW + HOUR);
    expect(refreshes).toEqual([cachePath]);
    check(NOW + 25 * HOUR);
    expect(refreshes).toEqual([cachePath, cachePath]);
  });

  it("says nothing when the installed version is the latest or newer", async () => {
    await writeCache({ checkedAt: new Date(NOW - HOUR).toISOString(), latest: "0.112.0" });

    expect(check(NOW, { installed: "0.112.0" })).toBeUndefined();
    expect(check(NOW, { installed: "0.113.0" })).toBeUndefined();
  });

  it("records the registry's latest version with a GET that carries no identifying data", async () => {
    const cachePath = path.join(configHome, "humanish", "update-check.json");
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      // The shape registry.npmjs.org returned for this endpoint on 2026-10-07.
      return Response.json({ latest: "0.112.0" });
    };

    await refreshUpdateCache({ cachePath, fetchFn, now: () => NOW });

    expect(requests.map((request) => request.url)).toEqual([
      "https://registry.npmjs.org/-/package/humanish/dist-tags",
    ]);
    expect(requests[0]!.init?.method ?? "GET").toBe("GET");
    expect(requests[0]!.init?.body).toBeUndefined();
    expect([...new Headers(requests[0]!.init?.headers).keys()]).toEqual(["accept"]);
    expect(check(NOW + HOUR)).toContain("the latest is 0.112.0");
    expect(refreshes).toEqual([]);
  });

  it("leaves the cache as it was when the registry fails or answers nonsense", async () => {
    const cachePath = path.join(configHome, "humanish", "update-check.json");
    await writeCache({ checkedAt: new Date(NOW - HOUR).toISOString(), latest: "0.110.0" });

    await refreshUpdateCache({
      cachePath,
      fetchFn: async () => {
        throw new Error("offline");
      },
      now: () => NOW,
    });
    await refreshUpdateCache({
      cachePath,
      fetchFn: async () => Response.json({ latest: "not a version" }),
      now: () => NOW,
    });
    await refreshUpdateCache({
      cachePath,
      fetchFn: async () => new Response("unavailable", { status: 503 }),
      now: () => NOW,
    });

    expect(check(NOW)).toContain("the latest is 0.110.0");
  });

  it("prints the notice on stderr after a command's output, and never after --json", async () => {
    await writeCache({ checkedAt: new Date(NOW - HOUR).toISOString(), latest: "0.112.0" });
    const project = await mkdtemp(path.join(tmpdir(), "humanish-update-check-project-"));
    const run = async (args: string[]): Promise<Array<[string, string]>> => {
      const log: Array<[string, string]> = [];
      const program = createProgram({
        writeOut: (text) => log.push(["out", text]),
        writeErr: (text) => log.push(["err", text]),
        setExitCode: () => {},
        updateCheck: {
          installed: "0.105.0",
          env: { XDG_CONFIG_HOME: configHome },
          terminal: true,
          ownCheckout: false,
          now: NOW,
          startRefresh: (cachePath) => refreshes.push(cachePath),
        },
      });
      program.exitOverride();
      await program.parseAsync(["node", "humanish", ...args, "--cwd", project], { from: "node" });
      return log;
    };
    try {
      const json = await run(["study", "list", "--json"]);
      expect(json.some(([stream, text]) => stream === "err" && text.includes("out of date"))).toBe(
        false,
      );

      const human = await run(["study", "list"]);
      expect(human.some(([stream]) => stream === "out")).toBe(true);
      expect(human.at(-1)).toEqual([
        "err",
        "humanish 0.105.0 is out of date; the latest is 0.112.0. Run npx humanish@latest to use it.\n",
      ]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("doctor's version row", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-doctor-version-"));
    await writeFile(path.join(root, ".gitignore"), ".humanish/\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = () =>
    doctor(root, {
      env: { HUMANISH_STRICT_KEYS: "1", PATH: "", XDG_CONFIG_HOME: path.join(root, "config") },
      localAgents: { which: async () => undefined },
    });

  it("reports the latest version the update check recorded, and nothing before a check", async () => {
    expect((await run()).checks.map((check) => check.name)).not.toContain("humanish version");

    await mkdir(path.join(root, "config", "humanish"), { recursive: true });
    await writeFile(
      path.join(root, "config", "humanish", "update-check.json"),
      JSON.stringify({ checkedAt: "2026-10-07T12:00:00.000Z", latest: "999.0.0" }),
    );
    const row = (await run()).checks.find((check) => check.name === "humanish version");
    expect(row?.ok).toBe(true);
    expect(row?.status).toBe("note");
    expect(row?.message).toContain("999.0.0");
    expect(row?.message).toContain("npx humanish@latest");
  });
});
