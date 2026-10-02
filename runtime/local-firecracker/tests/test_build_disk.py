"""build-disk.py packs a Docker export as a VM's root filesystem.

Docker writes /.dockerenv and /run/.containerenv into an export. Left in the image, they make the
booted VM's systemd treat it as a container, so the assembly script removes them before packing.
"""
import ast
from pathlib import Path
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'build-disk.py').read_text()
PACK_ROOT = 'mke2fs -q -t ext4 -d /rootfs'


def assembly_script():
    """The shell script build-disk.py runs in the tools container: its one string that packs /rootfs."""
    scripts = [
        node.value for node in ast.walk(ast.parse(SOURCE))
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and PACK_ROOT in node.value
    ]
    if len(scripts) != 1:
        raise AssertionError(f'expected one assembly script in build-disk.py, found {len(scripts)}')
    return scripts[0]


class VmRootTests(unittest.TestCase):
    def test_exported_container_identity_markers_are_removed_before_packing(self):
        script = assembly_script()
        cleanup = 'rm -f /rootfs/.dockerenv /rootfs/run/.containerenv'
        self.assertIn(cleanup, script)
        self.assertLess(script.index('tar --numeric-owner -xpf /source.tar -C /rootfs'), script.index(cleanup))
        self.assertLess(script.index(cleanup), script.index(PACK_ROOT))


if __name__ == '__main__':
    unittest.main()
