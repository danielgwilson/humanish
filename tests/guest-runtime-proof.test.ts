import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone development harness is deliberately JavaScript.
import { GUEST_PROOF_CASES, parseGuestProofResult, validateGuestProofCell } from '../scripts/guest-runtime-proof-contract.mjs';
function sample(mode='packaged-main') {
 return {mode,commandFailure:undefined as string|undefined,state:{Status:'exited',ExitCode:0,OOMKilled:false},hostConfig:{Memory:1610612736,MemorySwap:1610612736,ShmSize:268435456,ReadonlyRootfs:true,NetworkMode:'none',Privileged:false,PidsLimit:256,Binds:[],Devices:[],DeviceRequests:[]},mounts:[],
  result:{vmBooted:false,cases:GUEST_PROOF_CASES[mode].map((name:string)=>({name,passed:true})),memoryMax:'1610612736',memoryPeak:'345678900',memoryEvents:'oom_kill 0\n',pidsMax:'256',pidsPeak:'99',pidsEvents:'max 0\n',uid:1000,gid:1000,readyMs:1234,cleanup:{main:{code:0,signal:null},runtime:{complete:true}}}};
}
describe('constrained guest proof receipts',()=>{
 it('accepts complete independently named runtime cells',()=>{validateGuestProofCell(sample());validateGuestProofCell(sample('owned-stream'));});
 it.each([
  (s:ReturnType<typeof sample>)=>{s.result.cases=[];},
  (s:ReturnType<typeof sample>)=>{s.result.cases[1]=s.result.cases[0];},
  (s:ReturnType<typeof sample>)=>{s.result.cases[0].passed=false;},
  (s:ReturnType<typeof sample>)=>{s.result.cleanup.main.code=1;},
  (s:ReturnType<typeof sample>)=>{s.result.readyMs=35001;},
  (s:ReturnType<typeof sample>)=>{s.hostConfig.Privileged=true;},
  (s:ReturnType<typeof sample>)=>{s.hostConfig.ReadonlyRootfs=false;},
  (s:ReturnType<typeof sample>)=>{s.hostConfig.Memory=2147483648;},
  (s:ReturnType<typeof sample>)=>{s.hostConfig.PidsLimit=1024;},
  (s:ReturnType<typeof sample>)=>{s.hostConfig.NetworkMode='host';},
  (s:ReturnType<typeof sample>)=>{s.result.memoryEvents='oom_kill 1\n';},
  (s:ReturnType<typeof sample>)=>{s.result.pidsEvents='max 1\n';},
  (s:ReturnType<typeof sample>)=>{s.result.uid=0;},
  (s:ReturnType<typeof sample>)=>{s.result.vmBooted=true;}
  ,(s:ReturnType<typeof sample>)=>{s.commandFailure='attach timeout';}
  ,(s:ReturnType<typeof sample>)=>{s.result.pidsPeak='257';}
 ])('refuses incomplete or widened proof %#',mutate=>{const s=sample();mutate(s);expect(()=>validateGuestProofCell(s)).toThrow();});
 it('does not promote uncertain owned-runtime cleanup',()=>{const s=sample('owned-stream');s.result.cleanup.runtime.complete=false;expect(()=>validateGuestProofCell(s)).toThrow();});
 it('requires exactly one result without last-result-wins replacement',()=>{
  expect(parseGuestProofResult('diagnostic\nHUMANISH_RESULT {"cases":[]}\n')).toEqual({cases:[]});
  expect(()=>parseGuestProofResult('')).toThrow();
  expect(()=>parseGuestProofResult('HUMANISH_RESULT {}\nHUMANISH_RESULT {}\n')).toThrow();
 });
});
