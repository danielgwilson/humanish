import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const owned:string[]=[];
afterEach(async()=>{await Promise.all(owned.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(injection=''){
 const root=await mkdtemp(join(tmpdir(),'humanish-package-fixture-'));owned.push(root);
 for(const dir of ['scripts','src','dist','node_modules/pngjs','runtime/browser-guest/control/root/opt/humanish/control'])await mkdir(join(root,dir),{recursive:true});
 let script=await readFile(new URL('../scripts/guest-runtime-package.mjs',import.meta.url),'utf8');
 if(injection)script=script.replace('  await cp(fixed, root,',injection+'\n  await cp(fixed, root,');
 await writeFile(join(root,'scripts/guest-runtime-package.mjs'),script);
 await symlink(await realpath(new URL('../node_modules/typescript',import.meta.url)),join(root,'node_modules/typescript'),'dir');
 for(const file of ['pnpm-lock.yaml','tsconfig.json','tsconfig.build.json'])await writeFile(join(root,file),'{}\n');
 await writeFile(join(root,'runtime/browser-guest/control/links.json'),'{}');
 await writeFile(join(root,'runtime/browser-guest/control/root/opt/humanish/control/neutral.html'),'synthetic');
 await writeFile(join(root,'src/guest-runtime-main.ts'),'// synthetic compiler input\n');
 await writeFile(join(root,'src/guest-runtime-revision.ts'),'export const revision="unpackaged";\n');
 await writeFile(join(root,'dist/guest-runtime-main.js'),"import './guest-runtime-revision.js';import 'pngjs';\n");
 await writeFile(join(root,'dist/guest-runtime-revision.js'),'export const revision="unpackaged";\n');
 await writeFile(join(root,'node_modules/pngjs/package.json'),'{"name":"pngjs","main":"index.js"}');
 await writeFile(join(root,'node_modules/pngjs/index.js'),'// synthetic dependency\n');
 return root;
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 return JSON.stringify(value);
}
function run(root:string,output:string){return spawnSync(process.execPath,[join(root,'scripts/guest-runtime-package.mjs'),join(root,output)],{encoding:'utf8',timeout:15000});}
describe('guest package immutable input binding',()=>{
 it('binds actual compiled bytes and canonical inputs independently',async()=>{
  const root=await fixture();expect(run(root,'first').status).toBe(0);
  const first=JSON.parse(await readFile(join(root,'first/manifest.json'),'utf8'));
  expect(first.runtimeRevision).toBe('guest-api1-'+createHash('sha256').update(canonical(first.inputs)).digest('hex'));
  expect(first.inputs.sourceFiles['dist/guest-runtime-main.js']).toBeTruthy();
  expect(first.inputs.sourceFiles['dist/guest-runtime-revision.js']).toBeUndefined();
  await writeFile(join(root,'dist/guest-runtime-main.js'),"import './guest-runtime-revision.js';import 'pngjs';// changed executable\n");
  expect(run(root,'second').status).toBe(0);
  const second=JSON.parse(await readFile(join(root,'second/manifest.json'),'utf8'));
  expect(second.runtimeRevision).not.toBe(first.runtimeRevision);
 });
 it.each([
  "await writeFile(join(fixed,'opt/humanish/control/neutral.html'),'changed');",
  "await writeFile(join(fixed,'opt/humanish/control/late.txt'),'unbound');",
  "await writeFile(join(repository,'node_modules/pngjs/index.js'),'changed');",
  "await writeFile(join(repository,'node_modules/pngjs/late.js'),'unbound');",
  "await writeFile(join(repository,'src/guest-runtime-main.ts'),'changed');",
  "await writeFile(join(repository,'dist/guest-runtime-main.js'),'changed');",
  "await writeFile(join(repository,'pnpm-lock.yaml'),'changed');"
 ])('refuses mutation between snapshot and copy %#',async injection=>{
  // Instrument only a temporary copy at the real copy seam; production source
  // has no test hook or alternative packaging mode.
  const root=await fixture(injection);const result=run(root,'output');expect(result.status).not.toBe(0);
  await expect(readFile(join(root,'output/manifest.json'))).rejects.toBeDefined();
 });
 it('handles missing packaged metadata with a finite error and no uncaught AbortError',()=>{
  const main=new URL('../src/guest-runtime-main.ts',import.meta.url).pathname;
  try{execFileSync(process.execPath,['--import','tsx',main],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});throw new Error('expected refusal');}
  catch(error){const result=error as {status?:number;stderr?:string};expect(result.status).toBe(1);expect(result.stderr).toBe('humanish_guest_failed\n');}
 });
});
