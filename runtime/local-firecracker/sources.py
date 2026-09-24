#!/usr/bin/env python3
"""Retain matching Debian/kernel/VMM sources and notices for a runtime release."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from urllib.request import urlopen


def records(text):
    for paragraph in text.split("\n\n"):
        fields, key = {}, None
        for line in paragraph.splitlines():
            if line.startswith(" ") and key:
                fields[key] += "\n" + line.strip()
            elif ":" in line:
                key, value = line.split(":", 1)
                fields[key] = value.strip()
        if fields:
            yield fields


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path, required=True)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--boot-inputs", type=Path, required=True)
    parser.add_argument("--kernel-build", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / "debian").mkdir()
    inventory = json.loads((args.browser / "provenance/inventory.json").read_text())
    pins = json.loads((args.browser / "manifest.json").read_text())["inputs"]
    wanted = {(item["name"], item["version"]) for item in inventory["sources"]}
    installed = subprocess.check_output(["docker", "run", "--rm", "--network", "none", "--entrypoint", "dpkg-query",
        args.runtime_image, "-W", "-f=${source:Package}\t${source:Version}\n"], text=True)
    wanted.update(tuple(line.split("\t")) for line in installed.strip().splitlines())
    matched = {}
    apt = (args.browser / "provenance/apt").resolve()
    for index in sorted(apt.glob("*Sources.lz4")):
        text = subprocess.check_output(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/usr/lib/apt/apt-helper",
            "--mount", f"type=bind,src={apt},dst=/apt,readonly", args.runtime_image, "cat-file", "/apt/" + index.name], text=True)
        security = "debian-security" in index.name
        origin = "https://snapshot.debian.org/archive/" + ("debian-security/" + pins["securitySnapshot"] if security else "debian/" + pins["debianSnapshot"])
        for entry in records(text):
            key = (entry.get("Package"), entry.get("Version"))
            if key in wanted:
                matched[key] = (entry, origin)
    missing = wanted - matched.keys()
    if missing:
        raise RuntimeError("Matching source metadata missing: " + str(sorted(missing)))
    files = {}
    for (name, version), (entry, origin) in sorted(matched.items()):
        for row in entry["Checksums-Sha256"].strip().splitlines():
            digest, size, filename = row.split()
            relative = "debian/" + filename
            record = {"package": name, "version": version, "file": relative, "sha256": digest, "bytes": int(size),
                      "url": origin + "/" + entry["Directory"] + "/" + filename}
            if relative in files and files[relative]["sha256"] != digest:
                raise RuntimeError("Conflicting source filenames")
            files[relative] = record

    def fetch(record):
        destination = output / record["file"]
        for attempt in range(3):
            try:
                digest, size = hashlib.sha256(), 0
                with urlopen(record["url"], timeout=60) as source, destination.open("wb") as target:
                    while chunk := source.read(1024 * 1024):
                        size += len(chunk)
                        if size > record["bytes"]:
                            raise RuntimeError("Source exceeds expected size")
                        digest.update(chunk)
                        target.write(chunk)
                if size != record["bytes"] or digest.hexdigest() != record["sha256"]:
                    raise RuntimeError("Source checksum mismatch")
                return
            except Exception:
                destination.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)

    print(f"Retaining {len(files)} source files for {len(wanted)} Debian sources", flush=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(fetch, files.values()))
    shutil.copytree(args.browser / "provenance/notices", output / "guest-notices")
    container = subprocess.check_output(["docker", "create", args.runtime_image], text=True).strip()
    try:
        subprocess.run(["docker", "cp", container + ":/usr/share/doc", str(output / "runner-notices")], check=True)
    finally:
        subprocess.run(["docker", "rm", container], check=True)
    (output / "boot").mkdir()
    for source in args.boot_inputs.iterdir():
        if source.name.endswith(".src.rpm") or source.name.startswith("firecracker-source-"):
            shutil.copy2(source, output / "boot" / source.name)
    for name in ["LICENSE", "NOTICE", "THIRD-PARTY"]:
        shutil.copy2(args.boot_inputs / "vmm" / name, output / "boot" / ("firecracker-" + name))
    for name in ["kernel.config", "COPYING"]:
        shutil.copy2(args.kernel_build / "output" / name, output / "boot" / name)
    shutil.copytree(args.kernel_build / "output/LICENSES", output / "boot/LICENSES")
    (output / "debian-sources.json").write_text(json.dumps(list(files.values()), indent=2) + "\n")
    print("Sources and notices retained", flush=True)


if __name__ == "__main__":
    main()
