"""Native usage remains device-owned until a reportable funding receipt exists."""
import asyncio
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from app.services import ai_local, local_base, local_stream, runner_admission, runner_usage_receipts
from runner_main import Runner


class RunnerUsageReceiptTests(unittest.TestCase):
    def test_unknown_legacy_model_identity_requires_positive_public_ownership(self):
        legacy = {"cli": "qwen", "model": "private-wire", "usage": {"total": 99}}
        raw = {"model": "private-wire", "error": "old private-wire diagnostic", "usage": {"total": 99}}
        self.assertTrue(runner_usage_receipts.private_model(legacy))
        projected = runner_usage_receipts.public_snapshot(raw, legacy)
        self.assertEqual(projected["model"], "")
        self.assertEqual(projected["usage"], {})
        self.assertNotIn("private-wire", json.dumps(projected))
        self.assertFalse(runner_usage_receipts.private_model({**legacy, "modelLocalOnly": False}))
        self.assertFalse(runner_usage_receipts.private_model({"cli": "codex", "model": "account-model"}))

    def test_mixed_calls_keep_funding_after_persistence(self):
        run = {"cli": "qwen", "cfg": {"llm": {"localOnly": True, "model": "private-wire"}},
               "model": "private-wire"}
        local_stream._accumulate_usage(run, {"input": 10, "output": 2})
        run["cfg"]["llm"] = {"model": "managed", "quotaVersion": 2,
                              "quotaUsageToken": "signed-managed", "quotaProvider": "hub-provider"}
        run["model"] = "managed"
        local_stream._accumulate_usage(run, {"input": 3, "output": 1})
        receipts = runner_usage_receipts.private_snapshot(run)
        self.assertEqual([row["usage"]["total"] for row in receipts], [12, 4])
        self.assertEqual(receipts[0]["model"], "")
        self.assertFalse(receipts[0]["reportable"])
        self.assertEqual(receipts[1]["quotaUsageToken"], "signed-managed")
        self.assertEqual(runner_usage_receipts.public_usage(run)["total_tokens"], 4)
        self.assertNotIn("private-wire", json.dumps(receipts))
        self.assertNotIn("signed-managed", json.dumps(runner_usage_receipts.public_usage(run)))
        with tempfile.TemporaryDirectory() as root, patch.object(local_base, "_STORE", root), \
                patch.dict(local_base._RUNS, {"fixture": run}):
            local_base._save_meta("fixture")
            restored = json.loads((Path(root) / "fixture" / "meta.json").read_text())
            self.assertEqual(runner_usage_receipts.private_snapshot(restored), receipts)
            self.assertEqual(runner_usage_receipts.public_usage(restored)["total_tokens"], 4)

    def test_legacy_unknown_totals_do_not_become_managed_receipts(self):
        run = {"cli": "kimi", "usage": {"total": 1000}, "usageReceipts": None,
               "cfg": {"llm": {"model": "managed"}}}
        self.assertEqual(runner_usage_receipts.private_snapshot(run), [])
        self.assertEqual(runner_usage_receipts.public_usage(run), {})
        local_stream._accumulate_usage(run, {"input": 2, "output": 1})
        self.assertEqual(run["usage"]["total"], 1003)
        self.assertEqual(runner_usage_receipts.public_usage(run)["total_tokens"], 3)

    def test_queued_model_cannot_reassign_active_or_recovered_usage(self):
        run = {"cli": "qwen", "cfg": {"llm": {"model": "private-wire", "localOnly": True}}}
        runner_usage_receipts.capture(run, run["cfg"])
        run["cfg"] = {"llm": {"model": "future-managed", "quotaVersion": 2,
                                "quotaUsageToken": "future-token"}}
        local_stream._accumulate_usage(run, {"input": 8, "output": 1})
        self.assertFalse(run["usageReceipts"][-1]["reportable"])
        self.assertNotIn("quotaUsageToken", run["usageReceipts"][-1])
        recovered = json.loads(json.dumps({key: run.get(key) for key in local_base._PERSIST_KEYS}))
        local_stream._accumulate_usage(recovered, {"input": 2, "output": 1})
        self.assertFalse(recovered["usageReceipts"][-1]["reportable"])
        self.assertTrue(runner_usage_receipts.sanitize_event(recovered, {"kind": "usage"})["localModelMetadata"])

    def test_public_usage_retains_cache_and_unknown_cost_semantics(self):
        from app.services.usage_values import normalize_usage
        run = {"usageReceipts": [{"usage": {"input": 10, "output": 2, "cacheRead": 4,
                "inputIncludesCache": True, "costKnown": False}},
                {"usage": {"input": 3, "output": 1, "cacheRead": 2,
                "inputIncludesCache": False, "cost": 0}}]}
        projected = runner_usage_receipts.public_usage(run)
        self.assertTrue(projected["input_includes_cache"])
        self.assertFalse(projected["cost_known"])
        normalized = normalize_usage(projected)
        self.assertEqual(normalized["input_tokens"], 15)
        self.assertEqual(normalized["total_tokens"], 18)
        self.assertEqual(normalized["cache_read_tokens"], 6)
        self.assertFalse(normalized["cost_known"])

    def test_device_funding_cannot_inherit_previous_token(self):
        run = {"cli": "opencode", "cfg": {"llm": {"model": "private-wire", "localOnly": True,
               "quotaVersion": 2, "quotaUsageToken": "previous-token", "quotaProvider": "provider"}}}
        local_stream._accumulate_usage(run, {"input": 2, "output": 1})
        self.assertNotIn("quotaUsageToken", runner_usage_receipts.private_snapshot(run)[0])
        self.assertEqual(runner_usage_receipts.public_usage(run), {})

    def test_provider_error_is_sanitized_before_native_archive(self):
        run = {"cli": "qwen", "seq": 0, "segment": 1, "metaAt": time.time(),
               "cfg": {"llm": {"model": "private-wire", "localOnly": True,
                                "base": "http://private-model.invalid/v1", "key": "fixture-secret"}}}
        with tempfile.TemporaryDirectory() as root, patch.object(local_base, "_STORE", root), \
                patch.dict(local_base._RUNS, {"fixture": run}):
            local_stream._on_line("fixture", json.dumps({"type": "error", "message":
                "provider echoed http://private-model.invalid/v1 private-wire fixture-secret"}), {})
            row = run["lines"][-1]
            self.assertTrue(row["localModelMetadata"])
            self.assertIn("Local model request failed", row["text"])
            self.assertNotIn("private-wire", json.dumps(row))
            self.assertNotIn("fixture-secret", json.dumps(row))
            archived = (Path(root) / "fixture" / "events.jsonl").read_text()
            self.assertNotIn("private-model.invalid", archived)
        normal = {"kind": "say", "text": "A regular response about the user's work."}
        self.assertEqual(runner_usage_receipts.sanitize_event(run, normal)["text"], normal["text"])
        warning = {"kind": "out", "tool": "", "text": "Warning: private-wire metadata is unavailable"}
        self.assertEqual(runner_usage_receipts.sanitize_event(run, warning)["text"],
                         "Warning: [local model] metadata is unavailable")

    def test_remote_projection_removes_local_model_and_per_event_usage(self):
        run = {"modelLocalOnly": True, "usageReceipts": [
            {"localOnly": True, "reportable": False, "usage": {"total": 99}}]}
        raw = {"model": "private-wire", "tokens": {"input": 99}, "usage": {"total": 99},
               "activeExecutionSelection": {"agentId": "qwen", "modelName": "private-wire"},
               "usageReceipts": [{"quotaUsageToken": "private-ticket"}],
               "items": [{"seq": 1, "kind": "usage", "localModelMetadata": True,
                          "usage": {"total": 99},
                          "_terminal": {"result": "private-wire private-ticket http://private.invalid"}}]}
        public = runner_usage_receipts.public_snapshot(raw, run)
        self.assertEqual(public["usage"], {})
        self.assertEqual(public["tokens"], {})
        self.assertEqual(public["activeExecutionSelection"]["modelName"], "")
        self.assertEqual(public["items"], [{"seq": 1, "kind": "usage"}])
        self.assertNotIn("private-wire", json.dumps(public))
        self.assertNotIn("private-ticket", json.dumps(public))
        self.assertEqual(raw["model"], "private-wire")

    def test_legacy_private_events_drop_usage_without_changing_user_content(self):
        content = {"model": "user-written-model", "usage": {"units": 42}}
        raw = {"usage": {"total": 99}, "items": [
            {"seq": 1, "kind": "usage", "usage": {"total": 99}, "tokens": {"input": 99}},
            {"seq": 2, "kind": "say", "text": "User-visible model and usage discussion", "arguments": content},
        ]}
        for run in ({"cli": "qwen", "model": "unknown-wire"}, {"modelLocalOnly": True}):
            with self.subTest(run=run):
                projected = runner_usage_receipts.public_snapshot(raw, run)
                self.assertNotIn("usage", projected["items"][0])
                self.assertNotIn("tokens", projected["items"][0])
                self.assertEqual(projected["items"][1]["text"], raw["items"][1]["text"])
                self.assertEqual(projected["items"][1]["arguments"], content)
        managed = {"modelLocalOnly": False, "usageReceipts": [{"localOnly": False,
                   "reportable": True, "usage": {"input": 7, "output": 2}}]}
        projected = runner_usage_receipts.public_snapshot(raw, managed)
        self.assertEqual(projected["items"][0], raw["items"][0])
        self.assertEqual(projected["usage"]["total_tokens"], 9)

    def test_source_private_errors_stay_private_after_the_run_is_removed(self):
        private = {runner_usage_receipts.PRIVACY_MARKER: True,
                   'model': 'private-wire', 'error': 'provider echoed private-wire fixture-key'}
        for wrapped in (False, True):
            with self.subTest(wrapped=wrapped):
                raw = {'data': private} if wrapped else private
                original = copy.deepcopy(raw)
                projected = runner_usage_receipts.public_snapshot(raw, {})
                self.assertNotIn('private-wire', json.dumps(projected))
                self.assertNotIn('fixture-key', json.dumps(projected))
                self.assertNotIn(runner_usage_receipts.PRIVACY_MARKER, json.dumps(projected))
                self.assertEqual(raw, original)
        diagnostic = {'ok': False, 'error': 'Session not found'}
        self.assertEqual(runner_usage_receipts.public_snapshot(diagnostic, {}), diagnostic)


class RunnerSnapshotOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(prefix='runner-snapshot-ownership-'))
        self.ref = 'owned-snapshot-fixture'
        self.run = {}
        self.enterContext(patch.dict(local_base._RUNS, {self.ref: self.run}, clear=True))
        self.enterContext(patch.object(local_base, '_STORE', self.folder))
        self.enterContext(patch.object(ai_local, '_STORE', self.folder))

    def local_turn(self, model):
        self.run.clear()
        self.run.update(cli='opencode', cliSid='ses_fixture', taskId='fixture-task', title='Fixture',
            ws=self.folder, state='done', seq=0, lines=[], segment=1, round=1, model=model,
            modelLocalOnly=True, cfg={'llm': {'localOnly': True, 'model': model}},
            activeUsageOwner={'localOnly': True}, usageReceipts=[], usage={}, tokens={},
            ctxWindow=8192, ctxWindowKnown=True, error='Private diagnostic for ' + model,
            contextReport={'model': model})

    def hub_turn(self, model):
        with local_base._LOCK:
            self.run.update(model=model, modelLocalOnly=False, round=2,
                cfg={'llm': {'localOnly': False, 'model': model, 'key': 'fixture',
                              'base': 'http://127.0.0.1:1/v1'}},
                activeUsageOwner={'localOnly': False, 'model': model}, error='', contextReport={'model': model})

    def machine(self):
        machine = Runner.__new__(Runner)
        machine._agent_inventory, machine._session_marks = [], {}
        machine._admission = runner_admission.AdmissionQueue()
        return machine

    def test_source_ownership_survives_a_later_hub_turn_even_with_the_same_model_name(self):
        collectors = [lambda: ai_local.session_sync({}, self.ref),
                      lambda: ai_local.runner_info_sync({}, self.ref),
                      lambda: ai_local.console_list_sync({})['runs'][0],
                      lambda: ai_local.status_sync({}, self.ref)]
        for local_model in ('private-wire-fixture', 'shared-model-name'):
            for collect in collectors:
                with self.subTest(model=local_model, collector=collectors.index(collect)):
                    self.local_turn(local_model)
                    raw = collect()
                    original = copy.deepcopy(raw)
                    self.assertIs(raw[runner_usage_receipts.PRIVACY_MARKER], True)
                    self.hub_turn('shared-model-name')
                    projected = runner_usage_receipts.public_snapshot({'data': raw}, self.run)['data']
                    if 'model' in projected:
                        self.assertEqual(projected['model'], '')
                    else:
                        self.assertEqual(projected['contextReport']['model'], '')
                    self.assertNotIn(runner_usage_receipts.PRIVACY_MARKER, json.dumps(projected))
                    if 'ctxWindow' in projected:
                        self.assertEqual(projected['ctxWindow'], 0)
                        self.assertFalse(projected['ctxWindowKnown'])
                    self.assertEqual(raw, original, 'Remote projection mutated the private snapshot')

    def test_managed_snapshot_retains_public_model_context_and_reportable_usage(self):
        self.local_turn('hub-model')
        self.hub_turn('hub-model')
        self.run.update(tokens={'input': 7}, usageReceipts=[{'localOnly': False,
            'reportable': True, 'model': 'hub-model', 'usage': {'input': 7, 'output': 2}}])
        raw = ai_local.session_sync({}, self.ref)
        original = copy.deepcopy(raw)
        self.assertIs(raw[runner_usage_receipts.PRIVACY_MARKER], False)
        projected = runner_usage_receipts.public_snapshot(raw, self.run)
        self.assertEqual(projected['model'], 'hub-model')
        self.assertEqual(projected['tokens'], {'input': 7})
        self.assertEqual(projected['ctxWindow'], 8192)
        self.assertTrue(projected['ctxWindowKnown'])
        self.assertEqual(projected['usage']['total_tokens'], 9)
        self.assertNotIn(runner_usage_receipts.PRIVACY_MARKER, projected)
        self.assertEqual(raw, original)

    def test_remote_rpc_cannot_reclassify_a_snapshot_after_a_local_to_hub_switch(self):
        for model in ('private-wire-fixture', 'shared-model-name'):
            for operation, name in (('job.session', 'session_sync'), ('job.info', 'runner_info_sync'),
                                    ('job.status', 'status_sync')):
                with self.subTest(model=model, operation=operation):
                    self.local_turn(model)
                    collect = getattr(ai_local, name)
                    captured = []
                    def collect_and_switch(*args, **kwargs):
                        raw = collect(*args, **kwargs)
                        captured.append((raw, copy.deepcopy(raw)))
                        self.hub_turn('shared-model-name')
                        return raw
                    with patch.object(ai_local, name, side_effect=collect_and_switch):
                        result = asyncio.run(self.machine()._job({'op': operation, 'ref': self.ref}))
                    if operation == 'job.status':
                        self.assertEqual(result['data']['contextReport']['model'], '')
                    else:
                        self.assertEqual(result['data']['model'], '')
                    self.assertNotIn(runner_usage_receipts.PRIVACY_MARKER, json.dumps(result))
                    if operation == 'job.session':
                        # The Runner adds its existing authorization hint before
                        # projection; all captured private metadata stays intact.
                        captured[0][1]['authorizationRequired'] = False
                    self.assertEqual(captured[0][0], captured[0][1])

    def test_status_captures_private_diagnostics_before_slow_output_discovery(self):
        self.local_turn('private-wire-fixture')
        def discover(_):
            self.hub_turn('hub-model')
            return []
        with patch.object(ai_local, '_fresh_entries', side_effect=discover):
            raw = ai_local.status_sync({}, self.ref)
        self.assertIs(raw[runner_usage_receipts.PRIVACY_MARKER], True)
        self.assertIn('private-wire-fixture', raw['error'])
        self.assertEqual(raw['contextReport']['model'], 'private-wire-fixture')
        projected = runner_usage_receipts.public_snapshot(raw, self.run)
        self.assertNotIn('private-wire-fixture', json.dumps(projected))
        self.assertNotIn(runner_usage_receipts.PRIVACY_MARKER, projected)

    def test_hub_collection_cannot_publish_old_console_metadata_after_a_switch(self):
        for model in ('private-wire-fixture', 'shared-model-name'):
            with self.subTest(model=model):
                self.local_turn(model)
                collect = ai_local.console_list_sync
                captured = []
                def collect_and_switch(*args, **kwargs):
                    raw = collect(*args, **kwargs)
                    captured.append((raw, copy.deepcopy(raw)))
                    self.hub_turn('shared-model-name')
                    return raw
                with patch.object(ai_local, 'console_list_sync', side_effect=collect_and_switch):
                    snapshots, _ = self.machine()._session_snapshots()
                snapshot = snapshots[0]
                self.assertEqual(snapshot['model'], '')
                self.assertEqual(snapshot['tokens'], {})
                self.assertEqual(snapshot['ctxWindow'], 0)
                self.assertFalse(snapshot['ctxWindowKnown'])
                self.assertEqual(snapshot['usage'], {})
                self.assertNotIn(runner_usage_receipts.PRIVACY_MARKER, json.dumps(snapshots))
                self.assertEqual(captured[0][0], captured[0][1])


if __name__ == "__main__":
    unittest.main()
