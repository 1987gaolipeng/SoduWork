"""Fixed provider metadata; user configuration cannot change authorization, token, or identity
endpoints.
"""
from __future__ import annotations
import re
from urllib.parse import urlsplit
from cryptography.fernet import Fernet
from ..config import get_settings

# Protocol references: Google Web Server OAuth and Microsoft v2 authorization-code flow.
# https://developers.google.com/identity/protocols/oauth2/web-server
# https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
# Identity probes do not read files or mail; each connector defines its read-only scopes.
PROVIDERS = {
    "google-drive": {"label": "Google Drive", "family": "google", "tokenField": "GOOGLE_ACCESS_TOKEN",
        "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
        "identityUrl": "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)",
        "identityPath": ["user", "permissionId"]},
    "onedrive": {"label": "OneDrive", "family": "microsoft", "tokenField": "MSFT_ACCESS_TOKEN",
        "scopes": ["User.Read", "Files.Read.All"]},
    "outlook": {"label": "Outlook", "family": "microsoft", "tokenField": "MSFT_ACCESS_TOKEN",
        "scopes": ["User.Read", "Mail.Read"]},
    "sharepoint": {"label": "SharePoint", "family": "microsoft", "tokenField": "MSFT_ACCESS_TOKEN",
        "scopes": ["User.Read", "Sites.Read.All"]},
    "microsoft-teams": {"label": "Microsoft Teams", "family": "microsoft", "tokenField": "MSFT_ACCESS_TOKEN",
        "scopes": ["User.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"]},
}


def definition(provider):
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise ValueError("此连接器暂不支持账号登录授权")
    result = dict(PROVIDERS[provider])
    if result["family"] == "microsoft":
        result.update(identityUrl="https://graph.microsoft.com/v1.0/me?$select=id", identityPath=["id"])
    return result


def callback_url():
    settings = get_settings()
    url = str(settings.hub_public_url or "").rstrip("/")
    parsed = urlsplit(url)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"} and settings.soduwork_env == "development"
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("请管理员先配置 Hub 公网地址")
    if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
        raise ValueError("连接器授权回调必须使用 HTTPS")
    return url + "/api/v1/mcp-servers/oauth/callback"


def cipher():
    try:
        return Fernet(get_settings().connector_oauth_key.encode())
    except Exception:
        raise ValueError("请管理员先配置连接器授权加密密钥") from None


def application(provider):
    meta = definition(provider)
    cfg = get_settings()
    cipher()
    client_id = str(getattr(cfg, "connector_" + meta["family"] + "_client_id") or "").strip()
    client_secret = str(getattr(cfg, "connector_" + meta["family"] + "_client_secret") or "").strip()
    if not client_id or not client_secret or max(len(client_id), len(client_secret)) > 4096:
        raise ValueError("请联系管理员配置平台应用后再连接")
    if meta["family"] == "google":
        authorization = "https://accounts.google.com/o/oauth2/v2/auth"
        token = "https://oauth2.googleapis.com/token"
        scopes = meta["scopes"]
    else:
        tenant = cfg.connector_microsoft_tenant
        if not re.fullmatch(r"organizations|common|consumers|[0-9a-fA-F-]{36}", tenant):
            raise ValueError("Microsoft 租户配置无效")
        authorization = "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/authorize"
        token = "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token"
        scopes = ["offline_access", *meta["scopes"]]
    return {**meta, "id": provider, "clientId": client_id, "clientSecret": client_secret,
            "authorizationUrl": authorization, "tokenUrl": token,
            "redirectUri": callback_url(), "requestedScopes": scopes}


def catalog():
    rows = []
    for provider, meta in PROVIDERS.items():
        message = "登录平台账号后自动续期；默认仅申请只读权限"
        available = True
        try:
            application(provider)
        except ValueError as exc:
            available, message = False, str(exc)
        rows.append({"id": provider, "label": meta["label"], "tokenField": meta["tokenField"],
                     "scopes": meta["scopes"], "readOnly": True, "available": available,
                     "connectionState": "disconnected" if available else "needs_setup", "message": message})
    generic = {"id": "api", "label": "接口文档中的平台", "available": True, "message": "使用平台应用登录", "redirectUri": ""}
    try:
        cipher()
        generic["redirectUri"] = callback_url()
    except ValueError as exc:
        generic.update(available=False, message=str(exc), connectionState="needs_setup")
    rows.append(generic)
    return {"providers": rows}
