import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createProgram } from "../../../src/cli/program.js";
import type { RunLabOptions } from "../../../src/lab/engine.js";
import { parseLabConfig } from "../../../src/lab/config.js";
import type { CuaActorLabHooks } from "../../../src/routes/computer-use/types.js";

// `RestrictedCodexSessionOptions.cliVersions` bypasses per-host qualification for the
// maintainer's qualification script. These tests prove no public path can set it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceFiles = readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => path.join("src", file));

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) for (const child of node) walk(child, visit);
  else if (isNode(node)) {
    visit(node);
    for (const value of Object.values(node)) if (typeof value === "object") walk(value, visit);
  }
}
const unwrap = (node: Node): Node =>
  node.type === "ParenthesizedExpression" ? unwrap(node.expression as Node) : node;
const keyName = (property: Node): string | undefined => {
  const key = property.key as Node | undefined;
  return key?.type === "Identifier" ? (key.name as string) : undefined;
};

// Every way to construct restricted Codex options. Only these modules may forward an options
// value they received; every other call site must spell its options out.
const FACTORIES = new Set([
  "createRestrictedCodexSession",
  "runRestrictedCodexSession",
  "checkRestrictedCodexSessionReadiness",
  "detectRestrictedCodexCliVersion",
  "createRestrictedCodexAnalysisProvider",
  "checkRestrictedCodexAnalysisReadiness",
  "createRestrictedCodexParticipant",
]);
const FORWARDERS = new Set([
  "src/actors/codex/restricted-session.ts",
  "src/actors/codex/restricted-participant.ts",
  "src/analysis/restricted-codex.ts",
]);

/** Problems with one options argument: anything but literal keys, or a cliVersions key. */
function literalOptionProblems(node: Node, where: string): string[] {
  const value = unwrap(node);
  if (value.type === "ConditionalExpression")
    return [
      ...literalOptionProblems(value.consequent as Node, where),
      ...literalOptionProblems(value.alternate as Node, where),
    ];
  if (value.type !== "ObjectExpression") return [`${where}: options are not an object literal`];
  const problems: string[] = [];
  for (const property of value.properties as Node[]) {
    if (property.type === "SpreadElement") {
      problems.push(...literalOptionProblems(property.argument as Node, `${where} spread`));
      continue;
    }
    const name = keyName(property);
    if (name === "cliVersions") problems.push(`${where}: sets cliVersions`);
    if (name === "session")
      problems.push(...literalOptionProblems(property.value as Node, `${where}.session`));
  }
  return problems;
}

describe("the cliVersions qualification bypass", () => {
  it("is named only where the session defines and reads it", () => {
    const files = sourceFiles.filter((file) =>
      readFileSync(path.join(root, file), "utf8").includes("cliVersions"),
    );
    expect(files).toEqual(["src/actors/codex/restricted-session.ts"]);
  });

  it("is never passed by a call site outside the forwarding modules", () => {
    const problems: string[] = [];
    let calls = 0;
    for (const file of sourceFiles.filter((name) => !FORWARDERS.has(name))) {
      const text = readFileSync(path.join(root, file), "utf8");
      if (![...FACTORIES].some((name) => text.includes(name))) continue;
      walk(parseSync(file, text).program, (node) => {
        if (node.type !== "CallExpression") return;
        const callee = unwrap(node.callee as Node);
        const name =
          callee.type === "Identifier"
            ? (callee.name as string)
            : callee.type === "MemberExpression"
              ? ((callee.property as Node).name as string)
              : undefined;
        if (name === undefined || !FACTORIES.has(name)) return;
        calls++;
        for (const argument of node.arguments as Node[])
          problems.push(...literalOptionProblems(argument, `${file} ${name}`));
      });
    }
    expect(calls).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("is not part of the package's library surface", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    const sources: string[] = [];
    const names: string[] = [];
    walk(
      parseSync("index.ts", readFileSync(path.join(root, "src/index.ts"), "utf8")).program,
      (node) => {
        if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") return;
        const source = node.source as Node | null;
        if (source) sources.push(source.value as string);
        for (const specifier of (node.specifiers as Node[] | undefined) ?? [])
          names.push(((specifier.exported as Node).name as string) ?? "");
      },
    );
    expect(sources.filter((source) => /restricted|qualified-versions/.test(source))).toEqual([]);
    expect(names.filter((name) => /RestrictedCodex|cliVersion/i.test(name))).toEqual([]);
  });

  it("cannot be declared in a lab manifest", () => {
    const base = {
      schema: "humanish.lab.v2",
      id: "seam",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "local-agent", mission: "Save a note." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      scenario: { mode: "live" },
    };
    const smuggled = { cliVersions: ["0.158.0"] };
    for (const raw of [
      { ...base, ...smuggled },
      { ...base, actors: [{ ...base.actors[0], ...smuggled }] },
      { ...base, execution: { ...base.execution, ...smuggled } },
      { ...base, review: { analysis: { provider: "codex", ...smuggled } } },
    ])
      expect(parseLabConfig(raw).ok).toBe(false);
  });

  it("has no CLI flag and no RunLabOptions or cuaHooks field", () => {
    const flags: string[] = [];
    const visit = (command: ReturnType<typeof createProgram>): void => {
      for (const option of command.options) flags.push(option.flags);
      for (const child of command.commands) visit(child);
    };
    visit(createProgram());
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.filter((flag) => /cli-?version/i.test(flag))).toEqual([]);
    expectTypeOf<RunLabOptions>().not.toHaveProperty("cliVersions");
    expectTypeOf<CuaActorLabHooks>().not.toHaveProperty("cliVersions");
  });
});
