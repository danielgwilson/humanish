import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = text => text.trim().split(/\n\n+/).map(block => Object.fromEntries(block.split('\n').filter(line => /^[^\s:]+:/.test(line)).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()])));
mkdirSync('/build/notices', { recursive: true });
mkdirSync('/build/debs', { recursive: true });
mkdirSync('/build/apt', { recursive: true });
const archives = new Map();
for (const filename of readdirSync('/var/cache/apt/archives').filter(name => name.endsWith('.deb'))) {
  const path = join('/var/cache/apt/archives', filename);
  const info = parse(run('/usr/bin/dpkg-deb', ['-f', path]))[0];
  const bytes = readFileSync(path);
  archives.set(`${info.Package}=${info.Version}:${info.Architecture}`, { file: filename, sha256: sha(bytes), size: bytes.length });
  copyFileSync(path, join('/build/debs', filename));
}
const rows = run('/usr/bin/dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n']).trim().split('\n');
const packages = [];
for (const row of rows) {
  const [binary, version, architecture, source, sourceVersion] = row.split('\t');
  const name = binary.replace(/:[^:]+$/, '');
  const archive = archives.get(`${name}=${version}:${architecture}`);
  if (!archive) throw new Error(`Missing installed package archive: ${name}`);
  const metadata = parse(run('/usr/bin/apt-cache', ['show', `${binary}=${version}`])).find(item => item.Version === version && item.Architecture === architecture);
  if (!metadata || metadata.SHA256 !== archive.sha256 || Number(metadata.Size) !== archive.size) throw new Error(`Package archive verification failed: ${name}`);
  const copyright = readFileSync(`/usr/share/doc/${name}/copyright`);
  const notice = `${name}.copyright`;
  writeFileSync(join('/build/notices', notice), copyright);
  packages.push({ name, version, architecture, source, sourceVersion, archive: { ...archive, repositoryPath: metadata.Filename }, notice: { file: notice, sha256: sha(copyright), size: copyright.length } });
}
packages.sort((a, b) => a.name.localeCompare(b.name));
const sources = [];
for (const key of [...new Set(packages.map(pkg => `${pkg.source}=${pkg.sourceVersion}`))].sort()) {
  const split = key.indexOf('='), name = key.slice(0, split), version = key.slice(split + 1);
  const output = run('/usr/bin/apt-cache', ['showsrc', name]);
  const blocks = output.trim().split(/\n\n+/);
  const block = blocks.find(value => parse(value)[0].Version === version);
  if (!block) throw new Error(`Missing matching signed source metadata: ${name}`);
  const record = parse(block)[0];
  const match = /^Checksums-Sha256:\n((?: .+\n?)+)/m.exec(block);
  if (!match) throw new Error(`Missing source checksums: ${name}`);
  const files = match[1].trim().split('\n').map(line => { const [sha256, size, file] = line.trim().split(/\s+/); return { file, size: Number(size), sha256 }; });
  sources.push({ name, version, directory: record.Directory, files, archiveBytesRetained: false });
}
for (const filename of readdirSync('/var/lib/apt/lists')) {
  const path = join('/var/lib/apt/lists', filename);
  if (statSync(path).isFile()) copyFileSync(path, join('/build/apt', filename));
}
copyFileSync('/usr/share/keyrings/debian-archive-keyring.gpg', '/build/apt/debian-archive-keyring.gpg');
copyFileSync('/etc/apt/sources.list.d/browser-guest.sources', '/build/apt/browser-guest.sources');
const forbidden = ['pulseaudio', 'pipewire', 'ffmpeg', 'openssh-server', 'sudo', 'npm', 'cron', 'avahi-daemon'];
for (const name of forbidden) if (packages.some(pkg => pkg.name === name)) throw new Error(`Unexpected runtime service/tool: ${name}`);
const inventory = { schema: 'humanish.browser-guest-inventory.v1', architecture: run('/usr/bin/dpkg', ['--print-architecture']).trim(),
  versions: { node: run('/usr/bin/node', ['--version']).trim(), chromium: run('/usr/bin/chromium', ['--version']).trim() }, packages, sources,
  sourceArchiveStatus: 'matching signed metadata retained; source archives must be mirrored and reviewed before redistribution', forbiddenPackagesAbsent: forbidden };
writeFileSync('/build/inventory.json', `${JSON.stringify(inventory, null, 2)}\n`);
mkdirSync('/usr/share/humanish', { recursive: true });
copyFileSync('/build/inventory.json', '/usr/share/humanish/guest-inventory.json');
