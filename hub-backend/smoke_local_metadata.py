"""Concurrent metadata persistence on real temporary files; no business calls."""
from __future__ import annotations

import builtins
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix="soduwork-metadata-tests-")
os.environ["SODUWORK_DATA_ROOT"] = DATA.name
from app.services import access_policy, access_transition, local_base, local_stream


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-meta-case-")
        self.store = patch.object(local_base, "_STORE", self.temp.name)
        self.store.start()
        self.ref = "isolated-metadata"
        self.policy = access_policy.normalize({"schema": access_policy.SCHEMA,
            "mode": "standard", "revision": 1, "workspaceRoot": self.temp.name})
        self.run = {"cli": "qwen", "state": "done", "ws": self.temp.name,
                    "accessPolicy": self.policy, "seq": 1}
        acquired = local_base._LOCK.acquire(timeout=2)
        self.assertTrue(acquired, "A preceding fixture left the runtime lock held")
        try:
            local_base._RUNS[self.ref] = self.run
        finally:
            local_base._LOCK.release()

    def tearDown(self):
        acquired = local_base._LOCK.acquire(timeout=2)
        if acquired:
            try:
                local_base._RUNS.pop(self.ref, None)
            finally:
                local_base._LOCK.release()
        self.store.stop()
        self.temp.cleanup()

    def saved(self):
        return json.loads((Path(self.temp.name) / self.ref / "meta.json").read_text(encoding="utf-8"))

    def test_overlapping_callers_never_overlap_writes_or_regress_revision(self):
        gate = threading.Barrier(12)
        counter = threading.Lock()
        active = peak = 0
        writes, failures = [], []
        real_open = builtins.open
        class TrackedFile:
            def __init__(inner, *args, **kwargs):
                inner.args, inner.kwargs = args, kwargs
            def __enter__(inner):
                nonlocal active, peak
                with counter:
                    active += 1
                    peak = max(peak, active)
                time.sleep(.002)  # expose a real overlapping filesystem window
                inner.handle = real_open(*inner.args, **inner.kwargs)
                return inner
            def write(inner, blob):
                writes.append(json.loads(blob)["accessPolicy"]["revision"])
                return inner.handle.write(blob)
            def __exit__(inner, *args):
                nonlocal active
                try:
                    inner.handle.close()
                finally:
                    with counter:
                        active -= 1
        def save_many():
            try:
                gate.wait(4)
                for _ in range(10):
                    with local_base._LOCK:
                        self.run["accessPolicy"] = {**self.run["accessPolicy"],
                            "revision": self.run["accessPolicy"]["revision"] + 1}
                    local_base._save_meta(self.ref)
            except BaseException as error:
                failures.append(error)
        workers = [threading.Thread(target=save_many, daemon=True) for _ in range(12)]
        with patch.object(local_base, "open", TrackedFile, create=True), patch.object(local_base.log, "warning") as warning:
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(12)
            self.assertFalse(any(worker.is_alive() for worker in workers))
            self.assertEqual(failures, [])
            warning.assert_not_called()
        self.assertEqual(peak, 1)
        self.assertEqual(len(writes), 120)
        self.assertEqual(writes, sorted(writes))
        self.assertEqual(self.saved()["accessPolicy"]["revision"], 121)

    def test_a_slow_old_snapshot_cannot_overwrite_the_newer_policy(self):
        entered, release, newer_saved = threading.Event(), threading.Event(), threading.Event()
        real_open = builtins.open
        def slow_first_open(*args, **kwargs):
            if threading.current_thread().name == "old-snapshot":
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("Fixture failed to release writer")
            return real_open(*args, **kwargs)
        def newer():
            with local_base._LOCK:
                self.run["accessPolicy"] = {**self.policy, "mode": "readonly", "revision": 2}
            local_base._save_meta(self.ref)
            newer_saved.set()
        old = threading.Thread(target=lambda: local_base._save_meta(self.ref), name="old-snapshot", daemon=True)
        new = threading.Thread(target=newer, daemon=True)
        with patch.object(local_base, "open", slow_first_open, create=True):
            old.start()
            self.assertTrue(entered.wait(3))
            new.start()
            # The old write must complete before the new state can commit.
            self.assertFalse(newer_saved.wait(.08))
            release.set()
            old.join(5); new.join(5)
        self.assertFalse(old.is_alive() or new.is_alive())
        self.assertEqual(self.saved()["accessPolicy"]["revision"], 2)
        self.assertEqual(self.saved()["accessPolicy"]["mode"], "readonly")

    def test_nested_save_and_idle_permission_change_are_reentrant_and_persisted(self):
        results = []
        def change():
            with local_base._LOCK:
                local_base._save_meta(self.ref)
            results.append(access_transition.apply(self.ref,
                {**self.policy, "mode": "full", "revision": 2}, 1))
        worker = threading.Thread(target=change, daemon=True)
        worker.start(); worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(results[0]["ok"], results)
        self.assertEqual(results[0]["effective"], "current-turn")
        saved = self.saved()
        self.assertEqual(saved["accessPolicy"]["mode"], "full")
        self.assertEqual(saved["accessPolicy"]["revision"], 2)

    def test_natural_completion_change_settles_and_persists_without_nested_deadlock(self):
        from app.services import ai_local, local_completion, local_turn_outcome
        self.run.update(state="running", cliSid="preserved-native", started=time.time(),
                        lines=[], queue=[], cfg={"accessPolicy": self.policy})
        results = []
        worker = threading.Thread(target=lambda: results.append(access_transition.apply(self.ref,
            {**self.policy, "mode": "full", "revision": 2}, 1, timeout=4)), daemon=True)
        # Exercise real transition -> real _finish -> nested metadata save.
        # Stub only unrelated completion assessment and repository inspection.
        with patch.object(local_completion, "assess", return_value={}), \
             patch.object(local_turn_outcome, "recovery", return_value={}), \
             patch.object(ai_local, "_git_delivery", return_value=None):
            worker.start()
            deadline = time.monotonic() + 2
            while not self.run.get("_accessTransition") and time.monotonic() < deadline:
                time.sleep(.01)
            change = self.run.get("_accessTransition")
            self.assertIsNotNone(change)
            access_transition.control(self.ref, self.policy, {"stage": "ready", "id": change["id"],
                "sessionId": "preserved-native", "completed": True})
            self.assertTrue(access_transition.finish(self.ref, 0, ""))
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(results[0]["ok"], results)
        self.assertEqual(self.run["state"], "done")
        saved = self.saved()
        self.assertEqual(saved["state"], "done")
        self.assertEqual(saved["accessPolicy"]["mode"], "full")
        self.assertEqual(saved["accessPolicy"]["revision"], 2)

    def test_user_stop_at_access_changing_boundary_saves_without_nested_deadlock(self):
        self.run.update(state="access-changing", queue=["must be cancelled"],
                        _accessTransition={"phase": "ready", "id": "fixture"})
        results = []
        worker = threading.Thread(target=lambda: results.append(local_stream.stop_sync({}, self.ref)), daemon=True)
        worker.start(); worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(results[0]["ok"], results)
        self.assertEqual(self.run["queue"], [])
        self.assertTrue(self.run["_accessTransition"]["cancelled"])
        self.assertEqual(self.saved()["state"], "stopped")
        self.assertEqual(self.saved()["accessPolicy"], self.policy)

    def test_terminal_state_is_durable_before_slow_delivery_inspection(self):
        from app.services import ai_local, local_completion, local_dialogue_outcome
        from app.services import local_turn_outcome
        for code, expected in ((0, "done"), (1, "failed")):
            with self.subTest(state=expected):
                self.run.update(state="running", started=time.time(), lines=[], queue=[],
                                cfg={}, round=7, admissionKey="comment:latest-turn")
                local_base._save_meta(self.ref)
                inspected = []
                def inspect(_run):
                    # A restart may occur while repository inspection is still pending.
                    # The public terminal state must already exist in the durable archive.
                    with local_base._LOCK:
                        self.assertEqual(self.run["state"], expected)
                    saved = self.saved()
                    self.assertEqual(saved["state"], expected)
                    self.assertEqual(saved["round"], 7)
                    self.assertEqual(saved["admissionKey"], "comment:latest-turn")
                    self.assertEqual(saved["exit"], code)
                    self.assertGreater(saved["ended"], 0)
                    inspected.append(True)
                with patch.object(local_completion, "assess", return_value={}), \
                     patch.object(local_turn_outcome, "recovery", return_value={}), \
                     patch.object(local_dialogue_outcome, "failure", return_value={}), \
                     patch.object(ai_local, "_git_delivery", side_effect=inspect):
                    local_stream._finish(self.ref, code, {}, "")
                self.assertEqual(inspected, [True])


if __name__ == "__main__":
    unittest.main()
