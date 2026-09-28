"""Expose the requested app and optional participant inbox through fixed vsock ports.

socat forwards opaque TCP bytes: HTTPS, WebSockets and browser origins keep
their ordinary semantics. Internet/media traffic uses the guest NIC separately.
"""
import os
from pathlib import Path
import subprocess
import time

def forwarding_commands(cmdline):
    commands, ports = [], set()
    for name, vsock, required in [("app", 8000, True), ("inbox", 8001, False)]:
        values = [x.split("=", 1)[1] for x in cmdline.split() if x.startswith(f"humanish.{name}_port=")]
        if not values and not required:
            continue
        if len(values) != 1 or not values[0].isdigit() or not 1024 <= int(values[0]) <= 65535:
            raise ValueError(f"Invalid local {name} port")
        port = int(values[0])
        if port in ports:
            raise ValueError("Local app and inbox ports must differ")
        ports.add(port)
        commands.append(["/usr/bin/socat", "-t", "2",
                         f"TCP4-LISTEN:{port},bind=127.0.0.1,reuseaddr,fork", f"VSOCK-CONNECT:2:{vsock}"])
    return commands


if __name__ == "__main__":
    commands = forwarding_commands(Path("/proc/cmdline").read_text())
    if len(commands) == 1:
        os.execv(commands[0][0], commands[0])
    children = []
    try:
        for command in commands:
            children.append(subprocess.Popen(command))
        while all(child.poll() is None for child in children):
            time.sleep(.1)
        raise SystemExit("A local port forward stopped")
    finally:
        for child in children:
            child.terminate()
        # systemd owns the complete process group, including socat connection children.
