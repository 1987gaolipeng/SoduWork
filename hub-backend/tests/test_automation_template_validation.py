"""Identity validation rejects malformed writes before mutating the template catalog."""
import asyncio
import os
import unittest
os.environ.setdefault("AUTH_SECRET", "isolated-template-validation-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-template-validation-admin")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models
from app.services import automation_templates as templates

VALID = {"id": "daily-report", "name": "日报", "note": "Keep instructions"}
INVALID = [
    ({"id": ""}, "请填写模板标识"), ({"id": "a"}, "2–64"),
    ({"id": "a" * 65}, "2–64"), ({"id": "Daily-Report"}, "小写"),
    ({"id": " daily-report"}, "空格"), ({"id": "daily-report\n"}, "空格"),
    ({"id": "_daily"}, "开头"), ({"id": "每日"}, "小写"),
    ({"id": "daily/report"}, "仅支持"), ({"id": "daily report"}, "空格"),
    ({"id": ["daily-report"]}, "请填写模板标识"),
    ({"name": " 　"}, "不能全为空白"), ({"name": ""}, "填写"),
    ({"name": "报" * 81}, "80"), ({"name": "日报\n总结"}, "控制字符"),
    ({"name": "日报\x00"}, "控制字符"), ({"name": ["日报"]}, "填写"),
    ({"startDate": "2030-02-30"}, "开始日期"), ({"endDate": "2030-13-01"}, "结束日期"),
    ({"startDate": True}, "开始日期"), ({"endDate": ["2030-01-01"]}, "结束日期"),
    ({"startDate": "2030-2-01"}, "开始日期"), ({"endDate": "0000-01-01"}, "结束日期"),
    ({"startDate": "2030-12-31", "endDate": "2030-01-01"}, "开始日期不能晚于结束日期"),
]

class TemplateValidationTests(unittest.TestCase):
    def test_optional_dates_accept_valid_calendar_boundaries(self):
        for dates in ({}, {"startDate": None, "endDate": ""}, {"startDate": "2032-02-29"},
                      {"endDate": "2030-12-31"}, {"startDate": "2030-12-31", "endDate": "2030-12-31"}):
            result = templates.normalize({**VALID, **dates})
            self.assertEqual(result["startDate"], dates.get("startDate") or "")
            self.assertEqual(result["endDate"], dates.get("endDate") or "")

    def test_rejects_malformed_values_without_coercion_or_truncation(self):
        for changes, message in INVALID:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                templates.normalize({**VALID, **changes})

    def test_accepts_boundaries_multilingual_names_and_trims_display_name(self):
        for template_id, name in [("a1", "报"), ("a" * 64, "报" * 80),
                                  ("1.a_b-c", " Weekly 日報 주간 / Review（2026） 📊 "),
                                  ("emoji", "📊" * 80)]:
            result = templates.normalize({**VALID, "id": template_id, "name": name})
            self.assertEqual(result["id"], template_id)
            self.assertEqual(result["name"], name.strip())

    def test_invalid_batch_and_duplicate_id_leave_persisted_catalog_unchanged(self):
        async def scenario():
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(models.Base.metadata.create_all)
                sessions = async_sessionmaker(engine, expire_on_commit=False)
                async with sessions() as db:
                    before = await templates.save(db, [VALID])
                    await db.commit()
                    for changes, message in INVALID:
                        with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                            await templates.save(db, [VALID, {**VALID, "id": "another", **changes}])
                        self.assertEqual(await templates.load(db), before)
                    with self.assertRaisesRegex(ValueError, "模板标识不能重复"):
                        await templates.save(db, [VALID, {**VALID, "name": "Another", "enabled": False}])
                    self.assertEqual(await templates.load(db), before)
                    for dates in ({"startDate": "2030-12-01", "endDate": "2030-12-31"},
                                  {"startDate": "2030-12-01", "endDate": "2031-01-31"},
                                  {"startDate": "", "endDate": ""}):
                        saved = await templates.save(db, [{**VALID, **dates}])
                        await db.commit()
                        self.assertEqual(await templates.load(db), saved)
                        self.assertEqual(saved[0]["startDate"], dates["startDate"])
                        self.assertEqual(saved[0]["endDate"], dates["endDate"])
            finally:
                await engine.dispose()
        asyncio.run(scenario())

if __name__ == "__main__":
    unittest.main()
