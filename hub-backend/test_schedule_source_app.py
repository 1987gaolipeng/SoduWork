"""Display attribution survives storage/editing without granting capabilities."""
import base64
import importlib
import unittest
from types import SimpleNamespace
from pathlib import Path
from sqlalchemy import create_engine, text, inspect
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.services.schedule_source_app import clean
from app.api.schedule_contract import apply_schedule_update

class SourceAppTests(unittest.TestCase):
    def source(self):
        return {"pluginId":"local:idea","key":"jiyong-bot-idea","name":"灵感扭蛋机","characterName":"阿奇", "icon":"data:image/png;base64,"+base64.b64encode((Path(__file__).resolve().parents[1]/"client/assets/rail-icons/home.png").read_bytes()).decode()}
    def test_optional_name_and_role_are_data_not_account_identity(self):
        source=clean(self.source());self.assertEqual(source["characterName"],"阿奇")
        source.pop("characterName");self.assertEqual(clean(source)["characterName"],"")
        self.assertEqual(clean(None),{})
        for bad in ({"name":"x"},{**source,"icon":"javascript:alert(1)"},{**source,"characterName":"a"*121},{**source,"token":"secret"}):
            with self.subTest(bad=bad),self.assertRaises(ValueError):clean(bad)
    def test_partial_edits_cannot_replace_creation_attribution_or_real_creator(self):
        row=SimpleNamespace(every="daily",source_app=self.source(),created_by="user-a",created_by_name="User A")
        apply_schedule_update(row,{"enabled":False,"sourceApp":{**self.source(),"characterName":"forged"},"createdByName":"forged"})
        self.assertEqual(row.source_app,self.source());self.assertEqual(row.created_by,"user-a");self.assertEqual(row.created_by_name,"User A")
    def test_sqlite_migration_preserves_existing_schedule_and_roundtrips_attribution(self):
        migration=importlib.import_module("migrations.versions.0071_schedule_source_app")
        engine=create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE ai_schedule (id TEXT PRIMARY KEY, note TEXT)"))
            conn.execute(text("INSERT INTO ai_schedule VALUES ('kept','original instruction')"))
            with Operations.context(MigrationContext.configure(conn)):migration.upgrade()
            self.assertEqual(conn.execute(text("SELECT note,source_app FROM ai_schedule")).one(),("original instruction","{}"))
            import json
            conn.execute(text("UPDATE ai_schedule SET source_app=:source"),{"source":json.dumps(clean(self.source()))})
            self.assertEqual(json.loads(conn.scalar(text("SELECT source_app FROM ai_schedule")))["characterName"],"阿奇")
            with Operations.context(MigrationContext.configure(conn)):migration.downgrade()
            self.assertEqual([c['name'] for c in inspect(conn).get_columns('ai_schedule')],['id','note'])
            self.assertEqual(conn.scalar(text("SELECT note FROM ai_schedule")),"original instruction")
        engine.dispose()
