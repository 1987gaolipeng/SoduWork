"""Personal plugin follow-ups preserve the original execution and durable identity."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.services import conversation_turn_plugins as plugins, runner_turn_plugins
from app.services import runner_comments, runner_admission, local_base, local_stream


class TurnPluginsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.selection = [{"pluginId": "local:plugin-builder", "checksum": "a" * 64}]

    def test_descriptor_rejects_bodies_paths_duplicates_and_wrong_checksums(self):
        self.assertEqual(plugins.normalize(self.selection), self.selection)
        for value in [[{**self.selection[0], "instructions": "untrusted"}],
                      [{"pluginId": "../other", "checksum": "a" * 64}],
                      [{"pluginId": "local:plugin-builder", "checksum": "old"}], self.selection * 2]:
            with self.assertRaises(HTTPException):
                plugins.normalize(value)

    def test_admission_id_binds_plugin_version_but_not_renewable_ticket(self):
        message = {"text": "same", "pluginTurn": {"authorization": "old", "args": {"plugins": self.selection}}}
        original = runner_admission.comment_digest("same-ref", message)
        message["pluginTurn"]["authorization"] = "renewed"
        self.assertEqual(original, runner_admission.comment_digest("same-ref", message))
        message["pluginTurn"]["args"]["plugins"] = [{**self.selection[0], "checksum": "b" * 64}]
        self.assertNotEqual(original, runner_admission.comment_digest("same-ref", message))

    async def test_wrong_account_and_cloud_runner_are_rejected(self):
        with self.assertRaises(HTTPException):
            await plugins.validate(None, SimpleNamespace(user_ref="other"),
                SimpleNamespace(phase="committed",owner_user_id="owner"), "ref", self.selection)
        with self.assertRaises(ValueError):
            await runner_turn_plugins.prepare(SimpleNamespace(desktop_owned=False),
                {"ref":"ref", "pluginTurn":{"operation":"plugin.prepare","args":{"ref":"ref"}}})

    async def test_runner_uses_native_workspace_and_records_only_user_text(self):
        ref = "existing-plugin-test"
        packet = {"operation":"plugin.prepare", "args":{"ref":ref,"plugins":self.selection}}
        native = {"ws":"native-workspace", "mode":"plan", "cfg":{"capabilityIds":["files"]}}
        result = {"promptText":"original + desktop-resolved instructions",
                  "plugins":[{"pluginId":"local:plugin-builder","name":"builder"}],
                  "resourceBundles":[{"key":"builder","resources":[]}]}
        pipe = SimpleNamespace(call=AsyncMock(return_value={"ok":True,"data":result}))
        machine = SimpleNamespace(desktop_owned=True,_desktop_capabilities=pipe)
        with patch.dict(local_base._RUNS,{ref:native}), \
             patch.object(local_stream,"record_user_sync",return_value={"ok":True}) as record, \
             patch.object(local_stream,"comment_sync",return_value={"ok":True}) as send:
            value = await runner_comments.comment(machine,
                {"ref":ref,"turnId":"one","text":"original","pluginTurn":packet,
                 "_admitted":True,"recordUser":True}, lambda *_:[])
        self.assertTrue(value["ok"])
        context = pipe.call.call_args.args[0]["_turnContext"]
        self.assertEqual(context["cwd"],"native-workspace")
        self.assertTrue(context["readOnly"])
        self.assertEqual(record.call_args.args[1],"original")
        self.assertEqual(send.call_args.args[1],ref)
        self.assertEqual(send.call_args.args[2],result["promptText"])
        self.assertEqual(send.call_args.args[0]["pluginResourceBundles"],result["resourceBundles"])

    async def test_plugin_prepare_failure_never_sends_an_unaugmented_turn(self):
        with patch.object(runner_turn_plugins,"prepare",AsyncMock(side_effect=ValueError("version changed"))), \
             patch.object(local_stream,"comment_sync") as send:
            result=await runner_comments.comment(SimpleNamespace(),
                {"ref":"ref","text":"original","turnId":"one","_admitted":True,"pluginTurn":{"args":{}}},lambda *_:[])
        self.assertFalse(result["ok"])
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
