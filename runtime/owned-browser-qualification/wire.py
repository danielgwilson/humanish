"""Bounded local fixture records and one fixed root-only lease socket."""
import os
from pathlib import Path
import socket
import struct
import time
from files import Deadline, unique_json
from policy import Refusal, encode, names


def notify(value):
    address = os.environ.get('NOTIFY_SOCKET', '')
    if not address or value not in ('READY=1', 'WATCHDOG=1'):
        raise Refusal('notify_refused')
    if address.startswith('@'):
        address = '\0' + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.settimeout(1)
        channel.sendto(value.encode(), address)


def runtime(value, role):
    return Path('/run') / names(value)[role].removesuffix('.service')


def atomic(directory, name, value):
    if name not in ('status', 'progress', 'leader', 'worker', 'result'):
        raise Refusal('record_refused')
    data = encode(value)
    if len(data) > 65536:
        raise Refusal('record_oversized')
    temporary = directory / (name + '.next')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        if os.write(fd, data) != len(data):
            raise Refusal('record_short_write')
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, directory / (name + '.json'))


def read_record(directory, name):
    if name not in ('status', 'progress', 'leader', 'worker', 'result'):
        raise Refusal('record_refused')
    from files import anchored, read_at
    with anchored(directory) as fd:
        return unique_json(read_at(fd, name + '.json', 65536))


def peer(channel):
    return struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))


class LeaseChannel:
    def __init__(self, value, role, deadline):
        self.channel = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.channel.settimeout(deadline.remaining())
        self.channel.connect(str(runtime(value, role) / 'lease.sock'))
        self.status = self.receive()
        self.study = self.status['study']
        self.sequence = 0

    def receive(self):
        return unique_json(self.channel.recv(4097), maximum=4096)

    def request(self, **value):
        self.channel.sendall(encode({'study': self.study, **value}))
        result = self.receive()
        if result.get('accepted') is not True:
            raise Refusal('lease_request_refused')
        self.status = result['status']
        return self.status

    def renew(self, sequence):
        if type(sequence) is not int or sequence <= self.sequence:
            raise Refusal('invalid_sequence')
        result = self.request(sequence=sequence)
        self.sequence = sequence
        return result

    def close(self):
        self.channel.close()
