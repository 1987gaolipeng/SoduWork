"""Provider reuse must not keep revoked credentials after a write or rollback."""
from unittest.mock import patch

from test_model_runtime import IsolatedDatabase
from app.models import Client, ModelProvider
from app.services import model_catalog


class ProviderCacheTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.sessions() as session, session.begin():
            session.add_all([ModelProvider(id="fixture", name="Fixture", base_url="https://fixture.invalid/v1",
                                          api_key="fixture-only-key", enabled=True), Client(id="fixture-client")])

    async def test_reuses_read_transaction_but_commit_invalidates_disabled_provider(self):
        async with self.sessions() as session:
            with patch.object(session, "execute", wraps=session.execute) as execute:
                first = await model_catalog.effective_provider_map(session)
                self.assertIs(await model_catalog.effective_provider_map(session), first)
                self.assertEqual(execute.call_count, 1)
            provider = await session.get(ModelProvider, "fixture")
            provider.enabled = False
            await session.commit()
            current = await model_catalog.effective_provider_map(session)
            self.assertFalse(current["fixture"]["enabled"])
            self.assertIsNot(current, first)

    async def test_uncommitted_changes_invalidate_cache_and_rollback_restores_real_values(self):
        async with self.sessions() as session:
            await model_catalog.effective_provider_map(session)
            provider = await session.get(ModelProvider, "fixture")
            provider.api_key = "replacement-fixture-key"
            provider.base_url = "https://replacement.invalid/v1"
            pending = await model_catalog.effective_provider_map(session)
            self.assertEqual(pending["fixture"]["apiKey"], "replacement-fixture-key")
            await session.rollback()
            restored = await model_catalog.effective_provider_map(session)
            self.assertEqual(restored["fixture"]["apiKey"], "fixture-only-key")
            self.assertEqual(restored["fixture"]["baseUrl"], "https://fixture.invalid/v1")

    async def test_explicit_flush_invalidates_provider_credentials_in_same_transaction(self):
        async with self.sessions() as session:
            first = await model_catalog.effective_provider_map(session)
            provider = await session.get(ModelProvider, "fixture")
            provider.enabled = False
            await session.flush()
            self.assertFalse(session.dirty)
            current = await model_catalog.effective_provider_map(session)
            self.assertIsNot(current, first)
            self.assertFalse(current["fixture"]["enabled"])

    async def test_client_override_changes_never_reuse_organization_key(self):
        async with self.sessions() as session:
            client = await session.get(Client, "fixture-client")
            first = await model_catalog.effective_provider_map(session, client)
            self.assertEqual(first["fixture"]["apiKey"], "fixture-only-key")
            client.config = {"modelProviders": [{"id": "fixture", "baseUrl": "https://personal.invalid/v1"}]}
            current = await model_catalog.effective_provider_map(session, client)
            self.assertEqual(current["fixture"]["baseUrl"], "https://personal.invalid/v1")
            self.assertEqual(current["fixture"]["apiKey"], "")

    async def test_next_transaction_refreshes_an_entity_changed_by_another_session(self):
        async with self.sessions() as reader:
            retained = await reader.get(ModelProvider, "fixture")
            await model_catalog.effective_provider_map(reader)
            await reader.commit()
            async with self.sessions() as writer:
                provider = await writer.get(ModelProvider, "fixture")
                provider.enabled = False
                provider.api_key = "rotated-fixture-key"
                await writer.commit()
            current = await model_catalog.effective_provider_map(reader)
            self.assertFalse(current["fixture"]["enabled"])
            self.assertEqual(current["fixture"]["apiKey"], "rotated-fixture-key")
            self.assertFalse(retained.enabled)


if __name__ == "__main__":
    import unittest
    unittest.main()
