"""Standard-library password hashing and stateless signed tokens. Store PBKDF2-SHA256 password
hashes; HMAC-SHA256 tokens include purpose, issuance, expiry, and authorization version. Secret
rotation or version increments invalidate existing tokens.
"""
import base64
import hashlib
import hmac
import json
import secrets
import time

from .config import get_settings

_ITER = 200_000


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode("utf-8"), salt, _ITER)
    return f"pbkdf2${_ITER}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        scheme, iter_s, salt_hex, hash_hex = (stored or "").split("$")
        if scheme != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode("utf-8"), bytes.fromhex(salt_hex), int(iter_s))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sig(payload_b64: str) -> str:
    key = get_settings().auth_secret.encode("utf-8")
    return hmac.new(key, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()


def sign_claims(
    claims: dict,
    *,
    ttl_seconds: int,
    token_type: str,
    issued_at: int | None = None,
    token_id: str | None = None,
) -> str:
    """Sign a short-lived, purpose-bound capability token."""
    now = int(time.time()) if issued_at is None else int(issued_at)
    body = dict(claims or {})
    body.update({
        "typ": str(token_type or "").strip(),
        "iat": now,
        "exp": now + max(1, int(ttl_seconds)),
        "jti": str(token_id) if token_id is not None else secrets.token_urlsafe(12),
    })
    payload = _b64e(json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8"))
    return payload + "." + _sig(payload)


def verify_claims(token: str, *, token_type: str) -> dict | None:
    """Verify signature, lifetime and purpose; return claims on success."""
    try:
        payload_b64, sig = (token or "").split(".", 1)
        if not hmac.compare_digest(sig, _sig(payload_b64)):
            return None
        data = json.loads(_b64d(payload_b64))
        now = int(time.time())
        if int(data.get("exp", 0)) <= now or int(data.get("iat", now + 1)) > now + 60:
            return None
        if not hmac.compare_digest(str(data.get("typ") or ""), str(token_type or "")):
            return None
        return data
    except Exception:
        return None


def sign_token(uid: str, auth_version: int = 1, ttl_hours: int | None = None) -> str:
    ttl = ttl_hours if ttl_hours is not None else get_settings().token_ttl_hours
    return sign_claims(
        {"uid": uid, "ver": int(auth_version or 1)},
        ttl_seconds=int(ttl) * 3600,
        token_type="user",
    )


def verify_user_claims(token: str) -> dict | None:
    """Verify a versioned administrator/user session and return its claims."""
    return verify_claims(token, token_type="user")
