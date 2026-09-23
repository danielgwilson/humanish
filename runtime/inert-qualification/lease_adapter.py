"""Fixture-only adapter to the exact staged broker core; no alternate TTL model."""
import json
from pathlib import Path
import secrets
import time
from broker.leases import BrokerCore, ClockSample, Policy
from broker.protocol import BrokerError, strict_json


def clock():
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip().replace('-', '')
    return ClockSample(boot, time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000)


class Lease:
    def __init__(self, role, sample=None):
        if role not in ('as', 'bs'):
            raise ValueError('invalid_supervisor')
        now = sample or clock()
        cap = 60_000 if role == 'as' else 180_000
        self.core = BrokerCore(policy=Policy(authorized_uids=frozenset({0}),
            startup_cap_ms=cap, study_cap_ms=cap), installation=secrets.token_hex(16), clock=now)
        decision = self.core.handle(json.dumps({'version': 1, 'operation': 'acquire',
            'attempt': secrets.token_hex(16)}).encode(), peer_uid=0, clock=now)
        self.study = decision.reply['study']
        self.__capability = decision.capability
        self.view = decision.reply
        self.last_valid_ms = now.boottime_ms

    def activate(self, sample=None):
        self.view = self.core.activate(self.study, clock=sample or clock())

    def advance(self, sample=None):
        now = sample or clock()
        self.core.advance(now)
        # inspect itself also advances, and may refuse reconciliation. Such a
        # refusal terminates the supervisor rather than reviving a generation.
        self.view = self.core.handle(json.dumps({'version': 1, 'operation': 'inspect',
            'study': self.study, 'capability': self.__capability.reveal()}).encode(),
            peer_uid=0, clock=now).reply
        return self.view['state'] in ('startup', 'active')

    def renew(self, data, peer_uid, sample=None):
        now = sample or clock()
        request = strict_json(data, limit=1024, depth=1, code="invalid_request")
        if peer_uid != 0 or type(request) is not dict or set(request) != {'version', 'generation', 'sequence'} or \
                type(request['version']) is not int or request['version'] != 1 or request['generation'] != self.study:
            raise ValueError('invalid_renewal')
        result = self.core.handle(json.dumps({'version': 1, 'operation': 'renew',
            'study': self.study, 'capability': self.__capability.reveal(),
            'sequence': request['sequence']}).encode(), peer_uid=peer_uid, clock=now)
        self.view = result.reply
        self.last_valid_ms = now.boottime_ms

    def finish(self, data):
        request = strict_json(data, limit=1024, depth=1, code="invalid_request")
        if request != {'version': 1, 'generation': self.study, 'operation': 'finish'} or type(request['version']) is not int:
            raise ValueError('invalid_finish')
        self.core.revoke(self.study, clock=clock())

    def status(self):
        return {**self.view, 'last_valid_ms': self.last_valid_ms}
