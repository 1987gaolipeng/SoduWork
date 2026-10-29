"""Builtin Flash rows gain controllable thinking; custom configuration stays.

The one-time repair updates only untouched builtin definitions.
"""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.models import AppSetting, ModelDef, ModelProvider
from app.services import model_catalog
from test_model_runtime import IsolatedDatabase


class FlashThinkingUpgradeTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()

    def test_builtin_catalog_declares_controllable_flash(self):
        flash = next(item for item in model_catalog.BUILTIN_MODELS
                     if item["provider_id"] == "zhipu" and item["name"] == "glm-5.3-flash")
        config = model_catalog.clean_model_config(flash["config"], "chat")
        self.assertEqual(config["thinkingMode"], "controllable")
        self.assertTrue(config["reasoning"])
        self.assertNotIn("thinkingAlwaysOn", config)
        self.assertNotIn("off", config.get("thinkingLevelMap", {}))
        heavy = next(item for item in model_catalog.BUILTIN_MODELS
                     if item["provider_id"] == "zhipu" and item["name"] == "glm-5.3")
        self.assertEqual(model_catalog.clean_model_config(heavy["config"], "chat")["thinkingMode"],
                         "always", "重思考模型保持 always，本次只动 flash")

    async def test_builtin_always_row_is_upgraded_once(self):
        async with self.sessions() as session, session.begin():
            session.add(model_catalog.models.ModelDef(
                id="zhipu:glm-5.3-flash", provider_id="zhipu", name="glm-5.3-flash",
                builtin=True, enabled=True,
                config=model_catalog.clean_model_config(
                    model_catalog._always_thinking_config("zai"), "chat")))
        async with self.sessions() as session, session.begin():
            changed = await model_catalog._repair_builtin_flash_thinking_config(session)
        self.assertEqual(changed, 1)
        async with self.sessions() as session:
            row = await session.get(model_catalog.models.ModelDef, "zhipu:glm-5.3-flash")
            self.assertEqual(row.config["thinkingMode"], "controllable")
            self.assertNotIn("thinkingAlwaysOn", row.config)
            marker = await session.get(AppSetting,
                                       model_catalog.FLASH_THINKING_UPGRADE_FLAG)
            self.assertEqual(marker.value, "1")

    async def test_second_bootstrap_run_respects_marker(self):
        async with self.sessions() as session, session.begin():
            session.add(model_catalog.models.ModelDef(
                id="zhipu:glm-5.3-flash", provider_id="zhipu", name="glm-5.3-flash",
                builtin=True, enabled=True,
                config=model_catalog.clean_model_config(
                    model_catalog._always_thinking_config("zai"), "chat")))
        async with self.sessions() as session, session.begin():
            first = await model_catalog._repair_builtin_flash_thinking_config(session)
        self.assertEqual(first, 1)
        async with self.sessions() as session, session.begin():
            second = await model_catalog._repair_builtin_flash_thinking_config(session)
        self.assertEqual(second, 0, "marker 之后不得再次改写")

    async def test_admin_customized_config_is_not_overwritten(self):
        custom = {"thinkingMode": "controllable",
                  "thinkingFormat": "zai",
                  "thinkingLevelMap": {"off": None, "low": "low", "high": "high"},
                  "supportsReasoningEffort": False}
        async with self.sessions() as session, session.begin():
            session.add(model_catalog.models.ModelDef(
                id="zhipu:glm-5.3-flash", provider_id="zhipu", name="glm-5.3-flash",
                builtin=True, enabled=True,
                config=model_catalog.clean_model_config(custom, "chat")))
        async with self.sessions() as session, session.begin():
            changed = await model_catalog._repair_builtin_flash_thinking_config(session)
        self.assertEqual(changed, 0, "管理员改过的配置不许被迁移覆盖")

    async def test_admin_customizations_with_always_mode_are_preserved(self):
        legacy = model_catalog.clean_model_config(
            model_catalog._always_thinking_config("zai"), "chat")
        for customization in (
            {"supportsReasoningEffort": False},
            {"thinkingLevelMap": {"off": None, "low": "custom-low"}},
            {"defaults": {"temperature": 0.2}},
            {"maxOutputTokens": 4096},
            {"capabilities": {"toolCalling": "unsupported"}},
        ):
            with self.subTest(customization=customization):
                custom = model_catalog.clean_model_config(
                    {**legacy, **customization}, "chat")
                async with self.sessions() as session, session.begin():
                    await session.merge(ModelDef(
                        id="zhipu:glm-5.3-flash", provider_id="zhipu",
                        name="glm-5.3-flash", builtin=True, enabled=True,
                        config=custom))
                    marker = await session.get(
                        AppSetting, model_catalog.FLASH_THINKING_UPGRADE_FLAG)
                    if marker is not None:
                        await session.delete(marker)
                async with self.sessions() as session, session.begin():
                    changed = await model_catalog._repair_builtin_flash_thinking_config(session)
                self.assertEqual(changed, 0)
                async with self.sessions() as session:
                    row = await session.get(ModelDef, "zhipu:glm-5.3-flash")
                    self.assertEqual(row.config, custom)
                    marker = await session.get(
                        AppSetting, model_catalog.FLASH_THINKING_UPGRADE_FLAG)
                    self.assertEqual(marker.value, "0")


if __name__ == "__main__":
    unittest.main()
