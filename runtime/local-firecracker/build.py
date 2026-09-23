#!/usr/bin/env python3
"""Assemble development assets using the maintained source and image recipes."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        parser.error("This development builder currently supports Linux amd64.")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)

    def run(name, *command):
        print(name, flush=True)
        with (output / (name + ".log")).open("w") as log:
            subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)

    def read(relative):
        return json.loads((output / relative).read_text())

    tag = uuid.uuid4().hex
    runner, guest = "humanish-firecracker-runner:" + tag, "humanish-firecracker-guest:" + tag
    run("inputs", "python3", "runtime/runtime-assets/fetch.py", "--output", str(output / "inputs"))
    # The fetcher verifies bytes without granting execution; the runtime opts in.
    (output / "inputs/vmm/firecracker-v1.17.0-x86_64").chmod(0o755)
    run("kernel", "python3", "runtime/browser-kernel/build.py", "--inputs", str(output / "inputs"),
        "--output", str(output / "kernel"), "--jobs", "8")
    run("browser", "python3", "runtime/browser-guest/build.py", "--architecture", "amd64", "--output", str(output / "browser"))
    run("payload", "node", "scripts/guest-runtime-package.mjs", str(output / "payload"))
    base = json.loads((ROOT / "runtime/browser-guest/inputs.json").read_text())["platforms"]["amd64"]["base"]
    run("runner", "docker", "build", "--build-arg", "BASE_IMAGE=" + base,
        "-f", "runtime/local-firecracker/Containerfile", "-t", runner, "runtime/local-firecracker")
    run("guest", "docker", "build", "--build-arg", "BROWSER_IMAGE=" + read("browser/manifest.json")["image"]["localTag"],
        "--build-context", "payload=" + str(output / "payload"), "-f", "runtime/local-firecracker/Guest.Containerfile",
        "-t", guest, "runtime/local-firecracker")
    run("disks", "python3", "runtime/local-firecracker/build-disk.py", "--guest-image", guest,
        "--tools-image", runner, "--output", str(output / "disks"))
    assets = {"firecracker": str(output / "inputs/vmm/firecracker-v1.17.0-x86_64"),
              "kernel": str(output / "kernel/output/kernel.bin"), "rootfs": str(output / "disks/root.ext4"),
              "stateTemplate": str(output / "disks/state.ext4"),
              "runtimeRevision": read("payload/manifest.json")["runtimeRevision"], "runnerImage": runner}
    manifest = output / "assets.json"
    manifest.write_text(json.dumps(assets, indent=2) + "\n")
    print("Assets: " + str(manifest))


if __name__ == "__main__":
    main()
