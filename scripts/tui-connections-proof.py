# A real terminal proof for hidden entry and Ink handoff. Synthetic credentials only.
import argparse, datetime, os, pty, subprocess, tempfile, pathlib, select, time, fcntl, termios, struct, json, re, shutil

parser = argparse.ArgumentParser()
parser.add_argument('--cli', default='dist/cli.js')
args = parser.parse_args()
cli = str(pathlib.Path(args.cli).resolve())
proof = pathlib.Path('.humanish/proof/tui-connections') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
proof.mkdir(parents=True, exist_ok=False)
root = pathlib.Path(tempfile.mkdtemp(prefix='humanish-key-pty-'))
env = dict(os.environ)
for name in ['OPENAI_API_KEY', 'E2B_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']:
    env[name] = ''
env.pop('AGENTMAIL_API_KEY', None)
env.update(XDG_CONFIG_HOME=str(root/'user-config'), HUMANISH_STRICT_KEYS='0', HUMANISH_TELEMETRY_DISABLED='1', DO_NOT_TRACK='1', TERM='xterm-256color')
canary = 'synthetic-pty-secret-canary-one'
replacement = 'synthetic-pty-secret-canary-two'
logs = []
receipts = []

class Terminal:
    def __init__(self, columns=80):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, columns, 0, 0))
        self.process = subprocess.Popen(['node', cli, 'tui', '--cwd', str(root), '--force'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        self.log = b''
    def wait(self, text, start=0):
        deadline = time.monotonic()+12
        while time.monotonic()<deadline:
            clean = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', self.log[start:].decode('utf8',errors='replace'))
            if text in re.sub(r'\s+', ' ', clean): return
            ready,_,_ = select.select([self.master], [], [], .1)
            if ready:
                try: self.log += os.read(self.master, 65536)
                except OSError: break
        raise AssertionError('terminal did not reach '+text)
    def send(self, data, expect):
        mark = len(self.log)
        os.write(self.master, data)
        self.wait(expect, mark)
        return mark
    def close(self):
        if self.process.poll() is None: self.process.terminate()
        try: self.process.wait(timeout=5)
        except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
        os.close(self.master)
        logs.append(self.log)

try:
    t = Terminal()
    try:
        t.wait('c connections')
        t.send(b'c', 'Add API key')
        t.send(b'\r', 'AgentMail API key (input hidden; Ctrl+C cancels):')
        t.send(b'\x1b[200~'+canary.encode()+b'\x1b[201~\r', 'Project connection saved.')
        t.wait('present')
        key_path = root/'user-config/humanish/keys.env'
        assert key_path.read_text() == 'AGENTMAIL_API_KEY='+canary+'\n'
        assert key_path.stat().st_mode & 0o777 == 0o600
        assert canary not in (root/'.humanish/local/comms.yaml').read_text()
        receipts.append('fresh key and profile saved; hidden bracketed paste; user store mode 0600')
        t.send(b'\r', 'AgentMail API key (input hidden; Ctrl+C cancels):')
        mark = t.send(b'synthetic-cancelled-entry\x03', 'Key entry cancelled.')
        t.wait('Replace stored key', mark)
        assert key_path.read_text() == 'AGENTMAIL_API_KEY='+canary+'\n'
        receipts.append('cancel returns to TUI and preserves previous key')
        t.send(b'\r', 'AgentMail API key (input hidden; Ctrl+C cancels):')
        t.send(replacement.encode()+b'\r', 'Project connection saved.')
        assert key_path.read_text() == 'AGENTMAIL_API_KEY='+replacement+'\n'
        receipts.append('replacement persists and remounts Connections')
        t.send(b'\x1b', 'c connections')
        os.write(t.master, b'q')
        assert t.process.wait(timeout=5) == 0
    finally: t.close()
    t = Terminal(45)
    try:
        t.wait('c connections')
        t.send(b'c', 'Replace stored key')
        t.wait('saved key')
        os.write(t.master,b'q')
        assert t.process.wait(timeout=5)==0
        receipts.append('45-column fresh process resolves saved key and connection')
    finally: t.close()
    for log in logs:
        assert canary.encode() not in log and replacement.encode() not in log and b'synthetic-cancelled-entry' not in log
    receipts.append('no credential canary in any terminal output')
    (proof/'pty-result.json').write_text(json.dumps({'ok':True,'checks':receipts},indent=2)+'\n')
    print(json.dumps({'ok':True,'checks':receipts}))
except Exception:
    (proof/'pty-failure.txt').write_bytes(b'\n'.join(logs))
    raise
finally:
    shutil.rmtree(root)
