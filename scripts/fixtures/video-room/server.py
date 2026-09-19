"""Disposable synthetic two-peer room. No files, credentials or account data are served."""
import argparse
import json
import pathlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8765)
parser.add_argument('--room', required=True)
parser.add_argument('--bind', default='127.0.0.1')
args = parser.parse_args()
prefix = '/room/' + args.room + '/'
html = pathlib.Path(__file__).with_name('room.html').read_bytes()
lock = threading.Lock()
messages = {'participant': [], 'peer': []}
proof = {'events': [], 'samples': []}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def reply(self, code, value, content_type='application/json'):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == prefix:
            return self.reply(200, html, 'text/html; charset=utf-8')
        if parsed.path == prefix + 'proof':
            with lock:
                return self.reply(200, proof)
        if parsed.path == prefix + 'signal':
            query = parse_qs(parsed.query)
            role = query.get('role', [''])[0]
            if role not in messages:
                return self.reply(400, {'error': 'unknown role'})
            try:
                offset = max(0, int(query.get('after', ['0'])[0]))
            except ValueError:
                return self.reply(400, {'error': 'invalid offset'})
            with lock:
                return self.reply(200, {'messages': messages[role][offset:], 'offset': len(messages[role])})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in [prefix + 'signal', prefix + 'event', prefix + 'sample']:
            return self.reply(404, {'error': 'not found'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 262144:
                return self.reply(413, {'error': 'invalid body size'})
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict) or value.get('role') not in messages:
                return self.reply(400, {'error': 'invalid role'})
        except (ValueError, json.JSONDecodeError):
            return self.reply(400, {'error': 'invalid body'})
        with lock:
            if parsed.path.endswith('/signal'):
                target = 'peer' if value['role'] == 'participant' else 'participant'
                if len(messages[target]) >= 1000:
                    return self.reply(429, {'error': 'signal limit'})
                messages[target].append(value['message'])
            else:
                key = 'events' if parsed.path.endswith('/event') else 'samples'
                if len(proof[key]) >= 3600:
                    return self.reply(429, {'error': 'proof limit'})
                proof[key].append({**value, 'receivedAtMs': round(time.time() * 1000)})
        self.reply(200, {'ok': True})

ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
