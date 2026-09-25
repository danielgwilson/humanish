import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGuestRuntime } from '../src/guest-runtime.js';
import { GuestBootstrapReader, encodeGuestBootstrap } from '../src/guest-bootstrap.js';
import { createBrowserControlClient } from '../src/browser-control-client.js';
import { identity, pair, observation, tick } from './browser-control-fixture.js';

afterEach(()=>vi.useRealTimers());
function fixture() {
  const p=pair(),owner=new AbortController(),close=vi.fn(async()=>({complete:true})),execute=vi.fn(async()=>{}),observe=vi.fn(async()=>observation()),marker=vi.fn();
  const desktop={executor:{execute,observe},close};
  const createDesktop=vi.fn(async()=>desktop);
  return {...p,owner,close,execute,observe,marker,desktop,createDesktop};
}
describe('one guest runtime lifecycle',()=>{
  it('installs the dispatcher before immediate HELLO and closes exact desktop after EOF',async()=>{
    const f=fixture();
    const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:f.marker,createDesktop:f.createDesktop});
    const ready=new GuestBootstrapReader(f.left,identity.runtimeRevision,f.owner.signal,true);
    f.left.write(encodeGuestBootstrap(identity));await ready.identity;ready.handoff();
    const client=createBrowserControlClient({transport:f.left,identity});f.left.resume();await client.ready();
    expect(f.marker.mock.calls).toEqual([['A'],['R']]);expect(f.execute).not.toHaveBeenCalled();
    expect(await client.executor.observe()).toEqual(observation());
    const runtime=await running;client.close();expect(await runtime.closed).toEqual({complete:true});expect(f.close).toHaveBeenCalledOnce();
    await runtime.close();expect(f.close).toHaveBeenCalledOnce();
  });
  it('never creates a desktop for a malformed or early coalesced frame',async()=>{
    const f=fixture();const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:f.marker,createDesktop:f.createDesktop});
    f.left.write(Buffer.concat([encodeGuestBootstrap(identity),Buffer.from([1])]));await expect(running).rejects.toBeDefined();
    expect(f.createDesktop).not.toHaveBeenCalled();expect(f.marker).not.toHaveBeenCalled();f.left.destroy();
  });
  it('refuses bytes during async desktop preparation and reclaims late resources',async()=>{
    const f=fixture();let release!:(value:typeof f.desktop)=>void;
    const createDesktop=vi.fn(()=>new Promise<typeof f.desktop>(resolve=>{release=resolve;}));
    const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:f.marker,createDesktop});
    f.left.write(encodeGuestBootstrap(identity));await tick();f.left.write(Buffer.from([1]));await tick();release(f.desktop);
    await expect(running).rejects.toBeDefined();expect(f.close).toHaveBeenCalledOnce();expect(f.marker.mock.calls).toEqual([['A']]);f.left.destroy();
  });
  it('bounds an unresolved factory/cleanup and preserves incomplete teardown',async()=>{
    vi.useFakeTimers();const f=fixture();
    const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:f.marker,createDesktop:()=>new Promise(()=>{})});
    const rejected=expect(running).rejects.toBeDefined();f.left.write(encodeGuestBootstrap(identity));await vi.advanceTimersByTimeAsync(35000+4000);await rejected;
    expect(f.right.destroyed).toBe(true);expect(f.marker.mock.calls).toEqual([['A']]);f.left.destroy();
  });
  it('revokes before cleanup even if marker transmission fails',async()=>{
    const f=fixture();let observed:AbortSignal|undefined;
    const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:value=>{if(value==='R')throw new Error('synthetic');},
      createDesktop:async signal=>{observed=signal;return f.desktop;}});
    f.left.write(encodeGuestBootstrap(identity));await expect(running).rejects.toBeDefined();expect(observed?.aborted).toBe(true);expect(f.close).toHaveBeenCalledOnce();f.left.destroy();
  });
  it('withholds READY until initial navigation finishes and forwards only the admitted URL',async()=>{
    const f=fixture(); let finish!:()=>void;
    const navigation=new Promise<void>(resolve=>{finish=resolve;});
    const initialUrl='http://127.0.0.1:3000/notes';
    const createDesktop=vi.fn(async(_signal:AbortSignal,_terminal:()=>void,url?:string)=>{expect(url).toBe(initialUrl);await navigation;return f.desktop;});
    const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:f.marker,createDesktop});
    const ready=new GuestBootstrapReader(f.left,identity.runtimeRevision,f.owner.signal,true);
    f.left.write(encodeGuestBootstrap(identity,false,initialUrl));await tick();
    expect(f.marker.mock.calls).toEqual([['A']]); expect(createDesktop).toHaveBeenCalledOnce();
    finish();await ready.identity;ready.handoff();
    expect(f.marker.mock.calls).toEqual([['A'],['R']]);
    const runtime=await running;f.left.destroy();await runtime.closed;
  });
  it('never acknowledges an initial navigation failure',async()=>{
    const f=fixture();
    const running=runGuestRuntime({transport:f.right,revision:identity.runtimeRevision,signal:f.owner.signal,marker:f.marker,
      createDesktop:async()=>{throw new Error('Synthetic navigation failure');}});
    f.left.write(encodeGuestBootstrap(identity,false,'http://localhost:3000/'));
    await expect(running).rejects.toThrow('Synthetic navigation failure');
    expect(f.marker.mock.calls).toEqual([['A']]);expect(f.right.destroyed).toBe(true);f.left.destroy();
  });
});
