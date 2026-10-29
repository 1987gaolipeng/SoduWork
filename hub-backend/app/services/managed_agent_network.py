"""Per-attempt proxy discovery and credential-free runtime download diagnostics."""
from __future__ import annotations

from http import HTTPStatus
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


def _proxies() -> dict[str, str]:
    if sys.platform != "win32":
        return urllib.request.getproxies()
    # urllib chooses environment OR registry. NO_PROXY alone makes the first
    # mapping truthy and accidentally disables the user's Windows HTTP(S) proxy.
    proxies = urllib.request.getproxies_registry()
    environment = urllib.request.getproxies_environment()
    # Presence matters: an explicitly empty scheme disables its registry proxy.
    # The stdlib resolves lowercase precedence and CGI HTTP_PROXY handling.
    for key in os.environ:
        if key.lower().endswith("_proxy"):
            proxies.pop(key[:-6].lower(), None)
    proxies.update(environment)
    return proxies


def _origin(url: str) -> tuple[str, str, int] | None:
    try:
        parsed = urllib.parse.urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not parsed.hostname:
            return None
        port = parsed.port if parsed.port is not None else (443 if scheme == "https" else 80)
        return scheme, parsed.hostname.lower(), port
    except ValueError:
        return None


class _DownloadProxyHandler(urllib.request.ProxyHandler):
    def __init__(self, proxies: dict[str, str], hub: str):
        self.hub_origin = _origin(hub)
        super().__init__(proxies)

    def proxy_open(self, request, proxy, scheme):
        # Hub control traffic already uses a direct connection. Match its exact
        # origin on every request, including redirects; another origin still
        # uses the selected proxy and the stdlib's existing bypass rules.
        if self.hub_origin and _origin(request.full_url) == self.hub_origin:
            return None
        return super().proxy_open(request, proxy, scheme)


class _DownloadRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        redirected = super().redirect_request(request, response, code, message, headers, new_url)
        if redirected is not None:
            # urllib stores proxy credentials as ordinary request headers.
            # The next hop may be direct; its proxy handler can add its own
            # credentials if required after selecting that target's route.
            redirected.remove_header("Proxy-authorization")
        return redirected


def open_download(request: urllib.request.Request, *, timeout: int):
    # A resident Runner must see proxy changes between installation attempts.
    # Keep default TLS verification and stdlib NO_PROXY bypass handling.
    opener = urllib.request.build_opener(
        _DownloadProxyHandler(_proxies(), str(os.environ.get("SODUWORK_HUB_HTTP_BASE") or "")),
        _DownloadRedirectHandler())
    return opener.open(request, timeout=timeout)


def source_label(url: str) -> str:
    """Show the source location without userinfo, query tokens or fragments."""
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        if ":" in host:
            host = "[" + host + "]"
        if parsed.port is not None:
            host += ":" + str(parsed.port)
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except ValueError:
        return "自定义下载源"


def error_label(error: Exception) -> str:
    """Use structured error fields; server/proxy text may contain credentials."""
    if isinstance(error, urllib.error.HTTPError):
        details = {404: "下载源没有此安装包", 410: "下载源已移除此安装包"}
        try:
            detail = details.get(error.code) or HTTPStatus(error.code).phrase
        except ValueError:
            detail = "下载请求失败"
        return "HTTP %d（%s）" % (error.code, detail)
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLError):
        return "TLS 证书或安全连接校验失败"
    if isinstance(reason, socket.gaierror):
        return "无法解析下载源或代理地址"
    winerror = getattr(reason, "winerror", None)
    errno = getattr(reason, "errno", None)
    code = ("WinError %d" % winerror if isinstance(winerror, int)
            else "errno %d" % errno if isinstance(errno, int) else "")
    if isinstance(reason, TimeoutError) or winerror == 10060:
        return "网络连接超时" + ("（%s）" % code if code else "")
    if isinstance(reason, OSError):
        return "网络或文件访问失败" + ("（%s）" % code if code else "")
    if isinstance(error, RuntimeError):
        # Only local size/checksum checks raise RuntimeError inside _download.
        return str(error)[:180]
    if isinstance(error, ValueError):
        return "下载响应格式错误"
    return "网络请求失败"
