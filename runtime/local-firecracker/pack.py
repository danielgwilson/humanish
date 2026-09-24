#!/usr/bin/env python3
"""Package prepared browser assets as one Docker image; no study credentials included."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assets = json.loads(args.assets.read_text())
    recipe = Path(__file__).resolve().parent
    command = ["docker", "build", "-f", str(recipe / "Runtime.Containerfile"), "-t", args.tag,
               "--build-arg", "RUNNER_IMAGE=" + assets["runnerImage"],
               "--build-arg", "RUNTIME_REVISION=" + assets["runtimeRevision"]]
    for key, context, argument in [("firecracker", "vmm", "VMM_FILE"), ("kernel", "kernel", "KERNEL_FILE"),
                                   ("rootfs", "disks", "ROOT_FILE"), ("stateTemplate", "state", "STATE_FILE")]:
        source = Path(assets[key]).resolve(strict=True)
        command += ["--build-context", context + "=" + str(source.parent),
                    "--build-arg", argument + "=" + source.name]
    subprocess.run([*command, str(recipe)], check=True)
    image = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", args.tag], text=True).strip()
    args.output.write_text(json.dumps({"image": image, "runtimeRevision": assets["runtimeRevision"]}, indent=2) + "\n")


if __name__ == "__main__":
    main()
