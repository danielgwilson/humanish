# A real terminal proof for hidden entry, automatic auth checks and Ink handoff.
# Synthetic credentials only; a child-only fetch preloader prevents real provider calls.
import argparse, datetime, os, pty, subprocess, tempfile, pathlib, select, time, fcntl, termios, struct, json, re, shutil

parser = argparse.ArgumentParser()
parser.add_argument('--cli', default='dist/cli.js')
parser.add_argument('--fixtures', default=str(pathlib.Path(__file__).resolve().parent.parent/'tests/fixtures/agentmail-receiving'))
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
fixture_dir = pathlib.Path(args.fixtures).resolve()
for name in ['auth.json', 'auth-rejected.json']:
    shutil.copyfile(fixture_dir/name, root/name)
request_log = root/'auth-requests.ndjson'
preloader = root/'auth-fetch-preloader.mjs'
preloader.write_text('''import { appendFileSync, readFileSync } from 'node:fs';
const accepted = JSON.parse(readFileSync(process.env.HUMANISH_TUI_AUTH_ACCEPTED, 'utf8'));
const rejected = JSON.parse(readFileSync(process.env.HUMANISH_TUI_AUTH_REJECTED, 'utf8'));
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  // Ink's bundled Yoga loads its inlined WASM through a data URI (no network).
  if (url.href.startsWith('data:application/octet-stream;base64,') && method === 'GET') {
    appendFileSync(process.env.HUMANISH_TUI_AUTH_LOG, JSON.stringify({ operation: 'local-wasm' }) + '\\n');
    return localFetch(input, init);
  }
  if (url.href !== 'https://api.agentmail.to/v0/auth/me' || method !== 'GET') {
    // The normal TUI probes its loopback Observer port. Keep the entire fixture offline.
    const operation = url.hostname === '127.0.0.1' && method === 'GET' ? 'blocked-loopback-probe' : 'blocked-unexpected-fetch';
    appendFileSync(process.env.HUMANISH_TUI_AUTH_LOG, JSON.stringify({ operation }) + '\\n');
    throw new Error('This proof forbids all non-authentication fetches.');
  }
  const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
  const known = authorization === 'Bearer ' + process.env.HUMANISH_TUI_FIRST_CANARY ? 'first'
    : authorization === 'Bearer ' + process.env.HUMANISH_TUI_SECOND_CANARY ? 'replacement' : 'unexpected';
  appendFileSync(process.env.HUMANISH_TUI_AUTH_LOG, JSON.stringify({ operation: 'auth', credential: known, status: known === 'first' ? accepted.status : rejected.status }) + '\\n');
  const fixture = known === 'first' ? accepted : rejected;
  return new Response(JSON.stringify(fixture.body), { status: fixture.status, headers: { 'content-type': 'application/json' } });
};
''')
env.update(NODE_OPTIONS='--import='+preloader.as_uri(), HUMANISH_TUI_AUTH_ACCEPTED=str(root/'auth.json'),
           HUMANISH_TUI_AUTH_REJECTED=str(root/'auth-rejected.json'), HUMANISH_TUI_AUTH_LOG=str(request_log),
           HUMANISH_TUI_FIRST_CANARY=canary, HUMANISH_TUI_SECOND_CANARY=replacement)
logs = []
receipts = []

def requests():
    return [json.loads(line) for line in request_log.read_text().splitlines()] if request_log.exists() else []

def auth_requests():
    return [request for request in requests() if request['operation'] == 'auth']

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
        t.send(b'\x1b[200~'+canary.encode()+b'\x1b[201~\r', 'Provider authentication: passed')
        t.wait('present')
        key_path = root/'user-config/humanish/keys.env'
        assert key_path.read_text() == 'AGENTMAIL_API_KEY='+canary+'\n'
        assert key_path.stat().st_mode & 0o777 == 0o600
        assert canary not in (root/'.humanish/local/comms.yaml').read_text()
        assert auth_requests() == [{'operation':'auth','credential':'first','status':200}]
        receipts.append('fresh key and profile saved; hidden bracketed paste; user store mode 0600')
        receipts.append('key entry automatically checks authentication exactly once using captured fixture shape')
        t.send(b'\r', 'AgentMail API key (input hidden; Ctrl+C cancels):')
        mark = t.send(b'synthetic-cancelled-entry\x03', 'Key entry cancelled.')
        t.wait('Replace stored key', mark)
        assert key_path.read_text() == 'AGENTMAIL_API_KEY='+canary+'\n'
        assert len(auth_requests()) == 1
        receipts.append('cancel returns to TUI and preserves previous key')
        t.send(b'\r', 'AgentMail API key (input hidden; Ctrl+C cancels):')
        t.send(replacement.encode()+b'\r', 'Provider authentication: rejected')
        assert key_path.read_text() == 'AGENTMAIL_API_KEY='+replacement+'\n'
        assert auth_requests()[-1] == {'operation':'auth','credential':'replacement','status':403}
        assert len(auth_requests()) == 2
        receipts.append('replacement persists and remounts Connections')
        receipts.append('rejected authentication stays distinct from storage; replacement key is retained')
        t.send(b'\x1b[B', '❯ Test authentication')
        t.send(b'\r', 'Authentication: rejected')
        t.wait('permissions: unknown')
        assert len(auth_requests()) == 3
        t.send(b'\x1b', 'Provider authentication: rejected')
        t.send(b'\x1b', 'c connections')
        os.write(t.master, b'q')
        assert t.process.wait(timeout=5) == 0
    finally: t.close()
    t = Terminal(45)
    try:
        t.wait('c connections')
        t.send(b'c', 'Replace stored key')
        t.wait('saved key')
        t.wait('Provider authentication: not checked')
        assert len(auth_requests()) == 3
        t.send(b'\x1b[B', '❯ Test authentication')
        t.send(b'\r', 'Authentication: rejected')
        assert len(auth_requests()) == 4
        os.write(t.master,b'q')
        assert t.process.wait(timeout=5)==0
        receipts.append('45-column fresh process resolves saved key and connection')
        receipts.append('opening Connections is offline; explicit authentication checks work after restart')
    finally: t.close()
    for log in logs:
        assert canary.encode() not in log and replacement.encode() not in log and b'synthetic-cancelled-entry' not in log
    receipts.append('no credential canary in any terminal output')
    assert all(request['operation'] in ['blocked-loopback-probe','local-wasm'] or request['operation'] == 'auth' and request['credential'] != 'unexpected' for request in requests())
    result = {'ok':True,'checks':receipts,'mockedAuthRequests':auth_requests(),
              'blockedLocalProbes':sum(request['operation']=='blocked-loopback-probe' for request in requests()),
              'localWasmLoads':sum(request['operation']=='local-wasm' for request in requests()),'realProviderCalls':0}
    (proof/'pty-result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
except Exception:
    (proof/'pty-failure.txt').write_bytes(b'\n'.join(logs))
    (proof/'request-log.json').write_text(json.dumps(requests(),indent=2)+'\n')
    raise
finally:
    shutil.rmtree(root)
