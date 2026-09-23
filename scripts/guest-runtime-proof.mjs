// Ordinary owned containers only. No VM, privileged mode, host mounts or network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,cp,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { parseGuestProofResult,parseGuestRelayImport,validateGuestProofCell } from './guest-runtime-proof-contract.mjs';
import { packageGuestRuntime } from './guest-runtime-package.mjs';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'..');
const base=process.env.HUMANISH_GUEST_IMAGE;
assert.match(base??'',/^sha256:[a-f0-9]{64}$/);
const dir=join(root,'.humanish/guest-runtime-proof',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID());
await mkdir(dir,{recursive:true,mode:0o700});
const hash=data=>createHash('sha256').update(data).digest('hex');
const proofSourceHashes={};
for(const name of ['scripts/guest-runtime-proof.mjs','scripts/guest-runtime-proof-child.mjs','scripts/guest-runtime-proof-contract.mjs','scripts/guest-runtime-package.mjs','scripts/guest-desktop-proof-child.mjs'])proofSourceHashes[name]=hash(await readFile(join(root,name)));
const manifest=await packageGuestRuntime(join(dir,'package'));
const context=join(dir,'context');await mkdir(context);
await cp(join(dir,'package/root'),join(context,'root'),{recursive:true});
await mkdir(join(context,'proof'));
await cp(join(root,'scripts/guest-runtime-proof-child.mjs'),join(context,'proof/runtime.mjs'));
await cp(join(root,'scripts/guest-desktop-proof-child.mjs'),join(context,'proof/driver.mjs'));
await cp(join(dir,'package/root/opt/humanish/control'),join(context,'proof/runtime'),{recursive:true});
// Existing17-case harness imports its fixed dist/node_modules siblings.
await cp(join(dir,'package/root/opt/humanish/control'),join(context,'proof/dist'),{recursive:true});
await cp(join(dir,'package/root/opt/humanish/control/node_modules'),join(context,'proof/node_modules'),{recursive:true});
await writeFile(join(context,'proof/package.json'),'{"type":"module"}\n');
await writeFile(join(context,'proof/driver-wrap.mjs'),`import './driver.mjs';\nimport {readFile} from 'node:fs/promises';\nconst r=JSON.parse(await readFile('/opt/proof/output/result.json','utf8'));r.memoryMax=(await readFile('/sys/fs/cgroup/memory.max','utf8')).trim();r.memoryPeak=(await readFile('/sys/fs/cgroup/memory.peak','utf8')).trim();r.memoryEvents=await readFile('/sys/fs/cgroup/memory.events','utf8');r.pidsMax=(await readFile('/sys/fs/cgroup/pids.max','utf8')).trim();r.pidsPeak=await readFile('/sys/fs/cgroup/pids.peak','utf8').then(s=>s.trim(),()=>null);r.pidsEvents=await readFile('/sys/fs/cgroup/pids.events','utf8');r.uid=process.getuid();r.gid=process.getgid();console.log('HUMANISH_RESULT '+JSON.stringify(r));\nfor(const name of ['address-bar','unicode','saved','scroll']){try{console.log('HUMANISH_IMAGE '+name+' '+(await readFile('/opt/proof/output/'+name+'.png')).toString('base64'));}catch{}}\n`);
// Test-only finite mount scaffolding followed by permanent guest-user drop.
await writeFile(join(context,'proof/launch.py'),`import os,sys
for path,mode,uid in [('/run/humanish',0o700,1000),('/tmp/.X11-unix',0o1777,0),('/tmp/.ICE-unix',0o1777,0)]:
 os.mkdir(path,mode);os.chmod(path,mode);os.chown(path,uid,uid)
os.setgroups([]);os.setgid(1000);os.setuid(1000)
# Load the exact guest relay under its installed Python without calling main.
# This imports required stdlib modules but creates no socket or child process.
import hashlib,json
relay_path='/opt/humanish/control/vsock.py'
with open(relay_path,'rb') as relay_file:
 relay_bytes=relay_file.read(65537)
assert 0<len(relay_bytes)<=65536
relay_globals={'__name__':'humanish_import_check'}
exec(compile(relay_bytes,relay_path,'exec'),relay_globals)
assert hasattr(relay_globals['socket'],'AF_VSOCK')
print('HUMANISH_RELAY_IMPORT '+json.dumps({'passed':True,'afVsock':True,'pythonVersion':sys.version.split()[0],'moduleSha256':hashlib.sha256(relay_bytes).hexdigest(),'uid':os.getuid(),'gid':os.getgid()},separators=(',',':')),flush=True)
env={'PATH':'/usr/bin:/bin','HOME':'/home/humanish','LANG':'C.UTF-8','LC_ALL':'C.UTF-8'}
script='/opt/proof/driver-wrap.mjs' if sys.argv[1]=='driver' else '/opt/proof/runtime.mjs'
os.execve('/usr/bin/node',['node',script,sys.argv[1]],env)
`);
const localTag='humanish-proof-base-'+randomUUID()+':local';
await writeFile(join(context,'Dockerfile'),`FROM ${localTag}\nUSER 0:0\nCOPY root/ /\nCOPY proof/ /opt/proof/\nRUN chmod -R a+rX /opt/proof && chmod 0444 /opt/humanish/control/openbox.xml\nUSER 1000:1000\n`);
const profilePath=join(dir,'seccomp.json'),profileHash='cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849';
const response=await fetch('https://raw.githubusercontent.com/microsoft/playwright/v1.60.0/utils/docker/seccomp_profile.json',{signal:AbortSignal.timeout(15000)});assert.equal(response.ok,true);
const profile=Buffer.from(await response.arrayBuffer());assert.ok(profile.length<=65536);assert.equal(createHash('sha256').update(profile).digest('hex'),profileHash);await writeFile(profilePath,profile);
assert.equal(JSON.parse((await exec('docker',['image','inspect',base],{timeout:10000})).stdout)[0].Id,base);
await exec('docker',['image','tag',base,localTag],{timeout:10000});
try{
 assert.equal(JSON.parse((await exec('docker',['image','inspect',localTag],{timeout:10000})).stdout)[0].Id,base);
 const build=await exec('docker',['build','--pull=false','--network','none','--iidfile',join(dir,'image-id'),context],{timeout:120000,maxBuffer:4*1024*1024});await writeFile(join(dir,'build.log'),build.stdout+build.stderr);
}catch(error){await writeFile(join(dir,'build.log'),String(error.stdout??'')+String(error.stderr??''));await writeFile(join(dir,'receipt.json'),JSON.stringify({base,vmBooted:false,passed:false,phase:'proof-image-build',error:String(error.message).slice(0,500)}));throw error;}
finally{await exec('docker',['image','rm',localTag],{timeout:10000});}
const image=(await readFile(join(dir,'image-id'),'utf8')).trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
const baseLayers=JSON.parse((await exec('docker',['image','inspect',base],{timeout:10000})).stdout)[0].RootFS.Layers;
const imageLayers=JSON.parse((await exec('docker',['image','inspect',image],{timeout:10000})).stdout)[0].RootFS.Layers;
assert.deepEqual(imageLayers.slice(0,baseLayers.length),baseLayers);
const proofGeneratedHashes={};
for(const name of ['Dockerfile','proof/launch.py','proof/driver-wrap.mjs'])proofGeneratedHashes[name]=hash(await readFile(join(context,name)));
const receipt={base,image,baseLayers,imageLayers,runtimeRevision:manifest.runtimeRevision,packageManifestSha256:hash(await readFile(join(dir,'package/manifest.json'))),proofSourceHashes,proofGeneratedHashes,seccompSha256:profileHash,scope:'constrained container only',vmBooted:false,cells:[]};
for(const mode of ['driver','owned-stream','packaged-main']){
 let owned;const attempt=randomUUID(),cidfile=join(dir,mode+'-cid');const cell={mode,acquisition:'attempted',attempt};receipt.cells.push(cell);await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2));
 try{
  const created=await exec('docker',['create','--cidfile',cidfile,'--label','humanish.proof.attempt='+attempt,'--network','none','--init','--read-only','--pids-limit','256','--memory','1536m','--memory-swap','1536m','--shm-size','256m','--user','0:0',
   '--tmpfs','/run:rw,nosuid,nodev,mode=0755,size=64m','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=128m','--tmpfs','/var:rw,nosuid,nodev,mode=0755,size=64m',
   '--tmpfs','/home/humanish:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=512m','--tmpfs','/opt/proof/output:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=32m',
   '--security-opt',`seccomp=${profilePath}`,image,'python3','-I','-B','/opt/proof/launch.py',mode],{timeout:30000});
  const candidate=created.stdout.trim();assert.match(candidate,/^[a-f0-9]{64}$/);owned=candidate;cell.acquisition='owned';cell.ownedContainer=owned;await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2));
  const pre=JSON.parse((await exec('docker',['inspect',owned],{timeout:10000})).stdout)[0];
  assert.equal(pre.Id,owned);assert.equal(pre.Image,image);assert.equal(pre.Config.Labels['humanish.proof.attempt'],attempt);
  const h=pre.HostConfig;assert.equal(h.Privileged,false);assert.equal(h.ReadonlyRootfs,true);assert.equal(h.NetworkMode,'none');assert.equal(h.Memory,1610612736);assert.equal(h.MemorySwap,h.Memory);assert.equal(h.PidsLimit,256);assert.equal(h.ShmSize,268435456);
  assert.deepEqual(h.Binds??[],[]);assert.deepEqual(h.Devices??[],[]);assert.deepEqual(h.DeviceRequests??[],[]);assert.ok(pre.Mounts.every(m=>m.Type==='tmpfs'));
  assert.deepEqual(h.Tmpfs,{'/run':'rw,nosuid,nodev,mode=0755,size=64m','/tmp':'rw,nosuid,nodev,mode=1777,size=128m','/var':'rw,nosuid,nodev,mode=0755,size=64m','/home/humanish':'rw,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=512m','/opt/proof/output':'rw,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=32m'});
  cell.preflight={image:pre.Image,hostConfig:h,mounts:pre.Mounts};await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2));
  let output='';try{const r=await exec('docker',['start','--attach',owned],{timeout:180000,maxBuffer:32*1024*1024});output=r.stdout+r.stderr;}catch(error){output=String(error.stdout??'')+String(error.stderr??'');cell.commandFailure=String(error.message).slice(0,300);}
  await mkdir(join(dir,mode));await writeFile(join(dir,mode,'container.log'),output);
  cell.relayImport=parseGuestRelayImport(output);
  cell.relayModuleSha256=manifest.files['opt/humanish/control/vsock.py'].sha256;
  cell.result=parseGuestProofResult(output);
  for(const line of output.split('\n')){
   if(line.startsWith('HUMANISH_IMAGE ')){const [,name,data]=line.split(' ');assert.match(name,/^[a-z-]+$/);await writeFile(join(dir,mode,name+'.png'),Buffer.from(data,'base64'));}
  }
  const inspected=JSON.parse((await exec('docker',['inspect',owned],{timeout:10000})).stdout)[0];
  assert.equal(inspected.Config.Labels['humanish.proof.attempt'],attempt);cell.state=inspected.State;
  cell.hostConfig=Object.fromEntries(['Memory','MemorySwap','ReadonlyRootfs','Tmpfs','ShmSize','NetworkMode','Privileged','Binds','Devices','DeviceRequests','PidsLimit'].map(key=>[key,inspected.HostConfig[key]]));
  cell.mounts=inspected.Mounts.map(m=>({Type:m.Type,Destination:m.Destination,RW:m.RW}));
  validateGuestProofCell(cell);
  cell.passed=true;
 }catch(error){cell.passed=false;cell.error=String(error).slice(0,500);}
 finally{
  const began=Date.now();
  try{
   if(!owned){try{const candidate=(await readFile(cidfile,'utf8')).trim();assert.match(candidate,/^[a-f0-9]{64}$/);owned=candidate;cell.ownedContainer=owned;cell.acquisition='recovered_owned';}catch{cell.acquisition='unknown';}}
   if(owned){
    const readback=JSON.parse((await exec('docker',['inspect',owned],{timeout:10000})).stdout)[0];assert.equal(readback.Id,owned);assert.equal(readback.Config.Labels['humanish.proof.attempt'],attempt);
    await exec('docker',['rm','--force',owned],{timeout:30000});
    try{await exec('docker',['inspect',owned],{timeout:10000});cell.absent=false;}
    catch(error){cell.absent=error.code===1&&/no such (object|container)/i.test(String(error.stderr));cell.absenceReadback={code:error.code,stderr:String(error.stderr).slice(0,200)};}
   }else cell.absent=false;
  }catch(error){cell.absent=false;cell.cleanupError=String(error).slice(0,500);}
  finally{cell.cleanupMs=Date.now()-began;await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2));}
 }
 await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2));
}
receipt.proofSourcesUnchanged=true;
for(const [name,expected] of Object.entries(proofSourceHashes))if(hash(await readFile(join(root,name)))!==expected)receipt.proofSourcesUnchanged=false;
receipt.passed=receipt.proofSourcesUnchanged&&receipt.cells.every(c=>c.passed&&c.absent);
await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify({directory:dir,cells:receipt.cells.map(c=>({mode:c.mode,passed:c.passed,absent:c.absent,error:c.error}))}));
if(!receipt.passed)process.exitCode=1;
