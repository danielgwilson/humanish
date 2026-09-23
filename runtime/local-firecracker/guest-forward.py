"""Expose the requested localhost app through a fixed host vsock port.

socat forwards opaque TCP bytes: HTTPS, WebSockets and browser origins keep
their ordinary semantics. Internet/media traffic uses the guest NIC separately.
"""
import os
from pathlib import Path

values = [x.split("=", 1)[1] for x in Path("/proc/cmdline").read_text().split()
          if x.startswith("humanish.app_port=")]
if len(values) != 1 or not values[0].isdigit() or not 1024 <= int(values[0]) <= 65535:
    raise SystemExit("Missing local application port")
os.execv("/usr/bin/socat", ["socat", "-t", "2",
         f"TCP4-LISTEN:{values[0]},bind=127.0.0.1,reuseaddr,fork", "VSOCK-CONNECT:2:8000"])
