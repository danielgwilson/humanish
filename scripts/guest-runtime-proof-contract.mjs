import assert from 'node:assert/strict';
export const GUEST_PROOF_CASES=Object.freeze({
 driver:['native address bar navigation','Unicode exact readback','rapid consecutive text stays ordered','stalled renderer Unicode readback','large Unicode transfer and literal multiline text','cancel after actual content preparation makes no input','isolated focus probe resists page prototype replacement','address bar rejects Unicode and controls without typing','additional tab is rejected without mutating either page','iframe text is explicitly unsupported','navigation invalidates a prepared insertion','native click uses full-frame coordinates','double click and multi-point drag','native wheel scroll','reject bad key without input','modal dialog rejects text without accepting or filling it','revocation during drag sends no release'],
 'owned-stream':['bootstrap and immediate HELLO','full-frame observation','Unicode insertion acknowledged and recaptured','independent exact Unicode DOM readback','owned single page and sandbox report','constrained config is the readable pinned input'],
 'packaged-main':['bootstrap and immediate HELLO','full-frame observation','Unicode insertion acknowledged and recaptured']
});
export function validateGuestProofCell(cell){
 assert.ok(Object.hasOwn(GUEST_PROOF_CASES,cell.mode));
 assert.equal(cell.commandFailure,undefined);
 assert.equal(cell.state.Status,'exited');assert.equal(cell.state.ExitCode,0);assert.equal(cell.state.OOMKilled,false);
 const h=cell.hostConfig;assert.equal(h.Memory,1536*1024*1024);assert.equal(h.MemorySwap,h.Memory);assert.equal(h.ShmSize,256*1024*1024);
 assert.equal(h.ReadonlyRootfs,true);assert.equal(h.NetworkMode,'none');assert.equal(h.Privileged,false);
 assert.equal(h.PidsLimit,256);
 assert.deepEqual(h.Binds??[],[]);assert.deepEqual(h.Devices??[],[]);assert.deepEqual(h.DeviceRequests??[],[]);
 assert.ok(cell.mounts.every(m=>m.Type==='tmpfs'));
 const r=cell.result;assert.equal(r.error,undefined);assert.deepEqual(r.cases.map(c=>c.name),GUEST_PROOF_CASES[cell.mode]);assert.ok(r.cases.every(c=>c.passed===true));
 assert.equal(r.memoryMax,String(h.Memory));assert.ok(/^\d+$/.test(r.memoryPeak));assert.ok(Number(r.memoryPeak)>0&&Number(r.memoryPeak)<=h.Memory);
 assert.match(r.memoryEvents,/(?:^|\n)oom_kill 0(?:\n|$)/);assert.equal(r.uid,1000);assert.equal(r.gid,1000);
 assert.equal(r.pidsMax,'256');assert.match(r.pidsEvents,/(?:^|\n)max 0(?:\n|$)/);
 if(r.pidsPeak!==null){assert.match(r.pidsPeak,/^\d+$/);assert.ok(Number(r.pidsPeak)>0&&Number(r.pidsPeak)<=256);}
 if(cell.mode==='driver'){
  assert.deepEqual(r.cleanup.errors,[]);for(const key of ['textPortClosed','browserClosed','serverClosed','child0Exited','child1Exited','privateDirectoryRemoved'])assert.equal(r.cleanup[key],true);
 }else{
  assert.equal(r.vmBooted,false);assert.ok(Number.isInteger(r.readyMs)&&r.readyMs>=0&&r.readyMs<=35000);
  if(cell.mode==='owned-stream')assert.equal(r.cleanup.runtime.complete,true);
  else{assert.equal(r.cleanup.main.code,0);assert.equal(r.cleanup.main.signal,null);}
 }
}
export function parseGuestProofResult(output){
 const lines=output.split('\n').filter(line=>line.startsWith('HUMANISH_RESULT '));
 assert.equal(lines.length,1);
 return JSON.parse(lines[0].slice(16));
}
