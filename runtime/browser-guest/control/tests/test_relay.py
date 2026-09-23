"""Unprivileged finite local-stream tests; these do not qualify AF_VSOCK or PID1."""
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SOURCE = Path(__file__).parents[1] / "root/opt/humanish/control/vsock.py"
spec = importlib.util.spec_from_file_location("guest_relay", SOURCE)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.peer, self.client = socket.socketpair()
        self.read, self.write = os.pipe2(os.O_CLOEXEC)
        self.child = None

    def child_script(self, source):
        self.child = subprocess.Popen([sys.executable, "-I", "-B", "-c", source, str(self.write)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      close_fds=True, pass_fds=(self.write,))
        os.close(self.write)
        self.write = None
        return self.child

    def tearDown(self):
        self.peer.close()
        self.client.close()
        for fd in [self.read, self.write]:
            if fd is not None:
                os.close(fd)
        if self.child:
            self.assertTrue(relay.stop_child(self.child))
            self.assertIsNotNone(self.child.poll())

    def test_spawn_origin_deadline_includes_unresponsive_child_startup(self):
        child = self.child_script("import time;time.sleep(5)")
        with self.assertRaisesRegex(relay.RelayError, "startup_timeout"):
            relay.relay(self.peer, child, self.read, time.monotonic() - 6, lambda: False)

    def test_wrong_or_repeated_marker_is_terminal(self):
        for marker in [b"R", b"AA", b"ARX"]:
            with self.subTest(marker=marker):
                child = self.child_script(f"import os,sys,time;os.write(int(sys.argv[1]),{marker!r});time.sleep(5)")
                with self.assertRaisesRegex(relay.RelayError, "supervision_invalid"):
                    relay.relay(self.peer, child, self.read, time.monotonic(), lambda: False)
                self.assertTrue(relay.stop_child(child))
                os.close(self.read)
                self.read, self.write = os.pipe2(os.O_CLOEXEC)

    def test_private_pipe_eof_before_ready_refuses(self):
        child = self.child_script("import os,sys,time;os.write(int(sys.argv[1]),b'A');os.close(int(sys.argv[1]));time.sleep(5)")
        with self.assertRaisesRegex(relay.RelayError, "supervision_closed"):
            relay.relay(self.peer, child, self.read, time.monotonic(), lambda: False)

    def test_ready_deadline_does_not_renew_on_admission(self):
        child = self.child_script("import os,sys,time;os.write(int(sys.argv[1]),b'A');time.sleep(5)")
        with patch.object(relay, "ADMISSION_SECONDS", 1), patch.object(relay, "READY_SECONDS", 0.08):
            with self.assertRaisesRegex(relay.RelayError, "startup_timeout"):
                relay.relay(self.peer, child, self.read, time.monotonic(), lambda: False)

    def test_revocation_before_dispatch_is_immediate(self):
        child = self.child_script("import time;time.sleep(5)")
        with self.assertRaisesRegex(relay.RelayError, "revoked"):
            relay.relay(self.peer, child, self.read, time.monotonic(), lambda: True)

    def test_bounded_bidirectional_backpressure_and_exact_bytes(self):
        child = self.child_script("""import os,sys
os.write(int(sys.argv[1]),b'AR')
while True:
 data=os.read(0,4096)
 if not data:break
 while data:
  n=os.write(1,data);data=data[n:]
""")
        receipt = []
        errors = []
        def run():
            try:
                receipt.append(relay.relay(self.peer, child, self.read, time.monotonic(), lambda: False))
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        expected = bytes(range(256)) * 4096
        self.client.settimeout(3)
        sender = threading.Thread(target=lambda: self.client.sendall(expected), daemon=True)
        sender.start()
        # Delay the destination so the small relay queues experience backpressure.
        time.sleep(0.1)
        actual = bytearray()
        while len(actual) < len(expected):
            actual.extend(self.client.recv(min(8192, len(expected) - len(actual))))
        sender.join(2)
        self.assertFalse(sender.is_alive())
        self.assertEqual(actual, expected)
        self.client.shutdown(socket.SHUT_RDWR)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(errors)
        self.assertEqual(receipt[0]["reason"], "peer_eof")
        self.assertLessEqual(receipt[0]["peak_in"], relay.QUEUE_BYTES)
        self.assertLessEqual(receipt[0]["peak_out"], relay.QUEUE_BYTES)


if __name__ == "__main__":
    unittest.main()
