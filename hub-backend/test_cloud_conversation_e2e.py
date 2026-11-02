"""Cross-device cloud conversation E2E using the real Hub and Runner fixture."""
import json
import unittest

import test_conversation_handoffs as fixture
from app import db, models
from app.api import cloud_conversations
from app.services import device_auth, runner_hub


class CloudConversationE2ETests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = fixture.HandoffTests("test_security_two_phase_real_execution_and_restart")
        await self.fixture.asyncSetUp()
        self.http = self.fixture.http
        self.fixture.app.include_router(cloud_conversations.router)

    async def asyncTearDown(self):
        await self.fixture.asyncTearDown()

    async def create(self, request_id, **changes):
        body = {"sessionId": "cloud-" + request_id, "agentId": "codex", "model": "",
                "title": "Cross-device E2E", "text": "CLOUD_NEW_TEST: create a report",
                "requiredSkills": [], **changes}
        return await self.http.post("/api/v1/cloud-conversations/" + request_id,
            data={"options": json.dumps(body)})

    async def test_mobile_to_work_computer_directory_and_transcript(self):
        """Mobile submission is executed and replayed from a same-account desktop."""
        from app.automation_models import RunnerNode

        desktop = models.Client(id="u-e2e-desktop", user_ref=self.fixture.owner.id,
                                auth_state="active")
        async with db.SessionLocal() as session:
            session.add(desktop)
            node = await session.get(RunnerNode, "cloud")
            node.client_id = desktop.id
            await session.commit()

        runner = self.fixture.runner
        runner.client_id = desktop.id
        runner.tags = [runner_hub.CLIENT_TAG]

        targets = await self.http.get("/api/v1/conversation-handoffs/targets?agentId=codex")
        self.assertEqual(targets.status_code, 200, targets.text)
        target = next((item for item in targets.json()["targets"]
                       if item.get("runnerKind") == "work-computer"), None)
        self.assertIsNotNone(target, targets.text)
        self.assertEqual(target["runnerId"], runner.id)

        mobile_request = await self.create(
            "mobile-work-computer-e2e",
            targetRunnerId=target["runnerId"],
            targetRunnerKind="work-computer",
            text="CLOUD_NEW_TEST: create the report on my work computer",
        )
        self.assertEqual(mobile_request.status_code, 200, mobile_request.text)
        receipt = mobile_request.json()
        self.assertEqual(receipt["target"]["runnerId"], runner.id, receipt)
        self.assertEqual(receipt["target"]["runnerKind"], "work-computer", receipt)

        await self.fixture.complete(receipt["ref"])

        desktop_headers = {"Authorization": "Device " + device_auth.issue_session(desktop)[0]}
        directory = await self.http.get("/api/v1/cloud-conversations", headers=desktop_headers)
        self.assertEqual(directory.status_code, 200, directory.text)
        row = next((item for item in directory.json()["chats"]
                    if item.get("taskId") == receipt["taskId"]), None)
        self.assertIsNotNone(row, directory.text)
        self.assertEqual(row["ref"], receipt["ref"], row)
        self.assertEqual(row["runnerKind"], "work-computer", row)
        self.assertTrue(row["remoteProjection"], row)
        self.assertFalse(row["readOnly"], row)
        self.assertTrue(row["canContinue"], row)
        self.assertTrue(row["canSend"], row)

        follow = await self.http.post(
            f'/api/v1/tasks/{receipt["taskId"]}/ai-say',
            headers=desktop_headers,
            json={"text": "Continue the report from desktop.", "messageId": "desktop-follow-up"},
        )
        self.assertEqual(follow.status_code, 200, follow.text)
        self.assertEqual(follow.json()["delivery"], "accepted", follow.text)
        await self.fixture.complete(receipt["ref"])

        replay = await self.http.get(
            f'/api/v1/tasks/{receipt["taskId"]}/ai-session?ref={receipt["ref"]}',
            headers=desktop_headers,
        )
        self.assertEqual(replay.status_code, 200, replay.text)
        users = [item for item in replay.json()["items"] if item.get("kind") == "user"]
        self.assertEqual([item["text"] for item in users],
                         ["CLOUD_NEW_TEST: create the report on my work computer",
                          "Continue the report from desktop."], replay.text)

        foreign_headers = {"Authorization": "Device " + self.fixture.other_token}
        foreign_directory = await self.http.get("/api/v1/cloud-conversations", headers=foreign_headers)
        self.assertEqual(foreign_directory.status_code, 200, foreign_directory.text)
        self.assertFalse(any(item.get("taskId") == receipt["taskId"]
                             for item in foreign_directory.json()["chats"]), foreign_directory.text)


if __name__ == "__main__":
    unittest.main()
