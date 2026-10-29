"""Run the real plugin center against isolated fixtures; capture responsive screenshots.

No personal browser profile, backend, credentials or production state is used.
Usage: python tests/run-plugin-center-render.py --output <artifact-directory>
"""
import argparse
import html
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--variant', action='append', help='Run only named variants, e.g. app-review-390-dark')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    browser = next((p for p in [r'C:\Program Files\Google\Chrome\Application\chrome.exe', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'] if Path(p).exists()), None)
    if not browser:
        raise SystemExit('Chrome or Edge is required for rendering tests')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}/tests/plugin-center-render.html'
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with tempfile.TemporaryDirectory(prefix='soduwork-plugin-ui-') as temporary:
        with open(Path(temporary) / 'vite.log', 'w', encoding='utf-8') as log:
            server = subprocess.Popen([shutil.which('node'), str(root / 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=root, stdout=log, stderr=log, creationflags=flags)
            try:
                for _ in range(60):
                    try:
                        with urllib.request.urlopen(url, timeout=1):
                            break
                    except Exception:
                        time.sleep(.2)
                variants = [('test', 1440, 1000, 'light'), ('catalog', 1440, 1100, 'light'), ('detail', 1440, 1050, 'light'), ('review', 1440, 1000, 'light'), ('nested', 1440, 1000, 'light'), ('catalog', 390, 1000, 'light'), ('mobile-detail', 390, 1000, 'light'), ('catalog', 1440, 1000, 'dark'), ('test', 390, 1000, 'light'), ('contract', 390, 1000, 'light'), ('contract-en', 390, 1000, 'light'), ('contract-en', 1280, 1100, 'dark'), ('catalog-en', 390, 1000, 'light')]
                variants += [('app-review', 1440, 1000, 'light'), ('app-review', 390, 1000, 'dark')]
                variants += [('locale-review', 1440, 1000, 'light'), ('locale-review', 390, 1000, 'dark')]
                variants += [('recommend', 1440, 1000, 'light'), ('recommend', 390, 1000, 'dark')]
                variants += [('recommend-state', 1440, 1000, 'light'), ('recommend-state', 390, 1000, 'dark')]
                variants += [('recommend-en', 1440, 1000, 'light'), ('recommend-en', 1024, 1000, 'light'), ('recommend-en', 390, 1000, 'dark')]
                variants += [('catalog-tabs', 1440, 1000, 'light'), ('catalog-tabs', 390, 1000, 'dark')]
                variants += [('catalog', 1280, 1000, 'light'), ('catalog', 1920, 1000, 'light')]
                variants += [('featured-cover', 1440, 1000, 'light'), ('featured-cover', 390, 1000, 'dark')]
                unknown = set(args.variant or []) - {f'{v}-{w}-{t}' for v, w, _, t in variants}
                if unknown:
                    raise ValueError('Unknown render variants: ' + ', '.join(sorted(unknown)))
                results = []
                for view, width, height, theme in variants:
                    name = f'{view}-{width}-{theme}'
                    if args.variant and name not in args.variant:
                        continue
                    page = url.replace('plugin-center-render.html', 'plugin-center-frame.html')
                    for attempt in range(2):
                        result = subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--hide-scrollbars', '--virtual-time-budget=12000', f'--user-data-dir={temporary}/profile-{name}', f'--window-size={max(640, width + 32)},{height}', f'--screenshot={output / (name + ".png")}', '--dump-dom', f'{page}?view={view}&theme={theme}&width={width}&height={height}'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=55, creationflags=flags)
                        found = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', result.stdout, re.S)
                        try:
                            data = json.loads(html.unescape(found.group(1))) if found else {'failures': ['No test output']}
                            break  # Never retry a completed test's assertion failures.
                        except ValueError:
                            data = {'failures': ['Rendering did not complete', result.stderr[-1500:]]}
                            (output / (name + f'.incomplete-{attempt + 1}.html')).write_text(result.stdout, encoding='utf-8')
                    data['renderAttempts'] = attempt + 1
                    if data.get('failures'):
                        (output / (name + '.html')).write_text(result.stdout, encoding='utf-8')
                    results.append({'variant': name, **data})
                    print(json.dumps(results[-1], ensure_ascii=True), flush=True)
                (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
                return int(any(item.get('failures') for item in results))
            finally:
                server.terminate()
                server.wait(timeout=10)


if __name__ == '__main__':
    raise SystemExit(main())
