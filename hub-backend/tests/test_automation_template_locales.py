"""Optional per-locale template fields survive normalization, storage and rejects."""
import asyncio
import os
import unittest

os.environ.setdefault("AUTH_SECRET", "isolated-template-locales-secret")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models
from app.services import automation_templates


class AutomationTemplateLocalesTests(unittest.TestCase):
    def test_locales_roundtrip_through_normalization(self):
        item = automation_templates.normalize({
            "id": "daily-report", "name": "每日工作总结", "title": "每日工作总结",
            "description": "每天整理今日任务、风险和明日计划",
            "note": "汇总我今天的任务进展。",
            "nameLocales": {"en-US": "Daily work summary", "ja-JP": "毎日の作業まとめ"},
            "descriptionLocales": {"en-US": "Summarize today’s work, risks and tomorrow’s plan each day"},
            "noteLocales": {"en-US": "Summarize today’s task progress."},
            "titleLocales": {},
            "every": "daily",
        })
        self.assertEqual(item["nameLocales"]["en-US"], "Daily work summary")
        self.assertEqual(item["nameLocales"]["ja-JP"], "毎日の作業まとめ")
        self.assertEqual(item["descriptionLocales"]["en-US"],
                         "Summarize today’s work, risks and tomorrow’s plan each day")
        self.assertEqual(item["noteLocales"], {"en-US": "Summarize today’s task progress."})
        self.assertEqual(item["titleLocales"], {})

    def test_legacy_templates_get_empty_maps(self):
        item = automation_templates.normalize({"id": "plain", "name": "业务巡检", "note": "打开页面检查。"},
                                              require_name=False)
        for field in ("nameLocales", "titleLocales", "descriptionLocales", "noteLocales"):
            self.assertEqual(item[field], {})

    def test_empty_and_whitespace_translations_are_dropped(self):
        item = automation_templates.normalize({
            "id": "daily-report", "name": "每日工作总结",
            "nameLocales": {"en-US": "  ", "ja-JP": "毎日の作業まとめ", "": "oops"},
        }, require_name=False)
        self.assertEqual(item["nameLocales"], {"ja-JP": "毎日の作業まとめ"})

    def test_bad_shapes_are_rejected(self):
        cases = [
            {"id": "x", "name": "模板", "nameLocales": ["en-US"]},          # not a dict
            {"id": "x", "name": "模板", "nameLocales": {"bad tag!": "Hi"}},  # bad tag
            {"id": "x", "name": "模板",
             "nameLocales": {f"xx-{i}": "t" for i in range(9)}},             # too many
        ]
        for raw in cases:
            with self.assertRaises(ValueError):
                automation_templates.normalize(raw, require_name=False)

    def test_save_and_load_preserve_locales(self):
        async def scenario():
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            async with engine.begin() as connection:
                await connection.run_sync(models.Base.metadata.create_all)
            session_maker = async_sessionmaker(engine, expire_on_commit=False)
            async with session_maker() as session:
                await automation_templates.save(session, [{
                    "id": "daily-report", "name": "每日工作总结", "note": "汇总。",
                    "nameLocales": {"en-US": "Daily work summary", "zh-CN": "每日工作总结"},
                    "noteLocales": {"en-US": "Summarize today’s task progress."},
                }])
                await session.commit()
            async with session_maker() as session:
                loaded = await automation_templates.load(session)
            await engine.dispose()
            return loaded

        loaded = asyncio.run(scenario())
        self.assertEqual(loaded[0]["nameLocales"]["en-US"], "Daily work summary")
        # zh-CN copies are allowed but pointless; clients read the base field for zh.
        self.assertEqual(loaded[0]["nameLocales"]["zh-CN"], "每日工作总结")
        self.assertEqual(loaded[0]["noteLocales"], {"en-US": "Summarize today’s task progress."})


if __name__ == "__main__":
    unittest.main()
