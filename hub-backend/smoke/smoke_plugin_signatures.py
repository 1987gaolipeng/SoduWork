# -*- coding: utf-8 -*-
"""Isolated smoke coverage for detached plugin signatures and publisher trust."""
import asyncio
import base64
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from types import SimpleNamespace

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-plugin-signatures-")
ROOT = os.path.join(_TEMP.name, "packages")
DB = os.path.join(_TEMP.name, "test.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(ROOT, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(ROOT, "data")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import plugin_packages, plugin_service, plugin_signatures  # noqa: E402
from app.services.client_updates import canonical_bytes  # noqa: E402


passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, str(extra)[:240])


def archive(manifest, signature=None):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("plugin.json", json.dumps(manifest, ensure_ascii=False))
        if signature is not None:
            bundle.writestr(plugin_signatures.SIGNATURE_PATH,
                            json.dumps(signature, ensure_ascii=False))
    return out.getvalue()


def signed_archive(manifest, key_id, private_key, signed_at="2026-08-15T10:00:00Z"):
    unsigned = plugin_packages.parse(archive(manifest))
    envelope = {
        "schema": plugin_signatures.SCHEMA,
        "algorithm": plugin_signatures.ALGORITHM,
        "keyId": key_id,
        "signedAt": signed_at,
    }
    payload = plugin_signatures.signature_payload(
        unsigned["contentChecksum"], unsigned["manifest"], envelope)
    envelope["signature"] = base64.b64encode(
        private_key.sign(canonical_bytes(payload))).decode("ascii")
    return archive(manifest, envelope), envelope


def public_key(private_key):
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode("ascii")


BASE = {
    "schemaVersion": 1,
    "key": "signed-capability",
    "name": "签名能力包",
    "version": "1.0.0",
    "description": "验证可信发布者和内容完整性",
    "instructions": "按输入完成工作并返回可验收结果。",
    "inputs": [],
}


async def main():
    await init_db()
    actor = SimpleNamespace(
        id="user-signature", user_id="user-signature",
        display_name="插件作者", username="publisher", org_id="org-signature")
    private = Ed25519PrivateKey.generate()
    key_id = "soduwork.smoke.2026"
    blob, envelope = signed_archive(BASE, key_id, private)
    parsed = plugin_packages.parse(blob)
    check("签名文件不参与被签内容摘要",
          parsed["contentChecksum"] == plugin_packages.parse(archive(BASE))["checksum"])
    check("签名清单与标准包同时可解析",
          parsed["signature"]["keyId"] == key_id
          and parsed["checksum"] != parsed["contentChecksum"])

    async with SessionLocal() as session:
        key = await plugin_signatures.create_key(session, {
            "keyId": key_id,
            "publisherName": "SoduWork 冒烟发布者",
            "description": "自动化测试",
            "publicKey": public_key(private),
        }, actor, actor.org_id)
        check("可信发布者只保存公钥和指纹",
              key.status == "active" and len(key.fingerprint) == 64)

        proof = await plugin_signatures.inspect(session, parsed, actor.org_id)
        summary = plugin_packages.public_summary(parsed, proof)
        check("可信公钥验证真实 Ed25519 签名",
              proof["state"] == "verified"
              and proof["publisherName"] == "SoduWork 冒烟发布者", proof)
        check("预检公开签名状态但不暴露签名字节",
              summary["signature"]["state"] == "verified"
              and "signature" not in summary["signature"], summary["signature"])

        installed = await plugin_service.install(
            session, blob, actor, actor.org_id,
            source_channel="client-package", source_name="../signed-plugin.zip")
        version = await session.get(am.PluginVersion, installed["versionId"])
        provenance = plugin_service.provenance_api(
            version.provenance, version.checksum)
        check("不可变版本冻结可信发布者和签名证据",
              provenance["signatureState"] == "verified"
              and provenance["signatureKeyId"] == key_id
              and provenance["publisherName"] == "SoduWork 冒烟发布者"
              and provenance["sourceName"] == "signed-plugin.zip", provenance)

        await plugin_service.approve_version(session, version, True, "审核员")
        check("签名版本发布前会再次读取原包验签",
              version.trust_state == "approved" and version.enabled)

        tampered_manifest = {**BASE, "description": "内容已被修改"}
        tampered = plugin_packages.parse(archive(tampered_manifest, envelope))
        tampered_proof = await plugin_signatures.inspect(
            session, tampered, actor.org_id)
        rejected = False
        try:
            plugin_signatures.assert_importable(tampered_proof)
        except ValueError:
            rejected = True
        check("签名后任一内容变化都会被拒绝",
              tampered_proof["state"] == "invalid" and rejected, tampered_proof)

        unknown_private = Ed25519PrivateKey.generate()
        unknown_blob, _ = signed_archive(
            {**BASE, "key": "unknown-signer", "version": "1.0.1"},
            "unknown.publisher.2026", unknown_private)
        unknown_parsed = plugin_packages.parse(unknown_blob)
        unknown_proof = await plugin_signatures.inspect(
            session, unknown_parsed, actor.org_id)
        blocked = False
        try:
            plugin_signatures.assert_publishable(unknown_proof)
        except ValueError:
            blocked = True
        check("未知发布者可识别但不能直接发布",
              unknown_proof["state"] == "unknown-key" and blocked, unknown_proof)

        candidate = {
            "keyId": "unknown.publisher.2026",
            "publicKey": public_key(unknown_private),
        }
        verified_candidate = plugin_signatures.verify_candidate(
            unknown_parsed, candidate, "个人插件作者")
        wrong_key_blocked = False
        try:
            plugin_signatures.verify_candidate(
                unknown_parsed, {**candidate, "publicKey": public_key(private)})
        except ValueError:
            wrong_key_blocked = True
        check("上传时公钥候选必须真实匹配当前不可变包签名",
              len(verified_candidate["fingerprint"]) == 64 and wrong_key_blocked,
              verified_candidate)

        unknown_install = await plugin_service.install(
            session, unknown_blob, actor, actor.org_id,
            source_channel="personal-publish", source_name="个人插件",
            publisher_candidate=candidate)
        unknown_version = await session.get(
            am.PluginVersion, unknown_install["versionId"])
        hidden = plugin_service.provenance_api(
            unknown_version.provenance, unknown_version.checksum)
        check("隔离版本保存候选但员工来源摘要不暴露公钥",
              plugin_signatures.publisher_candidate(unknown_version)["publicKey"]
              == candidate["publicKey"]
              and "_publisherCandidate" not in hidden
              and "publicKey" not in json.dumps(hidden), hidden)

        unknown_plugin = await session.get(am.Plugin, unknown_version.plugin_id)
        publisher, registered_proof = await plugin_signatures.register_candidate(
            session, unknown_version, unknown_plugin, actor,
            {"publisherName": "个人插件作者", "description": "冒烟一键登记"})
        registered = plugin_service.provenance_api(
            unknown_version.provenance, unknown_version.checksum)
        check("管理员登记时重新读取原包验签并固化可信发布者",
              publisher.key_id == candidate["keyId"]
              and registered_proof["state"] == "verified"
              and registered["signatureState"] == "verified"
              and not plugin_signatures.publisher_candidate(unknown_version),
              registered)

        await plugin_signatures.revoke_key(session, key)
        revoked_proof = await plugin_signatures.inspect(
            session, parsed, actor.org_id)
        check("撤销密钥阻止后续信任但不静默停产",
              revoked_proof["state"] == "revoked-key"
              and version.trust_state == "approved" and version.enabled,
              {"proof": revoked_proof, "version": version.trust_state})


try:
    asyncio.run(main())
finally:
    asyncio.run(engine.dispose())
    shutil.rmtree(ROOT, ignore_errors=True)
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass

print(f"plugin signatures: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
