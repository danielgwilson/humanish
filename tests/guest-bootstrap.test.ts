import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeGuestBootstrap, parseGuestBootstrap, GuestBootstrapReader, connectGuestBootstrap, GUEST_BOOTSTRAP_LIMITS } from "../src/guest-bootstrap.js";
import { identity, pair, tick } from "./browser-control-fixture.js";
import { execFileSync } from "node:child_process";
import { runGuestRuntime } from "../src/guest-runtime.js";

afterEach(() => vi.useRealTimers());
describe("fixed canonical guest bootstrap", () => {
  it("round trips both canonical frames with the existing identity grammar", () => {
    for (const ready of [false, true]) {
      const wire = encodeGuestBootstrap(identity, ready);
      expect(wire.readUInt32BE()).toBe(wire.length - 4);
      expect(parseGuestBootstrap(wire.subarray(4), identity.runtimeRevision, ready)).toEqual(identity);
    }
  });
  it.each([
    '{"version":1,"version":1,"identity":'+JSON.stringify(identity)+'}',
    '{"identity":'+JSON.stringify(identity)+',"version":1}',
    JSON.stringify({ version:1, identity, extra:true }),
    JSON.stringify({ version:true, identity }),
    JSON.stringify({ version:2, identity }),
    ' '+JSON.stringify({version:1,identity}),
    JSON.stringify({version:1,identity:{...identity,challenge:"different space"}}),
    JSON.stringify({version:1,identity}).replace('generation-1','generation\\u002d1'),
    '\ufeff'+JSON.stringify({version:1,identity}),
    '{"version":NaN}', 'null', '[]', '{}'
  ])("rejects alternate/ambiguous encoding %#", text => {
    expect(() => parseGuestBootstrap(Buffer.from(text), identity.runtimeRevision)).toThrowError(expect.objectContaining({code:"protocol_mismatch"}));
  });
  it("rejects invalid UTF8 and wrong packaged revision", () => {
    expect(() => parseGuestBootstrap(Buffer.from([0xc0,0x80]), identity.runtimeRevision)).toThrow();
    expect(() => parseGuestBootstrap(encodeGuestBootstrap(identity).subarray(4), "other")).toThrow();
  });
  it("assembles fragmented bytes and refuses bytes observed during preparation", async () => {
    const p=pair(true), failed=vi.fn(), c=new AbortController();
    const reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,c.signal,false,failed);
    p.left.write(encodeGuestBootstrap(identity)); await expect(reader.identity).resolves.toEqual(identity);
    p.left.write(Buffer.from([0])); await tick();
    expect(failed).toHaveBeenCalledOnce(); expect(p.right.destroyed).toBe(true);
    expect(() => reader.handoff()).toThrow(); p.left.destroy();
  });
  it("rejects a coalesced early actor frame before resolving admission", async () => {
    const p=pair(), reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,new AbortController().signal);
    p.left.write(Buffer.concat([encodeGuestBootstrap(identity),Buffer.from([0])]));
    await expect(reader.identity).rejects.toMatchObject({code:"protocol_mismatch"}); p.left.destroy();
  });
  it.each([0,GUEST_BOOTSTRAP_LIMITS.bytes+1,0xffffffff])("refuses length %i from header alone", async n => {
    const p=pair(), reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,new AbortController().signal);
    const b=Buffer.alloc(4);b.writeUInt32BE(n);p.left.write(b);
    await expect(reader.identity).rejects.toMatchObject({code:"protocol_mismatch"});p.left.destroy();
  });
  it("admits a canonical initial loopback URL without changing the READY identity", async () => {
    const p=pair(true), reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,new AbortController().signal);
    const initialUrl="http://localhost:3000/notes?q=%E2%9C%93";
    p.left.write(encodeGuestBootstrap(identity,false,initialUrl));
    await expect(reader.identity).resolves.toEqual(identity);
    expect(reader.initialUrl).toBe(initialUrl);
    expect(parseGuestBootstrap(encodeGuestBootstrap(identity,true).subarray(4),identity.runtimeRevision,true)).toEqual(identity);
    reader.close(); p.left.destroy();
  });
  it("admits only an explicit native media configuration, while READY stays unchanged", async () => {
    const p = pair(true), reader = new GuestBootstrapReader(p.right, identity.runtimeRevision, new AbortController().signal);
    const media = { camera: { source: "synthetic" }, microphone: { source: "speech" }, permission: "prompt" } as const;
    p.left.write(encodeGuestBootstrap(identity, false, "http://localhost:3000/", media));
    await reader.identity;
    expect(reader.media).toEqual(media);
    expect(() => encodeGuestBootstrap(identity, true, undefined, media)).toThrow();
    reader.close(); p.left.destroy();
    for (const invalid of [{ permission: "prompt" }, { camera: { source: "/tmp/camera.y4m" }, permission: "prompt" },
      { microphone: { source: "speech" }, permission: "prompt", command: "echo unsafe" }]) {
      expect(() => parseGuestBootstrap(Buffer.from(JSON.stringify({ version: 1, identity, media: invalid })), identity.runtimeRevision)).toThrow();
    }
  });
  it.each(["http://example.com:3000/","http://localhost/","http://localhost:80/","http://localhost:1023/",
    "http://user:password@localhost:3000/","file:///tmp/notes.html","http://[::1]:3000/","http://localhost:65536/",
    "http://localhost:3000/"+"a".repeat(GUEST_BOOTSTRAP_LIMITS.initialUrlBytes)])("refuses unsupported initial URL %# before dispatch", initialUrl => {
    expect(()=>encodeGuestBootstrap(identity,false,initialUrl)).toThrow();
    const bytes=Buffer.from(JSON.stringify({version:1,identity,initialUrl}));
    expect(()=>parseGuestBootstrap(bytes,identity.runtimeRevision)).toThrow();
  });
  it("does not admit an initial URL on READY or enlarge the READY byte bound", async () => {
    expect(()=>encodeGuestBootstrap(identity,true,"http://localhost:3000/")).toThrow();
    const p=pair(), reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,new AbortController().signal,true);
    const header=Buffer.alloc(4);header.writeUInt32BE(GUEST_BOOTSTRAP_LIMITS.readyBytes+1);p.left.write(header);
    await expect(reader.identity).rejects.toMatchObject({code:"protocol_mismatch"});p.left.destroy();
  });
  it("does not extend the original admission deadline for trickled header bytes", async () => {
    vi.useFakeTimers();const p=pair(), reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,new AbortController().signal);
    p.left.write(Buffer.from([0]));await vi.advanceTimersByTimeAsync(4999);p.left.write(Buffer.from([0]));
    const result=expect(reader.identity).rejects.toMatchObject({code:"deadline_exceeded"});await vi.advanceTimersByTimeAsync(1);await result;p.left.destroy();
  });
  it("rejects EOF and abort, including already-aborted admission", async () => {
    for(const mode of ['eof','abort','already']) {
      const p=pair(),c=new AbortController();if(mode==='already')c.abort();
      const reader=new GuestBootstrapReader(p.right,identity.runtimeRevision,c.signal);
      if(mode==='eof'){p.left.write(Buffer.from([0]));p.left.destroy();}else c.abort();
      await expect(reader.identity).rejects.toBeDefined();p.left.destroy();
    }
  });
  it("CONNECT accepts the assigned host port and preserves a bounded coalesced READY tail", async () => {
    const p=pair(), calls:Buffer[]=[];
    p.right.on('data',(data:Buffer)=>{calls.push(data);if(calls.length===1)p.right.write(Buffer.concat([Buffer.from('OK 1033\n'),encodeGuestBootstrap(identity,true)]));});
    await connectGuestBootstrap(p.left,identity,new AbortController().signal);
    expect(calls[0]?.toString()).toBe('CONNECT 5251\n');expect(calls[1]).toEqual(encodeGuestBootstrap(identity));p.left.destroy();p.right.destroy();
  });
  it.each(['OK 0\n','OK 4294967296\n','OK 4 extra\n','OK 4\r\n','x'.repeat(65)])("refuses malformed CONNECT response %#",async line=>{
    const p=pair();p.right.once('data',()=>p.right.write(line));
    await expect(connectGuestBootstrap(p.left,identity,new AbortController().signal)).rejects.toBeDefined();p.right.destroy();
  });
  it("returns a fully handed-off client that completes HELLO without caller resume", async () => {
    const p=pair(),c=new AbortController();let runtime:Awaited<ReturnType<typeof runGuestRuntime>>|undefined;
    p.right.once('data',()=>{
      p.right.write('OK 9876\n');
      void runGuestRuntime({transport:p.right,revision:identity.runtimeRevision,signal:c.signal,marker:()=>{},
        createDesktop:async()=>({executor:{execute:async()=>{},observe:async()=>{throw new Error();}},close:async()=>({complete:true})})}).then(value=>{runtime=value;});
    });
    const client=await connectGuestBootstrap(p.left,identity,c.signal);await client.ready();
    client.close();await tick();await runtime?.closed;
  });
  it("rejects high-bit bytes before ASCII decoding the CONNECT preface",async()=>{
    const p=pair();p.right.once('data',()=>p.right.write(Buffer.from([0xcf,0xcb,32,49,10])));
    await expect(connectGuestBootstrap(p.left,identity,new AbortController().signal)).rejects.toBeDefined();p.right.destroy();
  });
  it("contains a native error queued in the CONNECT-to-bootstrap ownership gap",()=>{
    const module=new URL('../src/guest-bootstrap.ts',import.meta.url).href;
    const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
      import {Duplex} from 'node:stream';
      import {connectGuestBootstrap} from ${JSON.stringify(module)};
      const stream=new Duplex({read(){},write(chunk,encoding,cb){
        this.push(Buffer.from('OK 9\\n'));this.emit('error',new Error('synthetic transport fault'));cb();
      }});
      try { await connectGuestBootstrap(stream,{generation:'g',challenge:'c',runtimeRevision:'r'},new AbortController().signal);process.exitCode=2; }
      catch { console.log('contained'); }
    `],{encoding:'utf8',timeout:10_000});
    expect(output.trim()).toBe('contained');
  });
});
