"""Lifecycle summaries follow current task facts without rewriting audit evidence."""
import copy
import unittest

from app.services import task_execution_contract as contract


class TaskTraceLifecycleTests(unittest.TestCase):
    def project(self, task, *, runs=None, sessions=None, approvals=None, artifacts=None, timeline=None):
        sessions, approvals, artifacts = sessions or [], approvals or [], artifacts or []
        stages = contract.build_stages(task, runs or [], sessions, approvals, [], artifacts, [], timeline=timeline)
        before = copy.deepcopy(stages)
        view = contract.summary(stages, [], sessions, approvals, [], artifacts, [],
                                task=task, timeline=timeline)
        self.assertEqual(stages, before)
        self.assertEqual(view["lifecycle"]["progress"]["total"], 4)
        return view["lifecycle"], stages

    def test_new_requirement_waits_to_start_instead_of_declaring_completion(self):
        view, _ = self.project({"kind": "requirement", "status": "todo", "triageStage": "ready"})
        self.assertEqual(view["state"], "planned")
        self.assertEqual(view["progress"]["done"], 1)
        self.assertEqual(view["nextAction"], "安排执行")
        stages = contract.build_stages({"status": "todo"}, [], [], [], [], [], [])
        self.assertNotEqual(contract.summary(stages, [], [], [], [], [], [])["nextAction"], "已完成")

    def test_manual_submission_requires_review_and_completed_requirement_is_full(self):
        view, stages = self.project({"kind": "requirement", "status": "done"})
        self.assertEqual(view["state"], "waiting_human")
        self.assertEqual(view["title"], "等待验收")
        self.assertEqual(view["progress"]["done"], 2)
        self.assertEqual([row["state"] for row in stages], ["succeeded", "succeeded", "waiting_human", "planned"])
        view, stages = self.project({"kind": "requirement", "status": "done", "reviewedAt": 10})
        self.assertEqual(view["state"], "succeeded")
        self.assertEqual(view["progress"]["done"], 4)
        self.assertEqual(view["title"], "需求已完成")
        self.assertTrue(all(not row["evidence"] and not row["decisions"] for row in stages))

    def test_authoritative_completion_does_not_rewrite_stale_ai_receipts(self):
        for old_state in ["running", "failed", "interrupted"]:
            with self.subTest(old_state=old_state):
                view, stages = self.project(
                    {"kind": "requirement", "status": "done", "reviewedAt": 10},
                    sessions=[{"ref": "old", "status": old_state}])
                self.assertEqual(view["progress"]["done"], 4)
                self.assertEqual(view["state"], "succeeded")
                self.assertEqual(stages[1]["sessions"][0]["status"], old_state)
                self.assertEqual(stages[2]["decisions"], [])
                self.assertTrue(all(row["state"] == "succeeded" for row in stages))

    def test_current_review_overrides_stale_running_session(self):
        view, _ = self.project({"kind": "requirement", "status": "doing", "requirementStage": "reviewing"},
                               sessions=[{"status": "running"}])
        self.assertEqual(view["state"], "waiting_human")
        self.assertEqual(view["progress"]["done"], 2)

    def test_reopened_direct_stages_keep_receipts_but_reset_current_milestones(self):
        receipt = {"status": "done", "startedAt": 1}
        view, stages = self.project({"kind": "requirement", "status": "todo", "actualEnd": 2}, sessions=[receipt])
        self.assertEqual([row["state"] for row in stages], ["succeeded", "planned", "planned", "planned"])
        self.assertEqual(stages[1]["sessions"], [receipt])
        self.assertEqual(view["progress"]["done"], 1)

    def test_reopened_task_does_not_inherit_completed_workflow_progress(self):
        run = {"id": "past", "state": "succeeded", "workflow": [{"key": "build", "type": "ai"}],
               "nodes": [{"id": "build", "key": "build", "type": "ai", "state": "succeeded", "finishedAt": 5}]}
        for status, expected in [("todo", "planned"), ("doing", "running")]:
            with self.subTest(status=status):
                view, stages = self.project({"kind": "requirement", "status": status, "triageStage": "ready", "actualEnd": 10},
                                           runs=[run])
                self.assertEqual(view["state"], expected)
                self.assertEqual(view["progress"]["done"], 1)
                self.assertEqual(stages[0]["state"], "succeeded")

    def test_live_workflow_uses_actual_stage_and_four_lifecycle_milestones(self):
        run = {"id": "live", "state": "running", "workflow": [{"key": "verify", "type": "quality"}],
               "nodes": [{"id": "verify", "key": "verify", "type": "quality", "name": "检查结果", "state": "running"}]}
        view, _ = self.project({"kind": "requirement", "status": "doing"}, runs=[run])
        self.assertEqual(view["title"], "检查结果")
        self.assertEqual(view["state"], "running")
        self.assertEqual(view["progress"]["done"], 2)

    def test_finished_ai_execution_waits_for_result_confirmation(self):
        view, _ = self.project({"kind": "requirement", "status": "doing"}, sessions=[{"status": "done"}])
        self.assertEqual(view["state"], "waiting_human")
        self.assertEqual(view["title"], "结果待确认")
        self.assertEqual(view["progress"]["done"], 2)

    def test_verified_workflow_waits_for_delivery_without_claiming_completion(self):
        run = {"id": "live", "state": "running", "workflow": [
            {"key": "verify", "type": "quality"}, {"key": "deliver", "type": "publish"}],
            "nodes": [{"id": "verify", "key": "verify", "type": "quality", "state": "succeeded"}]}
        view, _ = self.project({"kind": "requirement", "status": "doing"}, runs=[run])
        self.assertEqual(view["state"], "planned")
        self.assertEqual(view["title"], "等待交付")
        self.assertEqual(view["progress"]["done"], 3)

    def test_reopened_ai_task_does_not_revive_a_pre_completion_session(self):
        view, _ = self.project({"kind": "requirement", "status": "doing", "actualEnd": 200},
                               sessions=[{"status": "failed", "startedAt": 100, "finishedAt": 150}])
        self.assertEqual(view["state"], "running")
        self.assertEqual(view["title"], "执行工作")
        self.assertEqual(view["progress"]["done"], 1)

    def test_rejected_review_and_cancelled_task_never_report_completion(self):
        view, _ = self.project({"kind": "requirement", "status": "doing", "reviewRejected": True})
        self.assertEqual(view["state"], "rework")
        self.assertEqual(view["progress"]["done"], 1)
        view, _ = self.project({"kind": "requirement", "status": "cancel"})
        self.assertEqual(view["state"], "cancelled")
        self.assertLess(view["progress"]["done"], 4)

    def test_accepted_work_awaits_delivery_instead_of_restarting_execution(self):
        for project in [None, "project-1"]:
            with self.subTest(project=project):
                view, stages = self.project({"kind": "requirement", "status": "doing", "reviewedAt": 100,
                                             "projectId": project}, sessions=[{"status": "done", "startedAt": 50}])
                self.assertEqual(view["progress"]["done"], 3)
                self.assertEqual(view["title"], "验收已通过，等待交付")
                self.assertEqual([row["state"] for row in stages], ["succeeded", "succeeded", "succeeded", "planned"])

    def test_latest_reopening_distinguishes_old_acceptance_from_new_acceptance(self):
        events = [{"kind": "task.execution_started", "at": 200, "detail": {"from": "done", "to": "todo"}}]
        task = {"kind": "requirement", "status": "doing", "actualEnd": 100, "reviewedAt": 150}
        view, _ = self.project(task, timeline=events)
        self.assertEqual(view["progress"]["done"], 1)
        view, stages = self.project({**task, "reviewedAt": 300}, timeline=events)
        self.assertEqual(view["progress"]["done"], 3)
        self.assertEqual(stages[2]["state"], "succeeded")

    def test_new_ai_attempt_can_advance_after_a_previous_completion(self):
        events = [{"kind": "task.execution_started", "at": 200, "detail": {"from": "done", "to": "doing"}}]
        view, _ = self.project({"kind": "requirement", "status": "doing", "actualEnd": 100}, timeline=events,
                               sessions=[{"status": "done", "startedAt": 250, "finishedAt": 300}])
        self.assertEqual(view["progress"]["done"], 2)
        self.assertEqual(view["state"], "waiting_human")

    def test_paused_work_retains_proven_milestones_without_claiming_completion(self):
        for completed, fields, sessions in [
            (1, {}, []),
            (2, {}, [{"status": "done"}]),
            (3, {"reviewedAt": 100}, [{"status": "done", "startedAt": 50}]),
        ]:
            with self.subTest(completed=completed):
                view, stages = self.project({"kind": "requirement", "status": "paused", **fields}, sessions=sessions)
                self.assertEqual(view["progress"]["done"], completed)
                self.assertEqual(view["state"], "blocked")
                self.assertEqual(view["title"], "执行已暂停")
                self.assertEqual(view["nextAction"], "处理阻断后继续执行")
                self.assertEqual(stages[-1]["state"], "planned")
                if completed == 3:
                    self.assertEqual(stages[2]["state"], "succeeded")


if __name__ == "__main__":
    unittest.main()
