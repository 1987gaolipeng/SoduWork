"""Verify release trust-store consistency and signing-key rotation. Both server and client must
trust the new key while retaining old public keys for history. Older clients must receive the
minimum-version/manual-install path before signature verification when their bundled trust store
lacks the new key.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from app.services import client_updates as updates  # noqa: E402

BACKEND = Path(__file__).resolve().parent
CLIENT = BACKEND.parent / "client"
CURRENT_KEY_ID = "soduwork-client-release-2026b"

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def main() -> int:
    server = json.loads((BACKEND / "client-update-trust.json").read_text(encoding="utf-8"))
    client = json.loads((CLIENT / "update-trust.json").read_text(encoding="utf-8"))

    ok(server.get("schema") == 1 and client.get("schema") == 1, "两处信任库都是 schema 1")
    ok(server.get("keys") == client.get("keys"),
       "★服务端与客户端信任库必须逐字一致（不一致＝新版本发出去客户端不认）",
       (list(server.get("keys") or {}), list(client.get("keys") or {})))
    ok(CURRENT_KEY_ID in (server.get("keys") or {}),
       "当前签名密钥在信任库里", list(server.get("keys") or {}))
    ok("soduwork-client-release-2026" in (server.get("keys") or {}),
       "★老公钥保留（历史版本的 manifest 仍要能验签，别顺手删）")

    for key_id, value in (server.get("keys") or {}).items():
        ok(bool(updates.KEY_ID_RE.fullmatch(key_id)), f"密钥 id 合法：{key_id}")
        try:
            updates.public_key(str(value))
            ok(True, f"公钥可解析：{key_id}")
        except Exception as exc:  # noqa: BLE001
            ok(False, f"公钥可解析：{key_id}", exc)

    # Exercise the actual server trusted-key loader and its validation.
    try:
        loaded = updates.trusted_public_keys()
        ok(loaded == server.get("keys"), "服务端 trusted_public_keys 与文件一致", loaded)
    except Exception as exc:  # noqa: BLE001
        ok(False, "服务端 trusted_public_keys 可加载", exc)

    # Handle manualInstallRequired before signature verification for rotation compatibility.
    updater = (CLIENT / "main" / "client-updater.js").read_text(encoding="utf-8")
    manual_at = updater.find("data.manualInstallRequired")
    validate_at = updater.find("contract.validateManifest")
    ok(0 < manual_at < validate_at,
       "★客户端在验签之前处理『需要手动安装』（老客户端换钥匙后看到人话而不是签名错误）",
       (manual_at, validate_at))

    print(f"release trust smoke: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
