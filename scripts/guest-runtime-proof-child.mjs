// Synthetic owner-side assertions. This file is excluded from the guest package.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createGuestRuntimeDesktop } from '/opt/humanish/control/guest-runtime-desktop.js';
import { runGuestRuntime } from '/opt/humanish/control/guest-runtime.js';
import { GuestBootstrapReader, encodeGuestBootstrap } from '/opt/humanish/control/guest-bootstrap.js';
import { createBrowserControlClient } from '/opt/humanish/control/browser-control-client.js';
import { GUEST_RUNTIME_REVISION } from '/opt/humanish/control/guest-runtime-revision.js';

const mode=process.argv[2];
const output='/opt/proof/output';
const result={scope:mode,vmBooted:false,uid:process.getuid(),gid:process.getgid(),cases:[],cleanup:{}};
let runtime,desktop,client,server,child,childClosed,terminal=false;
const owner=new AbortController();
async function check(name,fn){await fn();result.cases.push({name,passed:true});}
async function capture(name){const value=await client.executor.observe();assert.equal(value.screenshot.readUInt32BE(16),960);assert.equal(value.screenshot.readUInt32BE(20),720);await writeFile(output+'/'+name+'.png',value.screenshot);return value;}
let timer;
const bounded=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned proof deadline')),ms);})]).finally(()=>clearTimeout(timer));
try {
  result.memoryMax=(await readFile('/sys/fs/cgroup/memory.max','utf8')).trim();assert.equal(result.memoryMax,String(1536*1024*1024));
  result.pidsMax=(await readFile('/sys/fs/cgroup/pids.max','utf8')).trim();assert.equal(result.pidsMax,'256');
  result.mountinfo=await readFile('/proc/self/mountinfo','utf8');
  assert.match(result.mountinfo,/ \/ ro[, ]/);
  let stream;
  const markers=[];
  if(mode==='owned-stream'){
    server=createServer();const accepted=new Promise(resolve=>server.once('connection',resolve));
    await new Promise(resolve=>server.listen('/run/humanish/proof.sock',resolve));
    stream=createConnection('/run/humanish/proof.sock');await new Promise(resolve=>stream.once('connect',resolve));
    const peer=await accepted;server.close();
    runtime=runGuestRuntime({transport:peer,revision:GUEST_RUNTIME_REVISION,signal:owner.signal,marker:value=>markers.push(value),
      createDesktop:async(signal,onTerminal)=>{desktop=await createGuestRuntimeDesktop({signal,onTerminal,onPhase:phase=>{(result.phases??=[]).push({phase,at:Date.now()});}});return desktop;}});
    void runtime.catch(error=>{result.startupPhase=error.phase;});
  }else if(mode==='packaged-main'){
    child=spawn('/usr/bin/node',['/opt/humanish/control/guest-runtime-main.js'],{env:{PATH:'/usr/bin:/bin',HUMANISH_GUEST_SUPERVISION_FD:'3'},stdio:['pipe','pipe','pipe','pipe']});
    childClosed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    child.stderr.on('data',data=>{result.stderrBytes=(result.stderrBytes??0)+data.length;assert.ok(result.stderrBytes<16384);});
    child.stdio[3].on('data',data=>markers.push(...data.toString('ascii')));
    stream=Duplex.from({readable:child.stdout,writable:child.stdin});
  }else throw new Error('Unknown proof cell');
  const identity={generation:'synthetic-owned-guest',challenge:'synthetic-owned-challenge',runtimeRevision:GUEST_RUNTIME_REVISION};
  const reader=new GuestBootstrapReader(stream,GUEST_RUNTIME_REVISION,owner.signal,true);
  const started=Date.now();stream.write(encodeGuestBootstrap(identity));await bounded(reader.identity,35000);reader.handoff();
  client=createBrowserControlClient({transport:stream,identity});stream.resume();await client.ready();
  result.readyMs=Date.now()-started;
  await check('bootstrap and immediate HELLO',async()=>{await delay(25);assert.deepEqual(markers,['A','R']);});
  await check('full-frame observation',async()=>{await capture('initial');});
  const text='Cafe\u0301 café 日本語 中文 한글 🙂 👩‍💻';
  await client.executor.execute({kind:'keypress',keys:['CTRL','a']});
  await client.executor.execute({kind:'type',text});
  await check('Unicode insertion acknowledged and recaptured',async()=>{await capture('unicode');});
  if(desktop){
    const {page,context,sandboxReport,configSha256}=desktop.owner;
    await check('independent exact Unicode DOM readback',async()=>{assert.equal(await page.locator('#note').inputValue(),text);});
    await check('owned single page and sandbox report',async()=>{assert.deepEqual(context.pages(),[page]);assert.match(sandboxReport,/adequately sandboxed/);result.sandboxReport=sandboxReport;});
    await check('constrained config is the readable pinned input',async()=>{assert.equal(configSha256,'4ae1c52eab748a3624b3948ce792647be258caba70c8c72038b9a43be6459552');
      await client.executor.execute({kind:'keypress',keys:['ALT','F2']});
      await client.executor.execute({kind:'type',text:'unchanged focus'});
      assert.equal(await page.locator('#note').inputValue(),text+'unchanged focus');});
  }
  client.close();terminal=true;
  if(runtime)result.cleanup.runtime=await bounded((await runtime).closed,6000);
  if(childClosed)result.cleanup.main=await bounded(childClosed,6000);
  assert.equal(result.cleanup.runtime?.complete??true,true);
  if(childClosed)assert.equal(result.cleanup.main.code,0);
  result.memoryPeak=(await readFile('/sys/fs/cgroup/memory.peak','utf8')).trim();
  result.memoryEvents=await readFile('/sys/fs/cgroup/memory.events','utf8');
  result.pidsPeak=await readFile('/sys/fs/cgroup/pids.peak','utf8').then(s=>s.trim(),()=>null);
  result.pidsEvents=await readFile('/sys/fs/cgroup/pids.events','utf8');
  assert.match(result.memoryEvents,/oom_kill 0/);
}catch(error){result.error=String(error).slice(0,500);process.exitCode=1;}
finally{
  owner.abort();client?.close();
  if(!terminal&&runtime){try{result.cleanup.runtime=await bounded((await runtime).close(),6000);}catch{result.cleanup.runtime={complete:false};}}
  server?.close();
  if(child&&child.exitCode===null){child.kill('SIGKILL');await bounded(childClosed,3000).catch(()=>{});}
  await writeFile(output+'/result.json',JSON.stringify(result));
  console.log('HUMANISH_RESULT '+JSON.stringify(result));
  for(const name of ['initial','unicode']){try{console.log('HUMANISH_IMAGE '+name+' '+(await readFile(output+'/'+name+'.png')).toString('base64'));}catch{}}
}
