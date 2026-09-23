#!/usr/bin/env python3
"""Compare two accepted development assemblies without claiming deterministic disks."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import verify_output
from inputs import read_json, sha256


def compare(first, second):
    manifests = []
    outputs = []
    for directory in (first, second):
        manifest = read_json(directory / 'manifest.json')
        if (manifest.get('schema') != 'humanish.browser-disk-build.v1' or
            manifest.get('cleanup', {}).get('confirmed') is not True or
            read_json(directory / 'cleanup.json').get('confirmed') is not True or
            (directory / 'FAILED.json').exists()):
            raise ValueError('Incomplete or failed assembly cannot be compared as accepted')
        report = verify_output(directory / 'output', manifest['assembly']['request'])
        if report != manifest['assembly']:
            raise ValueError('Build manifest differs from actual output')
        manifests.append(manifest)
        outputs.append(report)
    left, right = manifests
    if (left['recipeFiles'] != right['recipeFiles'] or left['runtimeRevision'] != right['runtimeRevision'] or
        left['toolsImage']['id'] != right['toolsImage']['id'] or outputs[0]['request'] != outputs[1]['request'] or
        outputs[0]['inventorySha256'] != outputs[1]['inventorySha256']):
        raise ValueError('Different immutable inputs or semantic filesystem contents')
    rows = {}
    for name in ('rootfs.ext4', 'state-template.ext4'):
        a, b = (output['disks'][name] for output in outputs)
        fields = sorted(set(a['superblock']) | set(b['superblock']))
        changes = {key: [a['superblock'].get(key), b['superblock'].get(key)] for key in fields
                   if a['superblock'].get(key) != b['superblock'].get(key)}
        if any(a[key] != b[key] for key in ('policy', 'features', 'bytes', 'freeBytes', 'freeInodes', 'verifiedEntries')):
            raise ValueError('Different filesystem geometry or headroom')
        rows[name] = {'sha256': [a['sha256'], b['sha256']], 'byteIdentical': a['sha256'] == b['sha256'],
                      'changedSuperblockFields': changes, 'verifiedEntries': a['verifiedEntries']}
    return {'schema': 'humanish.browser-disk-repeat.v1', 'runtimeRevision': left['runtimeRevision'],
            'manifests': [sha256(directory / 'manifest.json') for directory in (first, second)],
            'sameDeclaredInputs': True, 'sameContentsModesOwnersAndLinks': True, 'disks': rows,
            'byteReproducible': all(row['byteIdentical'] for row in rows.values()),
            'qualification': 'Observed superblock differences are retained; inode timestamps and checksums are not normalized. No claim that these explain every differing byte.',
            'vmBooted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('first', type=Path)
    parser.add_argument('second', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(compare(arguments.first, arguments.second), indent=2))
