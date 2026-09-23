"""Independent consumer negatives; all receipts are synthetic and no units run."""
import copy
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).with_name('inert_service_ci_test.py')
spec = importlib.util.spec_from_file_location('inert_review_ci_fixtures', SOURCE)
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
ci = fixtures.ci


class IndependentReceiptReview(unittest.TestCase):
    def receipt(self):
        value = fixtures.packet_receipt('run-matrix')
        ci.validate_packet_receipt(value, 'run-matrix')
        return copy.deepcopy(value)

    def sample(self, value, case, offset=0):
        return next(row for row in value['cases'] if row['id'] == case)['samples'][offset]

    def refused(self, value):
        with self.assertRaises(RuntimeError):
            ci.validate_packet_receipt(value, 'run-matrix')

    def test_pass_verdict_without_observation_or_cleanup_cannot_be_accepted(self):
        for case in ('IS01', 'IS03', 'IS05', 'IS07', 'IS09', 'IS10', 'IS12'):
            for key in ('facts', 'cleanup'):
                with self.subTest(case=case, omitted=key):
                    value = self.receipt()
                    self.sample(value, case).pop(key, None)
                    self.refused(value)

    def test_decisive_case_event_cannot_be_replaced_by_a_pass_string(self):
        for case, event in (('IS03', 'leader_descendant_observed'),
                            ('IS03', 'descendant_stopped'),
                            ('IS08', 'hard_stop_observed'),
                            ('IS09', 'startup_gate_observed'),
                            ('IS10', 'replacement_refusal_observed')):
            with self.subTest(case=case, event=event):
                value = self.receipt()
                sample = self.sample(value, case)
                facts = sample.setdefault('facts', {})
                facts['events'] = [item for item in facts.get('events', [])
                                   if item.get('kind') != event]
                self.refused(value)

    def test_aggregate_clean_cannot_hide_missing_or_unresolved_sample_cleanup(self):
        for mutation in ('missing_role', 'unresolved', 'unbounded_duration'):
            with self.subTest(mutation=mutation):
                value = self.receipt()
                sample = self.sample(value, 'IS01')
                cleanup = sample.setdefault('cleanup', {})
                if mutation == 'missing_role':
                    cleanup.setdefault('roles', {}).pop('bw', None)
                elif mutation == 'unresolved':
                    cleanup['status'] = 'unresolved'
                    cleanup['unresolved'] = 1
                else:
                    cleanup['duration_ms'] = 30001
                self.refused(value)

    def test_event_from_another_case_cannot_cover_a_missing_startup_gate(self):
        value = self.receipt()
        sample = self.sample(value, 'IS09')
        sample.setdefault('facts', {})['events'] = copy.deepcopy(
            self.sample(value, 'IS05').get('facts', {}).get('events', []))
        self.refused(value)

    def event(self, sample, kind):
        return next(item for item in sample['facts']['events'] if item['kind'] == kind)

    def test_precleanup_observation_cannot_be_relabelled_as_cleanup_proof(self):
        value = self.receipt()
        self.sample(value, 'IS01')['facts']['observation_phase'] = 'after_cleanup'
        self.refused(value)

    def test_canary_progress_must_follow_the_fault_and_match_the_baseline(self):
        for mutation in ('postfault_baseline', 'prefault_progress', 'stale_counter',
                         'different_baseline', 'duplicate_event', 'boolean_time'):
            with self.subTest(mutation=mutation):
                value = self.receipt()
                sample = self.sample(value, 'IS04')
                baseline = self.event(sample, 'counter_baseline')
                fault = self.event(sample, 'fault')
                progress = self.event(sample, 'unaffected_progress')
                if mutation == 'postfault_baseline':
                    baseline['monotonic_ns'] = fault['monotonic_ns'] + 1
                elif mutation == 'prefault_progress':
                    progress['monotonic_ns'] = fault['monotonic_ns'] - 1
                elif mutation == 'stale_counter':
                    progress['after']['bw'] = progress['before']['bw']
                elif mutation == 'different_baseline':
                    baseline['counters']['bw'] += 1
                elif mutation == 'duplicate_event':
                    sample['facts']['events'].append(copy.deepcopy(progress))
                else:
                    baseline['monotonic_ns'] = False
                self.refused(value)

    def test_absence_cannot_be_substituted_for_runtime_removal(self):
        for mutation in ('missing_basis', 'not_acquired', 'runtime_unresolved',
                         'negative_file_count', 'boolean_socket_count', 'retained_unit_file'):
            with self.subTest(mutation=mutation):
                value = self.receipt()
                role = self.sample(value, 'IS01')['cleanup']['roles']['bw']
                if mutation == 'missing_basis':
                    role['absence_basis'] = None
                elif mutation == 'not_acquired':
                    role['processes'] = 'not_acquired'
                elif mutation == 'runtime_unresolved':
                    role['runtime']['status'] = 'unresolved'
                elif mutation == 'negative_file_count':
                    role['runtime']['files_removed'] = -1
                elif mutation == 'boolean_socket_count':
                    role['runtime']['sockets_removed'] = True
                else:
                    role['unit_file'] = 'retained'
                self.refused(value)

    def test_missing_startup_workers_cannot_be_counted_as_proven_absent(self):
        value = self.receipt()
        cleanup = self.sample(value, 'IS09')['cleanup']
        cleanup['roles']['aw']['processes'] = 'absent'
        cleanup['roles']['aw']['absence_basis'] = 'held_cgroup_empty'
        cleanup['absent'] += 1
        self.refused(value)

    def test_decisive_observations_must_support_the_actual_mechanism(self):
        mutations = [
            ('IS03', 'leader_descendant_observed', 'child_alive', False),
            ('IS03', 'leader_descendant_observed', 'leader_exited', False),
            ('IS08', 'hard_stop_observed', 'pid1_result', 'success'),
            ('IS08', 'hard_stop_observed', 'stop_elapsed_ms', 1),
            ('IS09', 'startup_gate_observed', 'supervisor_pending_seen', False),
            ('IS09', 'startup_gate_observed', 'worker_seen_running', {'aw': True, 'ax': False}),
            ('IS09', 'startup_gate_observed', 'worker_final_states', {'aw': 'active', 'ax': 'inactive'}),
            ('IS09', 'startup_gate_observed', 'poll_count', 0),
            ('IS10', 'replacement_refusal_observed', 'fresh_invocation', False),
            ('IS10', 'replacement_refusal_observed', 'stale_record_refused', False),
            ('IS10', 'replacement_refusal_observed', 'replacement_still_alive', False),
        ]
        for case, kind, field, replacement in mutations:
            with self.subTest(case=case, field=field):
                value = self.receipt()
                self.event(self.sample(value, case), kind)[field] = replacement
                self.refused(value)


if __name__ == '__main__':
    unittest.main()
