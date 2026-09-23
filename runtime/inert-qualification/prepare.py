"""Unprivileged source bundle builder. Never registers or starts services."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packet import FILES


def prepare(destination):
    if os.geteuid() == 0:
        raise RuntimeError('prepare_requires_unprivileged_user')
    here = Path(__file__).resolve().parent
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    (destination / 'broker').mkdir(mode=0o700)
    manifest = {'version': 1, 'files': {}}
    for name in FILES:
        source = here.parent / name if name.startswith('broker/') else here / name
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError('unsafe_source')
        data = source.read_bytes()
        (destination / name).write_bytes(data)
        manifest['files'][name] = hashlib.sha256(data).hexdigest()
    data = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    (destination / 'manifest.json').write_bytes(data)
    print(json.dumps({'source': str(destination.absolute()), 'manifest_sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    prepare(parser.parse_args().destination)
