"""Proof-receipt regressions; simulated readbacks do not qualify the OS cases."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(HERE), str(HERE.parent)]
import packet
import qualification as q
import ownership


def immediate(predicate, seconds, reason):
    result = predicate()
    if not result: raise packet.Refusal(reason)
    return result


def case_for(identifier):
    case = q.Case.__new__(q.Case)
    case.case, case.variant, case.phase = identifier, 'synthetic', 0
    case.generation = packet.nonce()
    case.events = []
    case.counters = lambda: {'bw': 1, 'cc': 1}
    case.preserve = Mock()
    return case


class EvidenceTests(unittest.TestCase):
    def test_phase_progress_cannot_satisfy_post_fault_canary_check(self):
        case = case_for('IS04')
        case.variant, case.phase = 'kill', 4
        counter = {'value': 1}
        case.counters = lambda: {'bw': counter['value'], 'cc': counter['value']}
        case.preserve = q.Case.preserve.__get__(case)
        case.owned = {'as': Mock()}
        case.await_a_absence = Mock()
        with patch('qualification.time.sleep', side_effect=lambda _: counter.update(value=7)), patch('qualification.wait_for', side_effect=immediate):
            with self.assertRaisesRegex(packet.Refusal, 'unaffected_progress_lost'):
                case.exercise()
        baseline, fault = case.events
        self.assertEqual(baseline['kind'], 'counter_baseline')
        self.assertEqual(baseline['counters'], {'bw': 7, 'cc': 7})
        self.assertEqual(fault['kind'], 'fault')
        self.assertLessEqual(baseline['boottime_ns'], fault['boottime_ns'])

    def test_leader_child_lifetime_and_later_absence_are_retained(self):
        case = case_for('IS03')
        item = Mock(); item.pids = {11: 101, 12: 102}; item.runtime = '/synthetic'
        item.absent.side_effect = [False, True]
        item.absence_basis = 'held_cgroup_empty'
        case.owned = {'aw': item}
        with patch('qualification.read_json', return_value={'pid': 11, 'child': 12}), patch('qualification.exited', side_effect=lambda fd: fd == 101), patch('qualification.show', return_value={'ActiveState': 'active'}), patch('qualification.time.sleep'), patch('qualification.wait_for', side_effect=immediate):
            case.exercise()
        observed = next(event for event in case.events if event['kind'] == 'leader_descendant_observed')
        for key in ('leader_exited', 'child_held', 'child_alive', 'service_active', 'cgroup_populated'):
            self.assertIs(observed[key], True)
        stopped = next(event for event in case.events if event['kind'] == 'descendant_stopped')
        self.assertEqual(stopped['absence_basis'], 'held_cgroup_empty')
        self.assertNotIn('pid', observed)

    def test_hard_stop_result_and_timing_survive_success_and_refusal(self):
        for result in ('timeout', 'success'):
            with self.subTest(result=result):
                case = case_for('IS08')
                item = Mock(); item.absent.return_value = True
                item.absence_basis = 'all_held_members_exited_and_pid1_inactive'
                case.owned = {'aw': item}
                with patch('qualification.show', return_value={'Result': result}), patch('qualification.wait_for', side_effect=immediate), patch('qualification.time.monotonic', side_effect=[0, 4.6, 4.6]):
                    if result == 'timeout': case.exercise()
                    else:
                        with self.assertRaisesRegex(packet.Refusal, 'hard_stop_not_attributed'): case.exercise()
                observed = next(event for event in case.events if event['kind'] == 'hard_stop_observed')
                self.assertEqual(observed['pid1_result'], 'timeout' if result == 'timeout' else 'unexpected')
                self.assertEqual(observed['stop_elapsed_ms'], 4600)
                self.assertTrue(observed['grace_observed'])
                self.assertEqual(observed['absence_basis'], item.absence_basis)

    def test_startup_gate_records_polls_states_and_violation(self):
        for worker_started in (False, True):
            with self.subTest(worker_started=worker_started):
                case = case_for('IS09'); case.variant = 'delayed'
                polls = {'count': 0}
                def readback(name):
                    if name == packet.unit_name(case.generation, 'as'):
                        polls['count'] += 1
                        return {'ActiveState': 'activating' if polls['count'] == 1 else 'failed'}
                    return {'MainPID': '17' if worker_started else '0', 'ActiveState': 'active' if worker_started else 'inactive'}
                with patch('qualification.show', side_effect=readback), patch('qualification.time.monotonic', return_value=0), patch('qualification.time.sleep'):
                    if worker_started:
                        with self.assertRaisesRegex(packet.Refusal, 'worker_started_before_ready'): case.exercise()
                    else: case.exercise()
                observed = next(event for event in case.events if event['kind'] == 'startup_gate_observed')
                self.assertEqual(observed['poll_count'], 1 if worker_started else 2)
                self.assertTrue(observed['supervisor_pending_seen'])
                self.assertEqual(observed['supervisor_final_state'], 'activating' if worker_started else 'failed')
                self.assertEqual(observed['worker_seen_running'], {'aw': worker_started, 'ax': worker_started})
                self.assertNotIn('17', json.dumps(observed['worker_final_states']))

    def test_replacement_event_keeps_decisive_facts_without_identifiers(self):
        case = case_for('IS10'); case.directory = Path('/synthetic')
        name = packet.unit_name(case.generation, 'aw')
        original = Mock(); original.name = name; original.invocation = '1' * 32
        original.absent.return_value = True
        original.stop.side_effect = [None, packet.Refusal('replacement_refused')]
        replacement = Mock(); replacement.invocation = '2' * 32; replacement.absent.return_value = False
        replacement.record.return_value = {'private_identity': replacement.invocation}
        case.owned = {'aw': original}; case.units = {name: '[Service]\nExecStart=!/inert_launcher.py synthetic\n'}
        case.unit_files = {name: [1, 2]}
        with patch('qualification.wait_for', side_effect=immediate), patch('qualification.show', return_value={'ActiveState': 'active', 'InvocationID': replacement.invocation}), patch('qualification.OwnedUnit.acquire', return_value=replacement), patch('qualification.systemctl'), patch('qualification.immutable_json'), patch('qualification.time.sleep'), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_dev=1, st_ino=2)), patch.object(Path, 'write_text'):
            case.replacement()
        observed = case.events[-1]
        self.assertEqual(observed['kind'], 'replacement_refusal_observed')
        for key in ('fresh_invocation', 'stale_record_refused', 'replacement_still_alive'):
            self.assertIs(observed[key], True)
        self.assertNotIn(original.invocation, json.dumps(case.events))
        self.assertNotIn(replacement.invocation, json.dumps(case.events))
        self.assertNotIn(name, json.dumps(case.events))

    def test_cleanup_is_attached_after_immutable_verdict_and_cannot_repair_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            cleanup = {'status': 'complete', 'absent': 6, 'unresolved': 0, 'duration_ms': 2, 'roles': q.cleanup_roles(), 'unit_files': {}, 'control_sockets': {}}
            fixture = Mock(); fixture.directory = directory; fixture.events = []
            fixture.exercise.side_effect = packet.Refusal('independent_absence_timeout')
            def reclaim():
                saved = json.loads((directory / 'verdict.json').read_bytes())
                self.assertNotIn('cleanup', saved)
                self.assertEqual(saved['status'], 'failed')
                self.assertEqual(saved['reason'], 'independent_absence_timeout')
                return cleanup
            fixture.cleanup.side_effect = reclaim
            with patch('qualification.Case', return_value=fixture), patch('qualification.CASES', ('IS01',)), patch.dict('qualification.SAMPLES', {'IS01': (('normal', 0),)}, clear=True), patch('qualification.sanitized_facts', return_value={'observation_phase': 'before_cleanup'}):
                rows, total = q.run_matrix(directory, {})
            saved = json.loads((directory / 'verdict.json').read_bytes())
            self.assertNotIn('cleanup', saved)
            self.assertEqual(rows[0]['status'], 'failed')
            self.assertEqual(rows[0]['samples'][0]['cleanup'], cleanup)
            self.assertEqual(total['status'], 'complete')
            self.assertFalse(q.matrix_passed(rows, total))

    def test_cleanup_deadline_includes_evidence_persistence(self):
        with tempfile.TemporaryDirectory() as temporary:
            case = case_for('IS02'); case.directory = Path(temporary)
            case.relays = {}; case.extra_owner_fd = None; case.sockets = {}
            case.socket_identities = {}; case.unit_files = {}; case.owned = {}; case.ready = False
            current = {'time': 0}
            def persist(path, value):
                ownership.immutable_json(path, value)
                current['time'] = 30.1
            with patch('qualification.time.monotonic', side_effect=lambda: current['time']), patch('qualification.show', return_value={'MainPID': '0', 'ActiveState': 'inactive'}), patch('qualification.systemctl'), patch('qualification.immutable_json', side_effect=persist):
                result = case.cleanup()
            self.assertEqual(result['status'], 'unresolved')
            self.assertEqual(result['duration_ms'], 30100)
            self.assertGreater(result['unresolved'], 0)
            self.assertFalse(case.cleaned)

    def test_prior_cleanup_timeout_never_promoted_by_later_complete_cleanup(self):
        rows = q.matrix()
        for row in rows:
            row.update(status='passed', samples=[{'variant': variant, 'phase': phase, 'status': 'passed', 'latency_ms': 1,
                'cleanup': {'status': 'complete', 'unresolved': 0, 'duration_ms': 1}}
                for variant, phase in q.SAMPLES[row['id']]])
        later_cleanup = {'status': 'complete', 'unresolved': 0}
        self.assertTrue(q.matrix_passed(rows, later_cleanup))
        for field, value in (('duration_ms', 30001), ('status', 'unresolved'), ('duration_ms', True)):
            changed = copy.deepcopy(rows)
            changed[0]['samples'][0]['cleanup'][field] = value
            self.assertFalse(q.matrix_passed(changed, later_cleanup))


if __name__ == '__main__': unittest.main()
