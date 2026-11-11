"""Offline, isolated smoke for enterprise OIDC security and account mapping."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import time


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-identity-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_tmp.name) / ".smoke-identity.db").as_posix()
os.environ["AUTH_SECRET"] = "identity-smoke-secret-with-enough-entropy"

import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app import models  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.services import identity  # noqa: E402
from app.log_safety import redact_log_text  # noqa: E402


checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


async def main() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    flow = identity._sign_flow({"state": "abc", "exp": int(time.time()) + 30})
    ok(identity._read_flow(flow)["state"] == "abc", "signed flow did not round-trip")
    try:
        identity._read_flow(flow[:-1] + ("x" if flow[-1] != "x" else "y"))
        raise AssertionError("tampered flow was accepted")
    except identity.IdentityError:
        ok(True, "tampered flow rejected")
    try:
        identity._read_flow(identity._sign_flow({"exp": int(time.time()) - 1}))
        raise AssertionError("expired flow was accepted")
    except identity.IdentityError:
        ok(True, "expired flow rejected")
    redacted = redact_log_text("GET /callback?code=secret-code&state=secret-state")
    ok("secret-code" not in redacted and "secret-state" not in redacted,
       "OIDC callback credentials leaked through log redaction")

    async with SessionLocal() as session:
        provider = await identity.save(session, {
            "key": "company-oidc", "name": "Company Login",
            "issuer": "https://id.example.com", "clientId": "soduwork",
            "redirectUri": "https://soduwork.example.com/api/v1/auth/oidc/company-oidc/callback",
            "jitEnabled": True, "allowedDomains": ["example.com"],
        })
        ok(provider.probe_state == "untested" and not provider.enabled,
           "new provider should start quarantined")
        try:
            await identity.save(session, {"enabled": True}, provider)
            raise AssertionError("untested provider was enabled")
        except identity.IdentityError:
            await session.rollback()
            await session.refresh(provider)
            ok(True, "untested provider blocked")

        async def fake_discovery(_url: str) -> dict:
            return {
                "issuer": "https://id.example.com",
                "authorization_endpoint": "https://id.example.com/authorize",
                "token_endpoint": "https://id.example.com/token",
                "jwks_uri": "https://id.example.com/jwks",
                "response_types_supported": ["code"],
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"],
            }

        original_get = identity._get_json
        original_target_guard = identity._reject_unsafe_target
        async def safe_test_target(_url: str) -> None:
            return None
        identity._get_json = fake_discovery
        identity._reject_unsafe_target = safe_test_target
        result = await identity.probe(session, provider)
        identity._get_json = original_get
        identity._reject_unsafe_target = original_target_guard
        ok(result["ready"], "valid OIDC discovery did not pass: " + repr(result))
        provider = await identity.save(session, {"enabled": True}, provider)
        ok(provider.enabled, "probed provider did not enable")
        public = await identity.list_public(session)
        ok(public and public[0]["startUrl"].endswith("/company-oidc/start"),
           "enabled provider missing from public login")
        url, signed, secure = await identity.begin(session, provider.key)
        parsed = identity._read_flow(signed)
        ok("code_challenge_method=S256" in url and parsed.get("nonce") and secure,
           "authorization request lacks PKCE/nonce/secure cookie")

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
        public_jwk.update({"kid": "smoke-key", "alg": "RS256", "use": "sig"})

        async def fake_jwks(_url: str) -> dict:
            return {"keys": [public_jwk]}

        original_jwks = identity._jwks
        identity._jwks = fake_jwks
        now = int(time.time())
        claims = {"iss": provider.issuer, "aud": provider.client_id, "sub": "employee-7",
                  "iat": now, "exp": now + 300, "nonce": parsed["nonce"],
                  "email": "worker@example.com", "email_verified": True,
                  "preferred_username": "worker", "name": "Worker"}
        token = jwt.encode(claims, private, algorithm="RS256", headers={"kid": "smoke-key"})
        verified = await identity._verify_id_token(provider, token, parsed["nonce"])
        ok(verified["sub"] == "employee-7", "signed ID token did not verify")
        try:
            await identity._verify_id_token(provider, token, "wrong-nonce")
            raise AssertionError("wrong nonce was accepted")
        except identity.IdentityError:
            ok(True, "nonce mismatch rejected")
        identity._jwks = original_jwks

        first = await identity._resolve_user(session, provider, claims)
        second = await identity._resolve_user(session, provider, {**claims, "name": "Renamed Worker"})
        count = int(await session.scalar(select(func.count(models.User.id))) or 0)
        links = int(await session.scalar(select(func.count(models.IdentityLink.id))) or 0)
        ok(first.id == second.id and count == 1 and links == 1,
           "stable subject mapping created duplicate accounts")
        try:
            await identity._resolve_user(session, provider, {**claims, "sub": "outsider",
                                                              "email": "x@outside.test"})
            raise AssertionError("disallowed domain was accepted")
        except identity.IdentityError:
            await session.rollback()
            await session.refresh(provider)
            ok(True, "domain allowlist enforced")
        try:
            await identity._resolve_user(session, provider, {**claims, "sub": "unverified",
                                                              "email_verified": False})
            raise AssertionError("unverified enterprise email was accepted")
        except identity.IdentityError:
            await session.rollback()
            await session.refresh(provider)
            ok(True, "verified email required for domain routing")
        ok(not hasattr(provider, "client_secret") and provider.client_secret_env == "",
           "provider model should not persist client secrets")
        await session.refresh(first)
        first.account_deleted_at = datetime.now(timezone.utc)
        first.is_active = True
        await session.commit()
        try:
            await identity._resolve_user(session, provider, claims)
            raise AssertionError("deleted account was restored through SSO")
        except identity.IdentityError:
            ok(True, "account deletion prevents SSO even when is_active is toggled")

    await engine.dispose()


try:
    asyncio.run(main())
finally:
    try:
        asyncio.run(engine.dispose())
    except Exception:
        pass
    _tmp.cleanup()

print(f"enterprise identity: {checks} checks passed")
