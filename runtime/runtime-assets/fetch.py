#!/usr/bin/env python3
"""Fetch only the reviewed development inputs; this is not a runtime importer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
ALLOWED_HOSTS = frozenset(('github.com', 'release-assets.githubusercontent.com',
                          'objects.githubusercontent.com', 'raw.githubusercontent.com',
                          'codeload.github.com', 'cdn.amazonlinux.com'))


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def pins():
    return json.loads((ROOT / 'inputs.json').read_text())


def verify_file(path, expected):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != expected['size']:
        raise ValueError('Input type or size does not match the fixed pin')
    if sha256(path) != expected['sha256']:
        raise ValueError('Input digest does not match the fixed pin')


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError('Input URL is outside the fixed HTTPS origin set')


class PinnedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, deadline):
        self.deadline = deadline

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        if time.monotonic() >= self.deadline:
            raise TimeoutError('Input redirect exceeded its deadline')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(expected, destination):
    validate_url(expected['url'])
    deadline = time.monotonic() + 180
    opener = urllib.request.build_opener(PinnedRedirects(deadline))
    # Existing files, including symlinks, are never replaced.
    with destination.open('xb') as out:
        with opener.open(expected['url'], timeout=30) as response:
            validate_url(response.url)
            total = 0
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Input download exceeded its deadline')
                # read() can internally wait to fill its buffer under a trickle.
                # read1() performs at most one underlying read; the 30s socket
                # inactivity timeout bounds transfer overshoot beyond the deadline.
                chunk = response.read1(min(1024 * 1024, expected['size'] - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > expected['size']:
                    raise ValueError('Input download exceeds its exact bound')
                out.write(chunk)
        out.flush()
        os.fsync(out.fileno())
    verify_file(destination, expected)


def extract_vmm(archive, destination):
    """Extract only known regular members; never invoke downloaded programs here."""
    prefix = 'release-v1.17.0-x86_64/'
    names = ['firecracker-v1.17.0-x86_64', 'jailer-v1.17.0-x86_64',
             'LICENSE', 'NOTICE', 'THIRD-PARTY', 'SHA256SUMS']
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, 'r:gz') as source:
        by_name = {}
        expanded = 0
        for item in source:
            expanded += item.size
            if len(by_name) >= 64 or expanded > 64 * 1024 * 1024:
                raise ValueError('Release archive exceeds its bound')
            if item.name in by_name or not item.isfile():
                raise ValueError('Release archive has duplicate or nonregular members')
            by_name[item.name] = item
        for name in names:
            item = by_name.get(prefix + name)
            if item is None or not 0 < item.size <= 8 * 1024 * 1024:
                raise ValueError('Release member is absent or outside its bound')
            with source.extractfile(item) as data, (destination / name).open('xb') as out:
                remaining = item.size
                while remaining:
                    chunk = data.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('Truncated release member')
                    out.write(chunk)
                    remaining -= len(chunk)
    sums = {}
    for line in (destination / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        if not match:
            raise ValueError('Unexpected upstream checksum line')
        sums[match[2].removeprefix('./')] = match[1]
    for name in names:
        if name == 'SHA256SUMS':
            continue
        if sums.get(name) != sha256(destination / name):
            raise ValueError('Release member checksum mismatch')
        if name.startswith(('firecracker-', 'jailer-')):
            header = (destination / name).read_bytes()[:64]
            if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 62:
                raise ValueError('Release binary is not amd64 ELF')
    return {name: {'size': (destination / name).stat().st_size,
                   'sha256': sha256(destination / name)} for name in names}


def fetch(destination):
    destination.mkdir(mode=0o700)
    inputs = pins()
    try:
        for name, expected in inputs['files'].items():
            download(expected, destination / name)
        sidecar = (destination / 'firecracker-v1.17.0-x86_64.tgz.sha256.txt').read_text()
        if sidecar.split() != [inputs['files']['firecracker-v1.17.0-x86_64.tgz']['sha256'],
                              'firecracker-v1.17.0-x86_64.tgz']:
            raise ValueError('Release checksum sidecar mismatch')
        members = extract_vmm(destination / 'firecracker-v1.17.0-x86_64.tgz', destination / 'vmm')
        manifest = {'schema': 'humanish.browser-boot-download.v1',
                    'qualification': 'development-unqualified', 'inputs': inputs,
                    'vmmMembers': members, 'executed': False, 'vmBooted': False,
                    'redistributionApproved': False}
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    except BaseException:
        (destination / 'FAILED').write_text('Input acquisition failed; partial bytes retained for inspection.\n')
        raise
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = fetch(args.output.absolute())
    print(json.dumps({'status': 'downloaded', 'output': str(args.output.absolute()),
                      'qualification': result['qualification']}))
