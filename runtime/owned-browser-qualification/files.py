"""Bounded no-follow file authority. No filesystem effects occur at import."""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
from policy import Refusal, encode


def identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))


def stable(info):
    return (identity(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def leaf(name):
    if not isinstance(name, str) or not name or '/' in name or name in ('.', '..') or '\x00' in name:
        raise Refusal('invalid_leaf')
    return name


@dataclass
class Deadline:
    end: float

    @classmethod
    def after(cls, seconds):
        return cls(time.clock_gettime(time.CLOCK_BOOTTIME) + seconds)

    def remaining(self, maximum=5):
        value = min(maximum, self.end - time.clock_gettime(time.CLOCK_BOOTTIME))
        if value <= 0:
            raise Refusal('operation_deadline')
        return value


@contextmanager
def anchored(path, *, trusted=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise Refusal('invalid_directory')
    handles = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)]
    links = []
    try:
        for part in path.parts[1:]:
            parent = handles[-1]
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            handles.append(child)
            info = os.fstat(child)
            if trusted and (info.st_uid != 0 or info.st_mode & 0o022):
                raise Refusal('untrusted_directory')
            links.append((parent, part, identity(info)))
        yield handles[-1]
        for parent, part, expected in links:
            if identity(os.stat(part, dir_fd=parent, follow_symlinks=False)) != expected:
                raise Refusal('directory_replaced')
    finally:
        for handle in reversed(handles):
            os.close(handle)


def read_at(parent, name, maximum):
    fd = os.open(leaf(name), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 <= info.st_size <= maximum:
            raise Refusal('invalid_regular_input')
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) != info.st_size or stable(os.fstat(fd)) != stable(info):
            raise Refusal('changed_regular_input')
        return bytes(data)
    finally:
        os.close(fd)


def unique_json(raw, maximum=65536):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= maximum:
        raise Refusal('invalid_json_size')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Refusal('duplicate_json_member')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(Refusal('invalid_json')))
    except (ValueError, UnicodeError, RecursionError):
        raise Refusal('invalid_json') from None


def durable_at(parent, name, data, mode=0o600):
    fd = os.open(leaf(name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise Refusal('short_write')
            view = view[count:]
        os.fchmod(fd, mode)
        os.fsync(fd)
        info = os.fstat(fd)
    finally:
        os.close(fd)
    os.fsync(parent)
    return identity(info)


def copy_verified(source_fd, source_name, destination_fd, destination_name, spec, deadline):
    """The expected digest is supplied by reviewed policy, never by input bytes."""
    maximum = spec.get('bytes', spec.get('maximumBytes'))
    expected = spec['sha256']
    if type(maximum) is not int or not 1 <= maximum <= 2147483648 or re.fullmatch(r'[0-9a-f]{64}', expected) is None:
        raise Refusal('invalid_copy_policy')
    fd = os.open(leaf(source_name), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=source_fd)
    output = None
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= maximum or (
            'bytes' in spec and before.st_size != spec['bytes']):
            raise Refusal('invalid_asset_shape')
        output = os.open(leaf(destination_name), os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=destination_fd)
        digest = hashlib.sha256()
        count = 0
        while True:
            deadline.remaining()
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > maximum:
                raise Refusal('asset_grew')
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(output, view)
                if written <= 0:
                    raise Refusal('short_write')
                view = view[written:]
        if count != before.st_size or stable(before) != stable(os.fstat(fd)) or digest.hexdigest() != expected:
            raise Refusal('asset_mismatch')
        os.lseek(output, 0, os.SEEK_SET)
        copied = hashlib.sha256()
        while True:
            deadline.remaining()
            chunk = os.read(output, 1024 * 1024)
            if not chunk:
                break
            copied.update(chunk)
        if copied.hexdigest() != expected:
            raise Refusal('copy_mismatch')
        os.fchmod(output, spec['mode'])
        os.fsync(output)
        info = os.fstat(output)
        os.fsync(destination_fd)
        return {'identity': identity(info), 'bytes': count, 'sha256': expected, 'mode': spec['mode']}
    finally:
        if output is not None:
            os.close(output)
        os.close(fd)


def unlink_exact(parent, name, expected):
    info = os.stat(leaf(name), dir_fd=parent, follow_symlinks=False)
    if identity(info) != tuple(expected) or info.st_nlink != 1 or not (
        stat.S_ISREG(info.st_mode) or stat.S_ISSOCK(info.st_mode) or stat.S_ISFIFO(info.st_mode)):
        raise Refusal('cleanup_entry_replaced')
    os.unlink(name, dir_fd=parent)
    os.fsync(parent)


def snapshot_finite(path, allowed):
    """Capture current explicit leaves/directories, without following links.

    Capture belongs at creation/admission, not as a substitute for old identity
    at cleanup. All encountered names must be in the finite planned tree.
    """
    result = {}
    def walk(fd, prefix=''):
        for name in sorted(os.listdir(fd)):
            relative = prefix + name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if len(result) > 128:
                raise Refusal('allocation_entry_bounds')
            if stat.S_ISDIR(info.st_mode):
                if not any(item.startswith(relative + '/') for item in allowed):
                    raise Refusal('unknown_allocation_directory')
                result[relative] = identity(info)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if identity(os.fstat(child)) != identity(info):
                        raise Refusal('allocation_directory_changed')
                    walk(child, relative + '/')
                finally:
                    os.close(child)
            else:
                if relative not in allowed or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
                    raise Refusal('unknown_allocation_entry')
                result[relative] = identity(info)
    with anchored(path) as fd:
        walk(fd)
    return result
