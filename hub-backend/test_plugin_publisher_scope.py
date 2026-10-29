"""Regression tests for organization-scoped plugin publisher identities."""
import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am
from app.services import plugin_drafts, plugin_packages, plugin_signatures


def public_key(private: Ed25519PrivateKey) -> str:
    return base64.b64encode(private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()


def parsed_signature(private: Ed25519PrivateKey, key_id: str) -> dict:
    payload = {
        "schema": plugin_signatures.SCHEMA,
        "algorithm": plugin_signatures.ALGORITHM,
        "keyId": key_id,
        "contentChecksum": "checksum",
        "pluginKey": "business",
        "version": "1.0.0",
        "signedAt": "2026-09-23T00:00:00+00:00",
    }
    return {"signature": {
        **payload,
        "signature": base64.b64encode(private.sign(
            plugin_signatures.canonical_bytes(payload))).decode(),
        "payload": payload,
    }}


class PublisherScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda sync_conn: [table.create(sync_conn)
                                                    for table in (
                                                        am.PluginPublisherKey.__table__,
                                                        am.Plugin.__table__,
                                                        am.PluginVersion.__table__,
                                                    )])
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.private = Ed25519PrivateKey.generate()
        self.key = public_key(self.private)
        self.body = {
            "keyId": "shared-publisher",
            "publisherName": "Shared Publisher",
            "publicKey": self.key,
        }
        self.user = SimpleNamespace(id="reviewer")
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-publisher-scope-")

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        self.temp.cleanup()

    async def candidate(self, org_id):
        draft = {"template": "method", "key": "business", "name": "Business",
                 "version": "1.0.0", "description": "Verify business facts",
                 "instructions": "Read the supplied facts and summarize verified progress."}
        payload = plugin_signatures.prepare_payload(
            plugin_packages.parse(plugin_drafts.build(draft)), self.body["keyId"],
            "2026-09-23T00:00:00+00:00")
        signature = {key: payload[key] for key in ("schema", "algorithm", "keyId", "signedAt")}
        signature["signature"] = base64.b64encode(self.private.sign(
            plugin_signatures.canonical_bytes(payload))).decode()
        data = plugin_drafts.build(draft, signature)
        parsed = plugin_packages.parse(data)
        path = Path(self.temp.name) / f"{org_id or 'platform'}.soduwork-plugin"
        path.write_bytes(data)
        plugin = am.Plugin(org_id=org_id, key="business", name="Business")
        self.session.add(plugin)
        await self.session.flush()
        version = am.PluginVersion(
            plugin_id=plugin.id, version="1.0.0", checksum=parsed["checksum"],
            package_path=str(path), trust_state="quarantined",
            provenance={"_publisherCandidate": plugin_signatures.verify_candidate(parsed, self.body)})
        self.session.add(version)
        await self.session.commit()
        return plugin, version, parsed

    async def test_same_identity_isolated_between_organizations(self):
        first = await plugin_signatures.create_key(
            self.session, self.body, self.user, "org-a")
        parsed = parsed_signature(self.private, "shared-publisher")
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, "org-b"))["state"], "unknown-key")
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, None))["state"], "unknown-key")
        second = await plugin_signatures.create_key(
            self.session, self.body, self.user, "org-b")
        self.assertNotEqual(first.id, second.id)
        parsed = parsed_signature(self.private, "shared-publisher")
        proof_a = await plugin_signatures.inspect(self.session, parsed, "org-a")
        proof_b = await plugin_signatures.inspect(self.session, parsed, "org-b")
        self.assertEqual(proof_a["state"], "verified")
        self.assertEqual(proof_b["state"], "verified")
        self.assertEqual(proof_a["publisherId"], first.id)
        self.assertEqual(proof_b["publisherId"], second.id)
        await plugin_signatures.revoke_key(self.session, first)
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, "org-a"))["state"], "revoked-key")
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, "org-b"))["state"], "verified")

    async def test_platform_fallback_does_not_hide_organization_override(self):
        platform = await plugin_signatures.create_key(
            self.session, self.body, self.user, None)
        organization = await plugin_signatures.create_key(
            self.session, self.body, self.user, "org-a")
        parsed = parsed_signature(self.private, "shared-publisher")
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, "org-a"))["publisherId"], organization.id)
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, "org-b"))["publisherId"], platform.id)
        await plugin_signatures.revoke_key(self.session, organization)
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, "org-a"))["state"], "revoked-key")
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, None))["publisherId"], platform.id)

    async def test_register_candidate_creates_current_organization_row(self):
        for org_id in ("org-a", "org-b"):
            plugin, version, parsed = await self.candidate(org_id)
            self.assertEqual((await plugin_signatures.inspect(
                self.session, parsed, org_id))["state"], "unknown-key")
            row, proof = await plugin_signatures.register_candidate(
                self.session, version, plugin, self.user, {})
            self.assertEqual(row.org_id, org_id)
            self.assertEqual(proof["state"], "verified")
            self.assertEqual(version.provenance["publisherId"], row.id)
            self.assertNotIn("_publisherCandidate", version.provenance)
        rows = (await self.session.scalars(select(am.PluginPublisherKey).where(
            am.PluginPublisherKey.key_id == "shared-publisher"))).all()
        self.assertEqual({row.org_id for row in rows}, {"org-a", "org-b"})

    async def test_candidate_cannot_promote_organization_trust_to_platform(self):
        await plugin_signatures.create_key(
            self.session, self.body, self.user, "org-a")
        plugin, version, parsed = await self.candidate(None)
        with self.assertRaisesRegex(ValueError, "不能自动提升"):
            await plugin_signatures.register_candidate(
                self.session, version, plugin, self.user, {})
        self.assertEqual((await plugin_signatures.inspect(
            self.session, parsed, None))["state"], "unknown-key")

    async def test_candidate_cannot_restore_revoked_organization_key(self):
        await plugin_signatures.create_key(self.session, self.body, self.user, None)
        row = await plugin_signatures.create_key(self.session, self.body, self.user, "org-a")
        await plugin_signatures.revoke_key(self.session, row)
        plugin, version, _ = await self.candidate("org-a")
        with self.assertRaisesRegex(ValueError, "已经撤销"):
            await plugin_signatures.register_candidate(
                self.session, version, plugin, self.user, {})

    async def test_same_scope_or_different_public_key_is_rejected(self):
        await plugin_signatures.create_key(
            self.session, self.body, self.user, "org-a")
        with self.assertRaisesRegex(ValueError, "已存在"):
            await plugin_signatures.create_key(
                self.session, self.body, self.user, "org-a")
        other = dict(self.body, publicKey=public_key(Ed25519PrivateKey.generate()))
        with self.assertRaisesRegex(ValueError, "绑定另一把公钥"):
            await plugin_signatures.create_key(
                self.session, other, self.user, "org-b")


if __name__ == "__main__":
    unittest.main()
