import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const output = '/build/helper';
mkdirSync(output, { recursive: true });
const compiler = '/usr/bin/gcc';
const flags = ['-std=c11', '-O2', '-D_FORTIFY_SOURCE=3', '-fstack-protector-strong',
  '-Wall', '-Wextra', '-Werror', '-Wpedantic', '-Wl,-z,relro,-z,now'];
const args = [...flags, '/tmp/clipboard.c', '-o', `${output}/clipboard`, '-lX11', '-lXtst'];
execFileSync(compiler, args, { stdio: 'inherit' });
const describe = file => { const bytes = readFileSync(file); return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
copyFileSync('/tmp/clipboard.c', `${output}/clipboard.c`);
copyFileSync('/tmp/clipboard-protocol.md', `${output}/clipboard-protocol.md`);
const bytes = readFileSync(`${output}/clipboard`);
if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || !(statSync(`${output}/clipboard`).mode & 0o111)) throw new Error('Compiler did not produce an executable ELF helper');
const manifest = {
  schema: 'humanish.guest-clipboard-build.v1',
  source: { file: 'clipboard.c', ...describe('/tmp/clipboard.c') },
  protocol: { file: 'clipboard-protocol.md', ...describe('/tmp/clipboard-protocol.md') },
  binary: { file: 'clipboard', guestPath: '/opt/humanish/control/clipboard', ...describe(`${output}/clipboard`) },
  compiler: { path: compiler, version: execFileSync(compiler, ['--version'], { encoding: 'utf8' }).split('\n')[0], flags, libraries: ['X11', 'Xtst'] },
  qualification: 'compiled-only; browser transfer proof required'
};
writeFileSync(`${output}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
