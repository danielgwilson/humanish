#!/usr/bin/env python3
"""Rehash two retained builds and report the exact repeat-build comparison."""
import argparse
import hashlib
import json
from pathlib import Path

COMPILATION_RECIPES = ('Containerfile', 'packages.list', 'build_inside.py',
                       'policy.json', 'toolchain.json', 'inputs.json')


def compare(first, second):
    receipts = []
    actual_outputs = []
    for directory in (first, second):
        receipt = json.loads((directory / 'manifest.json').read_text())
        if receipt['schema'] != 'humanish.browser-kernel-build-receipt.v1':
            raise ValueError('Unexpected build receipt')
        if json.loads((directory / 'cleanup.json').read_text())['confirmed'] is not True:
            raise ValueError('Both builds must have confirmed owned cleanup')
        observed = {}
        for name, declared in receipt['result']['outputs'].items():
            if name not in ('kernel.bin', 'bzImage', 'kernel.config', 'System.map', 'COPYING'):
                raise ValueError('Unexpected build output')
            file = directory / 'output' / name
            if file.is_symlink() or not file.is_file():
                raise ValueError('Output is not a regular file')
            with file.open('rb') as data:
                observed[name] = {'size': file.stat().st_size,
                                  'sha256': hashlib.file_digest(data, 'sha256').hexdigest()}
            if observed[name] != declared:
                raise ValueError('Retained output changed after build')
        if set(observed) != {'kernel.bin', 'bzImage', 'kernel.config', 'System.map', 'COPYING'}:
            raise ValueError('Incomplete build outputs')
        for name, declared in receipt['recipeHashes'].items():
            if Path(name).name != name:
                raise ValueError('Unexpected recipe path')
            with (directory / 'recipe' / name).open('rb') as data:
                if hashlib.file_digest(data, 'sha256').hexdigest() != declared:
                    raise ValueError('Retained recipe changed after build')
        receipts.append(receipt)
        actual_outputs.append(observed)
    left, right = receipts
    differences = {name: [left['recipeHashes'].get(name), right['recipeHashes'].get(name)]
                   for name in sorted(left['recipeHashes'].keys() | right['recipeHashes'].keys())
                   if left['recipeHashes'].get(name) != right['recipeHashes'].get(name)}
    same_inputs = (left['inputs'] == right['inputs']
                   and left['toolchainImage'] == right['toolchainImage']
                   and left['result']['buildEnvironment'] == right['result']['buildEnvironment']
                   and all(left['recipeHashes'][name] == right['recipeHashes'][name]
                           for name in COMPILATION_RECIPES))
    return {'schema': 'humanish.browser-kernel-repeat.v1',
            'sameCompilationInputs': same_inputs,
            'sameKernelOutputs': actual_outputs[0] == actual_outputs[1],
            'identicalFullRecipe': not differences, 'recipeDifferences': differences,
            'outputs': actual_outputs, 'vmBooted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('first', type=Path)
    parser.add_argument('second', type=Path)
    args = parser.parse_args()
    result = compare(args.first, args.second)
    print(json.dumps(result, indent=2))
    if not result['sameCompilationInputs'] or not result['sameKernelOutputs']:
        raise SystemExit(1)
