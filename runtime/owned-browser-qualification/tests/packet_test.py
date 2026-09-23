"""Unprivileged adversarial fixtures. No service/device/VM API is called."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from policy import Refusal, allocation_entries, generation, names, render, userfaultfd_minor
from files import Deadline, anchored, copy_verified, identity, read_at, snapshot_finite, unique_json
from ownership import HeldParent, Manager
from qualification import remove_finite_tree
from owner import Frames, image

spec = importlib.util.spec_from_file_location('owned_stage', HERE / 'stage.py')
stage = importlib.util.module_from_spec(spec); spec.loader.exec_module(stage)
ROOT = Path('/var/lib/hob/' + 'a' * 32)
GEN = 'a' * 26


class PacketTests(unittest.TestCase):
    def test_render_is_finite_and_proposed_authority_is_literal(self):
        units = render(ROOT, GEN, 245)
        self.assertEqual(len(units), 12)
        self.assertEqual(set(units), set(names(GEN).values()))
        vmm = units[names(GEN)['vmm']]
        self.assertIn('DeviceAllow=/dev/char/10:232 rwm', vmm)
        self.assertIn('DeviceAllow=/dev/char/10:200 m', vmm)
        self.assertIn('DeviceAllow=/dev/char/10:245 m', vmm)
        self.assertNotIn('Delegate=yes', vmm)
        self.assertNotIn('CAP_SYS_PTRACE', vmm)
        self.assertIn('ExecStart=!/usr/bin/python3 -I -S -B ', vmm)
        for text in units.values():
            if '/usr/bin/python3' in text:
                self.assertIn('/usr/bin/python3 -I -S -B ', text)
        self.assertIn('RuntimeMaxSec=2100s', units[names(GEN)['canary']])
        owner = units[names(GEN)['owner']]
        self.assertIn('CAP_SYS_PTRACE', owner)
        self.assertIn('SystemCallFilter=~ptrace process_vm_readv process_vm_writev', owner)
        self.assertIn('Slice=' + names(GEN)['owner_parent'], owner)
        self.assertIn('StopWhenUnneeded=no', units[names(GEN)['owner_parent']])

    def test_generations_are_canonical_and_paths_not_actor_selected(self):
        for _ in range(20):
            self.assertEqual(len(names(generation())), 12)
        for bad in ('../x', 'a' * 25, 'a' * 25 + 'b', 'a' * 26 + '\n'):
            with self.assertRaises(Refusal): names(bad)
        for path in ('/tmp/hob/' + 'a' * 32, '/var/lib/hob/a/..', '/var/lib/hob/' + 'A' * 32):
            with self.assertRaises(Refusal): render(path, GEN)

    def test_userfaultfd_does_not_widen_fixed_devices(self):
        self.assertIsNone(userfaultfd_minor('200 tun\n232 kvm\n'))
        self.assertEqual(userfaultfd_minor('245 userfaultfd\n'), 245)
        for bad in ('200 userfaultfd', '232 userfaultfd', '245 userfaultfd\n246 userfaultfd',
                    '-1 userfaultfd', '256 userfaultfd', '245 userfaultfd other', 'userfaultfd 245'):
            with self.subTest(bad=bad), self.assertRaises(Refusal): userfaultfd_minor(bad)

    def test_stage_unchanged_read_allows_atime_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'input'; path.write_bytes(b'immutable')
            os.utime(path, ns=(1, 1))
            self.assertEqual(stage.read(path, 64), b'immutable')
            self.assertEqual(stage.read(path, 64), b'immutable')

    def test_nofollow_and_fifo_reads_refuse_without_hanging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'file').write_bytes(b'x')
            (root / 'link').symlink_to('file'); os.mkfifo(root / 'fifo')
            with anchored(root) as fd:
                for name in ('link', 'fifo'):
                    with self.subTest(name=name), self.assertRaises((OSError, Refusal)): read_at(fd, name, 128)
            for name in ('link', 'fifo'):
                with self.assertRaises((OSError, ValueError)): stage.read(root / name, 128)

    def test_source_hardlinks_are_not_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'file').write_bytes(b'x'); os.link(root / 'file', root / 'alias')
            with anchored(root) as fd, self.assertRaises(Refusal): read_at(fd, 'file', 10)

    def test_json_duplicate_nan_and_bounds_refused(self):
        for bad in (b'{"a":1,"a":2}', b'{"n":NaN}', b'', b'x' * 128):
            with self.assertRaises(Refusal): unique_json(bad, maximum=64)

    def test_copy_binds_actual_bytes_and_refuses_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'source').mkdir(); (root / 'dest').mkdir()
            data = b'unchanged synthetic disk'; (root / 'source/item').write_bytes(data)
            policy = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mode': 0o444}
            with anchored(root / 'source') as source, anchored(root / 'dest') as target:
                copied = copy_verified(source, 'item', target, 'copy', policy, Deadline.after(2))
                self.assertEqual(copied['sha256'], policy['sha256'])
                self.assertEqual((root / 'dest/copy').stat().st_mode & 0o777, 0o444)
                with self.assertRaises(Refusal): copy_verified(source, 'item', target, 'bad', {**policy, 'sha256': '0' * 64}, Deadline.after(2))

    def test_cleanup_refuses_swapped_known_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'root.ext4').write_bytes(b'old'); (root / 'state.ext4').write_bytes(b'state')
            allowed = {'root.ext4': 'file', 'state.ext4': 'file'}
            owned = snapshot_finite(root, allowed)
            (root / 'root.ext4').rename(root / 'original')
            (root / 'root.ext4').write_bytes(b'replacement')
            (root / 'original').unlink()
            with self.assertRaises(Refusal): remove_finite_tree(root, allowed, expected=owned)
            self.assertEqual((root / 'root.ext4').read_bytes(), b'replacement')
            self.assertEqual((root / 'state.ext4').read_bytes(), b'state')

    def test_cleanup_rejects_replaced_empty_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent=Path(temporary); root=parent/'allocation'; root.mkdir()
            owned=identity(root.stat()); root.rename(parent/'old'); root.mkdir()
            with self.assertRaises(Refusal): remove_finite_tree(root,{},expected_root=owned)
            self.assertTrue(root.is_dir())

    def test_cleanup_refuses_symlink_and_unknown_leaf(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'known').write_bytes(b'keep'); (root / 'unknown').write_bytes(b'keep')
            with self.assertRaises(Refusal): remove_finite_tree(root, {'known': 'file'})
            self.assertTrue((root / 'known').exists())
            (root / 'unknown').unlink(); (root / 'known').unlink(); (root / 'known').symlink_to('/etc/passwd')
            with self.assertRaises(Refusal): remove_finite_tree(root, {'known': 'file'})

    def test_cleanup_deletes_only_held_finite_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'nested').mkdir(); (root / 'nested/owned').write_bytes(b'proof')
            allowed = {'nested/owned': 'file'}
            self.assertEqual(remove_finite_tree(root, allowed, expected=snapshot_finite(root, allowed)), 1)
            self.assertEqual(list(root.iterdir()), [])

    def test_control_frames_are_bounded_incremental_and_strict(self):
        value = b'{"operation":"hello"}'; framed = len(value).to_bytes(4, 'big') + value
        parser = Frames(); self.assertEqual(parser.feed(framed[:3]), [])
        self.assertEqual(parser.feed(framed[3:]), [{'operation': 'hello'}])
        with self.assertRaises(Refusal): Frames().feed((4097).to_bytes(4, 'big'))
        with self.assertRaises(Refusal): Frames().feed(b'0' * 8193)
        bad = b'{"a":1,"a":2}'
        with self.assertRaises(Refusal): Frames().feed(len(bad).to_bytes(4,'big') + bad)

    def test_image_receipt_does_not_accept_shape_or_type_drift(self):
        good = {'sha256': 'a' * 64, 'bytes': 32, 'width': 960, 'height': 720}
        self.assertEqual(image(good), good)
        for bad in ({**good,'bytes':True}, {**good,'width':1024}, {**good,'sha256':'z'*64}, {**good,'extra':1}):
            with self.assertRaises(Refusal): image(bad)

    def test_manager_has_no_empty_or_arbitrary_unit_scope(self):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv); return types.SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
        manager = Manager(GEN, run)
        for args in [('stop',()), ('start',('foreign',)), ('kill',('owner',)), ('daemon-reload',('owner',))]:
            with self.assertRaises(Refusal): manager.command(*args)
        self.assertEqual(calls, [])
        manager.command('stop', ('owner',)); self.assertIn(names(GEN)['owner'], calls[0])

    def test_parent_replacement_refuses_even_when_new_parent_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); units = names(GEN)
            path = root / units['study'] / units['parent']; path.mkdir(parents=True)
            (path / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
            class Fake:
                units = names(GEN)
                def show(self, role, deadline=None):
                    return {'InvocationID': 'a'*32,'ControlGroup':'/'+units['study']+'/'+units['parent'],'ActiveState':'active'}
            held = HeldParent(Fake(), cgroup_root=root, boot=lambda:'boot')
            try:
                (path / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
                self.assertEqual(held.observe()['populated'], 1)
                with self.assertRaises(Refusal): held.absent(creation_quiescent=False)
                path.rename(path.with_name('replaced')); path.mkdir(); (path/'cgroup.events').write_text('populated 0\n')
                with self.assertRaises(Refusal): held.absent(creation_quiescent=True)
            finally:
                held.close()

    def test_no_import_or_execution_of_submitted_assets_in_stager(self):
        source = (HERE/'stage.py').read_text()
        self.assertNotIn('subprocess', source)
        self.assertNotIn('exec(', source)
        self.assertNotIn('execve', source)
        self.assertIn("catalog.get('accepted') is not True", source)


if __name__ == '__main__': unittest.main()

class LifecycleNegatives(unittest.TestCase):
    def test_broker_startup_does_not_activate_from_gate_ready(self):
        sys.path.insert(0, str(HERE.parent))
        from lease import Lease
        from broker.leases import ClockSample
        first = ClockSample('a'*32, 1000)
        lease = Lease('supervisor', first)
        self.assertEqual(lease.status()['state'], 'startup')
        lease.request({'study': lease.study, 'sequence': 1}, ClockSample('a'*32, 5000))
        self.assertEqual(lease.status()['state'], 'startup')
        lease.request({'study': lease.study, 'operation': 'activate'}, ClockSample('a'*32, 6000))
        self.assertEqual(lease.status()['state'], 'active')
        with self.assertRaises(Exception): lease.request({'study': lease.study, 'sequence': 1}, ClockSample('a'*32, 7000))
        self.assertFalse(lease.advance(ClockSample('a'*32, 25000)))
        with self.assertRaises(Exception): lease.request({'study': lease.study, 'operation':'activate'}, ClockSample('a'*32, 26000))

    def test_absolute_cap_wins_despite_renewals(self):
        sys.path.insert(0, str(HERE.parent))
        from lease import Lease
        from broker.leases import ClockSample
        lease = Lease('supervisor', ClockSample('b'*32, 0))
        lease.request({'study':lease.study,'operation':'activate'},ClockSample('b'*32,1))
        for sequence, time in enumerate(range(5000, 120000, 5000),1):
            lease.request({'study':lease.study,'sequence':sequence},ClockSample('b'*32,time))
        self.assertEqual(lease.status()['lease_deadline_ms'],120000)
        self.assertFalse(lease.advance(ClockSample('b'*32,120000)))

    def test_owner_capture_rejects_known_path_replacement_before_boot(self):
        from owner import Owner
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); (root/'allocation.json').write_bytes(b'original')
            owner=Owner.__new__(Owner); owner.instance=root; owner.minor=None; owner.record={}
            owner.instance_identity=identity(root.stat())
            owner.acquired_entries=snapshot_finite(root, allocation_entries(None)[0])
            (root/'allocation.json').rename(root/'previous'); (root/'allocation.json').write_bytes(b'foreign'); (root/'previous').unlink()
            import owner as owner_module
            original_anchor=owner_module.anchored
            with patch.object(owner_module,'anchored',lambda path, **kwargs: original_anchor(path)), self.assertRaisesRegex(Refusal,'allocation_entry_changed'):
                owner.capture()
            self.assertEqual((root/'allocation.json').read_bytes(),b'foreign')

    def test_pending_pid1_start_prevents_quiescence_even_empty_parent(self):
        from qualification import Case
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); unit=names(GEN)['vmm']; content=b'fixed source'
            (root/unit).write_bytes(content)
            class Fake:
                def show(self, role, deadline=None):
                    return {'Job':'73','ActiveState':'inactive','MainPID':'0','ControlGroup':''}
            case=Case.__new__(Case); case.manager=Fake(); case.units=names(GEN)
            case.parent=types.SimpleNamespace(group='/owned'); case.facts={'events':[]}
            case.unit_files={unit:{'identity':identity((root/unit).stat()),'sha256':hashlib.sha256(content).hexdigest()}}
            import qualification
            real=qualification.anchored
            def anchor(path, **kwargs): return real(root if str(path)=='/run/systemd/system' else path)
            with patch.object(qualification,'anchored',anchor), self.assertRaises(Refusal): case.vmm_quiescent(Deadline.after(1))
            self.assertEqual(case.facts['events'],[])

    def test_owner_and_prelude_cannot_use_nonforking_absence_fallback(self):
        import qualification
        for role in ('owner','prelude','vmm'):
            held=qualification.HeldService.__new__(qualification.HeldService)
            held.unit=types.SimpleNamespace(role=role, control_group='/synthetic', current=lambda d: {'ActiveState':'inactive','MainPID':'0'})
            held.pidfd=31; held.events=32
            with patch.object(qualification.select,'select',return_value=([31],[],[])), patch.object(qualification.os,'lseek',side_effect=OSError(errno.ENODEV,'gone')):
                with self.assertRaises(OSError): held.stopped(Deadline.after(1))

    def test_partial_capture_cannot_promote_missing_allocation_identity(self):
        from qualification import Case
        case=Case.__new__(Case); case.acquired_entries={'state.ext4':(1,2,stat.S_IFREG)}
        with self.assertRaises(Refusal): case.merge_acquired({'state.ext4':(1,3,stat.S_IFREG)})
        self.assertEqual(case.acquired_entries['state.ext4'],(1,2,stat.S_IFREG))

class StagingCleanupTests(unittest.TestCase):
    def test_finish_removes_only_created_staging_base_after_catalog_readback(self):
        import qualification
        for created in (False, True):
            with self.subTest(created=created), tempfile.TemporaryDirectory() as temporary:
                parent=Path(temporary); base=parent/'base'; base.mkdir(); root=base/('a'*32); root.mkdir()
                (parent/'canary').write_bytes(b'unrelated')
                for directory in ('code','runtime','catalog','a','receipts'): (root/directory).mkdir()
                (root/'code/policy.py').write_bytes(b'synthetic fixed source')
                (root/'runtime/guest-bootstrap.js').write_bytes(b'synthetic fixed payload')
                node=b'synthetic executable bytes never executed'; (root/'catalog/node').write_bytes(node)
                assets={'node':{'bytes':len(node),'sha256':hashlib.sha256(node).hexdigest(),'mode':0o555}}
                (root/'receipts/receipt.json').write_text(json.dumps({'cleanup':{'status':'complete'},'implementedCellsObserved':True,'catalog':{'assets':assets}}))
                (root/'source-manifest.json').write_text(json.dumps({'files':{'policy.py':'a'*64}}))
                (root/'package-manifest.json').write_text(json.dumps({'files':{'opt/humanish/control/guest-bootstrap.js':{}}}))
                (root/'staging-identity.json').write_text(json.dumps({'root':identity(root.stat()),'base':identity(base.stat()),'baseCreated':created}))
                real_anchor=qualification.anchored
                with patch.object(qualification,'checked_packet_path',lambda value:Path(value)), patch.object(qualification,'anchored',lambda value,**kwargs:real_anchor(value)):
                    result=qualification.finish(root)
                self.assertTrue(result['catalogUnchanged']); self.assertTrue(result['rootAbsent'])
                self.assertEqual(base.exists(),not created)
                self.assertEqual((parent/'canary').read_bytes(),b'unrelated')

class FinalEvidenceTests(unittest.TestCase):
    def test_serial_requires_both_boot_versions_besides_listening_hint(self):
        from owner import SerialFacts
        facts=SerialFacts()
        self.assertTrue(facts.line(b'[ 2.000] humanish-vsock[201]: HUMANISH_GUEST_LISTENING_V1'))
        with self.assertRaises(Refusal): facts.admitted()
        facts.line(b'[ 0.000] Linux version 6.18.39-humanish-browser-amd64-1 (synthetic fixture)')
        with self.assertRaises(Refusal): facts.admitted()
        facts.line(b'[ 1.000] systemd[1]: systemd 257.13-1~deb13u1 running in system mode')
        self.assertEqual(facts.admitted()['authority'],'bounded_serial_diagnostic_only')
        with self.assertRaises(Refusal): facts.line(b'Linux version 6.1.0 (different boot)')

    def test_slice_stop_waits_for_no_job_and_actual_path_removal(self):
        from qualification import stop_retained_slice
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'slice'; path.mkdir()
            rows=[{'InvocationID':'a'*32,'Job':'12','ActiveState':'deactivating','ControlGroup':'/owned'},
                  {'InvocationID':'a'*32,'Job':'','ActiveState':'inactive','ControlGroup':''}]
            calls=[]
            class Manager:
                def command(self,verb,roles,deadline): calls.append((verb,roles))
                def show(self,role,deadline):
                    row=rows.pop(0)
                    if not rows: path.rmdir()
                    return row
            held=types.SimpleNamespace(role='parent',invocation='a'*32,group='/owned',path=path,manager=Manager(),
                observe=lambda deadline:{'populated':0,'basis':'same_active_parent_recursive_population'})
            result=stop_retained_slice(held,Deadline.after(2))
            self.assertEqual(calls,[('stop',('parent',))]); self.assertTrue(result['cgroupPathAbsent'])
            self.assertEqual(rows,[])

    def test_populated_or_replaced_slice_never_promotes_stop(self):
        from qualification import stop_retained_slice
        held=types.SimpleNamespace(observe=lambda deadline:{'populated':1})
        with self.assertRaisesRegex(Refusal,'slice_still_populated'): stop_retained_slice(held,Deadline.after(1))
        manager=types.SimpleNamespace(command=lambda *args:None,show=lambda *args:{'InvocationID':'b'*32})
        held=types.SimpleNamespace(observe=lambda deadline:{'populated':0},manager=manager,role='parent',invocation='a'*32)
        with self.assertRaisesRegex(Refusal,'stopped_slice_replaced'): stop_retained_slice(held,Deadline.after(1))
