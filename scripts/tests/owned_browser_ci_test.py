"""No root call is dispatched by these CI admission fixtures."""
import importlib.util
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'owned-browser-ci.py'
spec = importlib.util.spec_from_file_location('owned_browser_ci', SOURCE)
ci = importlib.util.module_from_spec(spec); spec.loader.exec_module(ci)


def environment():
    return {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux',
            'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':ci.REPOSITORY,'GITHUB_REF':'refs/heads/main',
            'GITHUB_WORKFLOW_REF':ci.REPOSITORY+'/'+ci.WORKFLOW+'@refs/heads/main',
            'GITHUB_SHA':'a'*40,'GITHUB_WORKFLOW_SHA':'a'*40,'GITHUB_RUN_ID':'12345'}


def observed_receipt():
    population=[{'populated':value,'basis':'same_active_parent_recursive_population'} for value in (0,1,0)]
    slices=[{'kind':'retained_slice_removed','role':role,'terminalNoJob':True,'cgroupPathAbsent':True,
             'sameInvocationBeforeStop':True,'populationBeforeStop':{'populated':0}} for role in ('parent','owner_parent','study','other')]
    events=[{'kind':'counter_baseline','counters':{'bw':1,'canary':1},'boottime_ns':10},
            {'kind':'unaffected_progress','before':{'bw':1,'canary':1},'after':{'bw':2,'canary':2},'boottime_ns':20}]
    rows=[]
    for name in ('PRELUDE','OB01'):
        rows.append({'id':name,'status':'observed','cleanup':{'status':'complete','unresolved':0},
                     'facts':{'parentObservations':copy.deepcopy(population),'events':copy.deepcopy(events+slices)}})
    rows[0]['facts']['events'] += [{'kind':'post_ready_fork_observed','leaderExited':True},
                                  {'kind':'same_parent_after_leaf_removal','serviceLeafAbsent':True}]
    rows[1]['facts'].update(ownerParentObservations=copy.deepcopy(population),frames={name:{} for name in ('before','typed','after')},
        owner={'admitted':True,'saveDispatches':1,'materialActions':2,'bootDiagnostics':{'kernelRelease':'6.18.39-humanish-browser-amd64-1',
        'systemdVersion':'257.13-1~deb13u1','listeningHints':1,'authority':'bounded_serial_diagnostic_only'}})
    rows += [{'id':f'OB{index:02}','status':'not_implemented'} for index in range(2,9)]
    return {'schema':'humanish.owned-browser-qualification.v1','aggregate':False,'visualReview':'pending',
            'implementedCellsObserved':True,'cleanup':{'status':'complete'},'cases':rows}


class CiTests(unittest.TestCase):
    def test_actual_committed_git_blob_read_and_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository=Path(temporary)
            def git(*args):
                return subprocess.run(['/usr/bin/git','-c','core.hooksPath=/dev/null',*args],cwd=repository,
                    env={**ci.ENV,'GIT_AUTHOR_NAME':'Synthetic Fixture','GIT_AUTHOR_EMAIL':'fixture@example.test',
                         'GIT_COMMITTER_NAME':'Synthetic Fixture','GIT_COMMITTER_EMAIL':'fixture@example.test',
                         'GIT_CONFIG_NOSYSTEM':'1'},capture_output=True,check=True,timeout=5).stdout
            git('init','--initial-branch=main')
            (repository/'proof.py').write_bytes(b'print("synthetic")\n')
            git('add','proof.py'); git('commit','-m','synthetic fixture')
            commit=git('rev-parse','HEAD').decode().strip()
            self.assertEqual(ci.git_bytes(repository,commit,'proof.py'),b'print("synthetic")\n')
            with self.assertRaises(ValueError): ci.git_bytes(repository,commit,'proof.py',maximum=1)
            (repository/'proof.py').write_bytes(b'changed working tree')
            git('add','proof.py'); git('commit','-m','replacement fixture')
            replacement=git('rev-parse','HEAD').decode().strip()
            git('replace',commit,replacement)
            self.assertEqual(ci.git_bytes(repository,commit,'proof.py'),b'print("synthetic")\n')

    def test_only_reviewed_canonical_manual_host(self):
        self.assertEqual(ci.provenance(environment())['commit'], 'a'*40)
        for key,value in [('GITHUB_EVENT_NAME','pull_request'),('GITHUB_EVENT_NAME','push'),
            ('GITHUB_REF','refs/heads/feature'),('GITHUB_REPOSITORY','fork/humanish'),
            ('RUNNER_ENVIRONMENT','self-hosted'),('GITHUB_WORKFLOW_SHA','b'*40),('RUNNER_OS','Windows')]:
            with self.subTest(key=key,value=value), self.assertRaises(ValueError): ci.provenance({**environment(),key:value})

    def test_root_timeout_prevents_second_command(self):
        ci.ROOT_UNCONFIRMED = False
        with patch.object(ci.subprocess,'run',side_effect=subprocess.TimeoutExpired('sudo',20)) as run:
            with self.assertRaises(ValueError): ci.root(['/usr/bin/python3'])
            with self.assertRaises(ValueError): ci.root(['/usr/bin/python3'])
            self.assertEqual(run.call_count,1)
        ci.ROOT_UNCONFIRMED = False

    def test_timeout_wraps_actual_root_child(self):
        ci.ROOT_UNCONFIRMED = False
        with patch.object(ci.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'{}',b'')) as run:
            ci.root(['/usr/bin/python3','-I','-S','-'],b'synthetic',timeout=7)
            args=run.call_args.args[0]
            self.assertLess(args.index('/usr/bin/sudo'),args.index('/usr/bin/timeout'))
            self.assertLess(args.index('/usr/bin/timeout'),args.index('/usr/bin/python3'))
            self.assertIn('7s',args)

    def test_bare_green_or_missing_coverage_is_not_accepted(self):
        for value in ({'aggregate':True}, {'schema':'humanish.owned-browser-qualification.v1','aggregate':False,
            'visualReview':'pending','implementedCellsObserved':True,'cleanup':{'status':'complete'},'cases':[]}):
            with self.assertRaises(ValueError): ci.validate(value)

    def test_consumption_requires_boot_and_independent_cleanup_facts(self):
        self.assertIs(ci.validate(value:=observed_receipt()),value)
        mutations=[lambda v:v['cases'][1]['facts']['owner'].pop('bootDiagnostics'),
            lambda v:v['cases'][1]['facts']['ownerParentObservations'].clear(),
            lambda v:v['cases'][1]['facts']['events'].pop(),
            lambda v:v['cases'][0]['cleanup'].update(unresolved=1),
            lambda v:v['cases'][1]['facts']['events'][0].update(counters={'bw':0,'canary':0})]
        for mutate in mutations:
            value=observed_receipt(); mutate(value)
            with self.assertRaises(ValueError): ci.validate(value)

    def test_receipt_duplicate_members_refused(self):
        with self.assertRaises(ValueError): ci.decode(b'{"status":1,"status":2}')

    def test_success_requires_three_exported_frames_bound_to_receipt(self):
        data=b'finite synthetic image transport bytes'
        digest=hashlib.sha256(data).hexdigest()
        expected={name:{'sha256':digest,'bytes':len(data)} for name in ('before','typed','after')}
        receipt={'cases':[{'id':'OB01','facts':{'frames':expected}}]}
        images={name:{'data':base64.b64encode(data).decode(),'sha256':digest} for name in expected}
        def exported(value,code=0):
            return subprocess.CompletedProcess([],code,json.dumps({'schema':'humanish.owned-browser-export.v1','receipt':receipt,'images':value}).encode(),b'')
        self.assertEqual(set(ci.consume_export(exported(images),receipt,successful=True)),set(expected))
        for value in (exported(images,1),exported(images,2),exported({}),exported({'before':images['before']})):
            with self.assertRaises(ValueError): ci.consume_export(value,receipt,successful=True)
        wrong=b'changed bytes'; changed={**images,'after':{'data':base64.b64encode(wrong).decode(),'sha256':hashlib.sha256(wrong).hexdigest()}}
        with self.assertRaisesRegex(ValueError,'image_receipt_mismatch'): ci.consume_export(exported(changed),receipt,successful=True)

    def test_artifact_inputs_use_real_builder_filenames(self):
        source=SOURCE.read_text()
        for name in ('browser-disks/output/rootfs.ext4','browser-disks/output/state-template.ext4','kernel-build/output/kernel.bin'):
            self.assertIn(name,source)
        self.assertNotIn('browser-disks/output/root.ext4',source)


if __name__ == '__main__': unittest.main()
