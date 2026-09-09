// Compiled-CLI admission proof: no inherited provider keys, networking, or subprocesses.
import { writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const attempts = [];
const forbid = (name) => function () {
  attempts.push(name);
  throw new Error(`Side effect forbidden in task preflight proof: ${name}`);
};
globalThis.fetch = forbid("fetch");
http.request = forbid("http.request"); http.get = forbid("http.get");
https.request = forbid("https.request"); https.get = forbid("https.get");
net.Socket.prototype.connect = forbid("net.Socket.connect"); tls.connect = forbid("tls.connect");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = forbid(`child_process.${name}`);
syncBuiltinESMExports();
// Count attempted SDK allocation even if no request were made (e.g. debug construction).
const requireFromCli = createRequire(process.env.HUMANISH_PROOF_CLI);
const desktopPath = requireFromCli.resolve("@e2b/desktop");
const requireFromDesktop = createRequire(desktopPath);
for (const [name, resolved] of [["@e2b/desktop", desktopPath], ["e2b", requireFromDesktop.resolve("e2b")]]) {
  const { Sandbox } = await import(pathToFileURL(resolved).href);
  Sandbox.create = forbid(`${name}.create`);
  Sandbox.createSandbox = forbid(`${name}.createSandbox`);
  Sandbox.list = forbid(`${name}.list`);
}
process.on("exit", (code) => writeFileSync(process.env.HUMANISH_PROOF_RESULT, JSON.stringify({ code, attempts })));
