"""Loopback-only browser fixture. No business DB, user profiles or real publication."""
import os
import secrets
import sys
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = secrets.token_hex(32)
os.environ["ADMIN_PASS"] = secrets.token_hex(20)
os.environ["CLUSTER_REDIS_URL"] = ""
import asyncio
import re
from pathlib import Path
from fastapi.responses import HTMLResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from skill_test_support import fixture
from test_skill_sharing import archive
import uvicorn

async def main():
    root = Path(sys.argv[2]).resolve()
    if not root.name.startswith("soduwork-skill-e2e-"):
        raise RuntimeError("Requires an isolated temporary directory")
    app, tokens, sessions, cleanup = await fixture(root)
    if "--lifecycle" in sys.argv:
        from unittest.mock import patch
        from app.services import skills
        folder = root / "empty" / "builtin-method"
        folder.mkdir()
        (folder / "SKILL.md").write_text("---\nname: builtin-method\ndescription: Builtin fixture\n---\nUse fixture data only.", encoding="utf-8")
        builtin_scan = patch.object(skills, "default_roots", lambda: [str(folder.parent)])
        builtin_scan.start()
        async with sessions() as session:
            await skills.save_cfg(session, {"allowed": ["builtin-method", "mcp-tools"], "roots": []})
            await session.commit()
    repo = Path(__file__).resolve().parent.parent
    from app.api import admin, plugins, plugin_client_catalog
    app.include_router(admin.router)
    app.include_router(plugins.router)
    app.include_router(plugin_client_catalog.router)
    @app.get("/fixture/auth")
    async def auth():
        return tokens
    @app.get("/fixture/package")
    async def sample(version: str = "v1"):
        return Response(archive(name="weekly-business", tail=version)[0], media_type="application/zip")
    @app.get("/favicon.ico")
    async def favicon():
        return Response(status_code=204)
    @app.get("/healthz")
    async def health():
        return {"ok": True, "version": "isolated-test"}
    @app.get("/fixture/client")
    async def client():
        scripts = ["core/api-work-plugins.js", "api.js", "core/plugin-icon.js", "core/connector-brand.js",
                   "components/panels/skill-catalog-sync.js",
                   "components/panels/plugin-catalog-sync.js",
                   "components/panels/plugin-catalog-format.js",
                   "components/panels/plugin-publication-ux.js",
                   "components/panels/plugin-dependency-ux.js",
                   "components/panels/plugin-install-setup.js",
                   "components/panels/plugin-lifecycle.js",
                   "components/panels/plugin-presentation.js",
                   "components/panels/panels-capability-directory.js",
                   "components/panels/panels-capability-plugins.js",
                   "components/panels/panels-capability-mcp.js",
                   "components/panels/connector-export.js",
                   "components/panels/connector-config.js",
                   "components/panels/connector-auth.js",
                   "components/panels/connector-editor.js",
                   "components/panels/connector-selection.js",
                   "components/panels/connector-directory.js",
                   "components/panels/panels-capability-editors.js",
                   "components/panels/panels-capabilities.js"]
        styles = re.findall(r'<link rel="stylesheet" href="([^"]+)"',
                            (repo / "client" / "desk.html").read_text(encoding="utf-8"))
        return HTMLResponse('<!doctype html><html><head><meta charset="utf-8"><base href="/client/">' +
            "".join('<link rel="stylesheet" href="/client/' + x + '">' for x in styles) +
            '<style>body{font:14px var(--font-ui);background:var(--bg-1);color:var(--ink)}' +
            '#capPanel{position:fixed;inset:20px;width:auto;height:auto;max-height:none;transform:none}' +
            '#fixture-toast{position:fixed;bottom:0;left:20px;z-index:9999;font-size:13px}</style>' +
            '</head><body><div id="fixture-toast"></div>' +
            '<script>window.petSay=text=>document.getElementById("fixture-toast").textContent=text;</script>' +
            "".join('<script src="/client/' + x + '"></script>' for x in scripts) +
            '<script>openCapabilityPanel();</script></body></html>',
            headers={"Content-Security-Policy": "connect-src 'self'"})
    app.mount("/client", StaticFiles(directory=str(repo / "client")))
    app.mount("/assets", StaticFiles(directory=str(repo / "hub-frontend" / "dist" / "assets")))
    @app.get("/admin")
    async def admin_page():
        return FileResponse(repo / "hub-frontend" / "dist" / "index.html")
    app.mount("/", StaticFiles(directory=str(repo / "hub-frontend" / "dist")))
    try:
        await uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(sys.argv[1]),
                                          log_level="warning", access_log=False)).serve()
    finally:
        if "--lifecycle" in sys.argv:
            builtin_scan.stop()
        await cleanup()

if __name__ == "__main__":
    if sys.platform == "win32":
        # Use selector TCP for short-lived loopback browser connections on Windows.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
