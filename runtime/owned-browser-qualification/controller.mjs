// Fixed unprivileged proof transaction using the unchanged packaged client.
// No target argument, DOM/CDP API, command, account or model call is accepted.
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectGuestBootstrap } from '../runtime/guest-bootstrap.js';

const generation = process.argv[2];
if (process.argv.length !== 3 || !/^[a-z2-7]{25}[aeimquy4]$/.test(generation ?? '') || process.getuid() === 0) process.exit(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const instance = `${root}/a/${generation.slice(0, 8)}`;
const output = `/run/ho${generation}2`;
const abort = new AbortController();
let channel, proxy, client, renewTimer, stopped = false, pending;
let buffered = Buffer.alloc(0);
const finish = () => {
  if (stopped) return;
  stopped = true; process.exitCode = 2; pending?.reject(new Error('closed')); pending = undefined; clearInterval(renewTimer); abort.abort(); client?.close(); proxy?.destroy(); channel?.destroy();
};
process.once('SIGTERM', finish); process.once('SIGINT', finish);
const total = setTimeout(finish, 115_000);
function send(value) {
  if (stopped || !channel || channel.destroyed) throw new Error('closed');
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4096) throw new Error('bounds');
  const frame = Buffer.alloc(4 + bytes.length); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
  if (channel.writableLength + frame.length > 8192) throw new Error('backpressure');
  channel.write(frame);
}
function wait(operation) {
  if (pending || stopped) return Promise.reject(new Error('closed'));
  return new Promise((resolve, reject) => { pending = { operation, resolve, reject }; });
}
function receive(chunk) {
  if (!Buffer.isBuffer(chunk) || buffered.length + chunk.length > 8192) { finish(); return; }
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const size = buffered.readUInt32BE();
    if (size < 1 || size > 4096) { finish(); return; }
    if (buffered.length < size + 4) return;
    let value;
    try { value = JSON.parse(buffered.subarray(4, size + 4)); } catch { finish(); return; }
    buffered = buffered.subarray(size + 4);
    if (value.operation === 'renewed' && Object.keys(value).sort().join(',') === 'operation,sequence') continue;
    if (!pending || value.operation !== pending.operation) { finish(); return; }
    const current = pending; pending = undefined; current.resolve(value);
  }
}
async function connect(path) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect_timeout')); }, 3000);
    const failed = () => { clearTimeout(timer); socket.destroy(); reject(new Error('connect_failed')); };
    socket.once('error', failed);
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); socket.on('error', finish); resolve(socket); });
  });
}
async function frame(name) {
  const observation = await client.executor.observe();
  const bytes = observation.screenshot;
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024 || bytes.readUInt32BE(16) !== 960 || bytes.readUInt32BE(20) !== 720) throw new Error('frame');
  await writeFile(`${output}/${name}.png`, bytes, { flag: 'wx', mode: 0o600 });
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: 960, height: 720 };
}
try {
  channel = await connect(`${instance}/control.sock`);
  channel.on('data', receive); channel.on('end', finish); channel.on('close', finish);
  const bootstrap = wait('bootstrap');
  send({ operation: 'hello', generation });
  let sequence = 0;
  renewTimer = setInterval(() => { try { send({ operation: 'renew', sequence: ++sequence }); } catch { finish(); } }, 5000);
  proxy = await connect(`${instance}/proxy.sock`);
  const admission = await bootstrap;
  if (Object.keys(admission).sort().join(',') !== 'identity,operation') throw new Error('admission');
  client = await connectGuestBootstrap(proxy, admission.identity, abort.signal);
  await client.ready();
  const before = await frame('before');
  const go = wait('go');
  send({ operation: 'admitted', before });
  await go;
  await client.executor.execute({ kind: 'type', text: 'Offline note — café 日本語 👋' }, abort.signal);
  const typed = await frame('typed');
  // Known maintained neutral page, fixed full-frame coordinates. Never replay
  // this Save click after an uncertain acknowledgement.
  await client.executor.execute({ kind: 'click', x: 99, y: 368, button: 'left' }, abort.signal);
  await client.executor.execute({ kind: 'wait', ms: 300 }, abort.signal);
  const after = await frame('after');
  const completed = wait('complete');
  send({ operation: 'finished', before, typed, after, materialActions: 2, saveDispatches: 1 });
  const complete = await completed;
  if (Object.keys(complete).join(',') !== 'operation') throw new Error('complete');
  finish(); clearTimeout(total); process.exitCode = 0;
} catch {
  try { send({ operation: 'failed' }); } catch {}
  finish(); clearTimeout(total); process.exitCode = 2;
}
