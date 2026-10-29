# -*- coding: utf-8 -*-
"""Regression checks for stable desktop rendering and input focus."""
import http.server
import os
import re
import html as _html
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

CLIENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "client")
CLIENT = os.path.normpath(CLIENT)
PAGES = ["tests/render-skip.html", "tests/render-throttle.html", "tests/chat-task-suggestion.html",
         "tests/new-conversation.html", "tests/task-store-race.html", "tests/schedule-loading.html",
         "tests/task-execution-journey.html", "tests/output-links.html"]

CHROME = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
]


def _browser() -> str:
    explicit = os.environ.get("SODUWORK_SHOT_BROWSER", "").strip()
    if explicit:
        if not os.path.isfile(explicit):
            raise SystemExit("SODUWORK_SHOT_BROWSER 未指向可执行浏览器")
        return explicit
    for path in CHROME:
        if os.path.exists(path):
            return path
    found = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chrome")
    if not found:
        raise SystemExit("找不到 Chrome/Edge —— 这个冒烟要真浏览器跑，装一个再来")
    return found


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=CLIENT, **kw)

    def log_message(self, *_a):        # Keep access logs out of test output.
        pass


def main() -> int:
    with socketserver.TCPServer(("127.0.0.1", 0), _Quiet) as srv:
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        profile = tempfile.mkdtemp(prefix="soduwork-smoke-chrome-")
        total_fail = 0
        try:
            for page in PAGES:
                out = subprocess.run(
                    [_browser(), "--headless=new", "--disable-gpu", "--no-first-run",
                     "--virtual-time-budget=8000", "--user-data-dir=" + profile,
                     "--dump-dom", "http://127.0.0.1:%d/%s" % (port, page)],
                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=120).stdout
                found = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', out or "", re.S)
                if not found:
                    print("== %s ==\n  FAIL  页面没跑出结果（脚本报错了？）" % page)
                    total_fail += 1
                    continue
                text = _html.unescape(found.group(1)).strip()
                print("== %s ==\n%s\n" % (page, text))
                tail = re.search(r"(\d+) passed, (\d+) failed", text)
                total_fail += int(tail.group(2)) if tail else 1
        finally:
            srv.shutdown()
            shutil.rmtree(profile, ignore_errors=True)
    print("client render smoke: %s" % ("全部通过" if not total_fail else "%d 条没过" % total_fail))
    return 1 if total_fail else 0


sys.exit(main())
