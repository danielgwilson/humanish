"""Development image assembly using Docker export and the standard ext4 tools."""
import argparse
from pathlib import Path
import subprocess
import tempfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--guest-image", required=True)
    parser.add_argument("--tools-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    source = tools = None
    try:
        source = docker("create", args.guest_image)
        with tempfile.TemporaryDirectory(prefix="humanish-rootfs-") as scratch:
            archive = Path(scratch) / "rootfs.tar"
            subprocess.run(["docker", "export", "--output", str(archive), source], check=True)
            tools = docker("create", "--network", "none", "--memory", "2g", "--pids-limit", "64",
                           "--entrypoint", "sh", args.tools_image, "-ec", """
mkdir /rootfs
tar --numeric-owner -xpf /source.tar -C /rootfs
# Docker export markers do not describe the VM that will boot this filesystem.
rm -f /rootfs/.dockerenv /rootfs/run/.containerenv
rm -f /rootfs/etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /rootfs/etc/resolv.conf
truncate -s 3G /root.ext4
mke2fs -q -t ext4 -d /rootfs /root.ext4
mkdir /state
chown 1000:1000 /state
chmod 700 /state
truncate -s 512M /state.ext4
mke2fs -q -t ext4 -d /state /state.ext4
debugfs -w -R 'set_inode_field / uid 1000' /state.ext4
debugfs -w -R 'set_inode_field / gid 1000' /state.ext4
debugfs -w -R 'set_inode_field / mode 040700' /state.ext4
""")
            subprocess.run(["docker", "cp", str(archive), f"{tools}:/source.tar"], check=True)
            subprocess.run(["docker", "start", "--attach", tools], check=True)
            if docker("inspect", "--format", "{{.State.ExitCode}}", tools) != "0":
                raise RuntimeError("Disk assembly failed")
            for name in ["root.ext4", "state.ext4"]:
                subprocess.run(["docker", "cp", f"{tools}:/{name}", str(args.output / name)], check=True)
    finally:
        for resource in [tools, source]:
            if resource:
                subprocess.run(["docker", "rm", "--force", resource], check=True)


if __name__ == "__main__":
    main()
