#!/usr/bin/env python3
"""Fetch the fixed optional media sources and model without executing them."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
ALLOWED_HOSTS = frozenset({
    'github.com', 'codeload.github.com', 'huggingface.co',
    'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'cas-bridge.xethub.hf.co'
})


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(path, expected):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != expected['size'] or sha256(path) != expected['sha256']:
        raise ValueError('Media input does not match its fixed pin')


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Media input URL is outside the fixed HTTPS origin set')


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, deadline): self.deadline = deadline
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        if time.monotonic() >= self.deadline: raise TimeoutError('Media input redirect exceeded its deadline')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(expected, destination):
    validate_url(expected['url'])
    deadline = time.monotonic() + 300
    opener = urllib.request.build_opener(Redirects(deadline))
    with destination.open('xb') as output:
        with opener.open(expected['url'], timeout=30) as response:
            validate_url(response.url)
            total = 0
            while True:
                if time.monotonic() >= deadline: raise TimeoutError('Media input download exceeded its deadline')
                chunk = response.read1(min(1024 * 1024, expected['size'] - total + 1))
                if not chunk: break
                total += len(chunk)
                if total > expected['size']: raise ValueError('Media input exceeds its exact bound')
                output.write(chunk)
        output.flush(); os.fsync(output.fileno())
    verify(destination, expected)


def fetch(destination):
    destination.mkdir(mode=0o700)
    inputs = json.loads((ROOT / 'inputs.json').read_text())
    try:
        for name, expected in inputs['files'].items():
            if not re.fullmatch(r'[a-f0-9]{64}', expected.get('sha256', '')) or not isinstance(expected.get('size'), int):
                raise ValueError('Invalid media input pin')
            download(expected, destination / name)
        manifest = {'schema': 'humanish.browser-media-download.v1', 'inputs': inputs,
                    'executed': False, 'redistributionApproved': False}
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        return manifest
    except BaseException:
        (destination / 'FAILED').write_text('Media input acquisition failed; partial bytes retained.\n')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    fetch(args.output.absolute())
    print(json.dumps({'status': 'downloaded', 'output': str(args.output.absolute())}))
