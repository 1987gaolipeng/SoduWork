import asyncio
import argparse
import base64
import json
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path
import websockets

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser(description='Live native SoduWork + configured real text model + rollback-only cloud PG E2E')
parser.add_argument('--live', action='store_true', help='Explicitly run the configured real text model')
parser.add_argument('--cloud-root', required=True, type=Path)
parser.add_argument('--cloud-python', required=True)
parser.add_argument('--cdp-port', type=int, default=9223)
parser.add_argument('--output', type=Path)
parser.add_argument('--natural-series', action='store_true', help='Create the news series through natural-language app chat instead of the form')
parser.add_argument('--model', help='An explicitly selected account-authorized model for the isolated test conversation')
args = parser.parse_args()
if not args.live:
    parser.error('--live is required: this test uses the signed-in desktop account and its configured text model')
ROOT = Path(__file__).resolve().parents[2]
CLOUD = args.cloud_root.resolve()
OUT = args.output or ROOT / 'outputs/media-ops-cloud-live'
OUT.mkdir(parents=True, exist_ok=True)
report = {'ok': False, 'cases': [], 'boundary': 'Live source SoduWork native shell, production NativeChat/IPC/Pi runtime, configured real text model, real MCP and PostgreSQL in a loopback fixture transaction. All business test records roll back. No paid image/video generation or external publishing.'}
fixture = None
plugin_id = ''
chatbar = None
tab_id = ''


def pages():
    return json.load(urllib.request.urlopen('http://127.0.0.1:' + str(args.cdp_port) + '/json', timeout=4))


async def call(page, method, params):
    async with websockets.connect(page['webSocketDebuggerUrl'], open_timeout=5, close_timeout=1, max_size=20_000_000) as ws:
        await ws.send(json.dumps({'id': 1, 'method': method, 'params': params}))
        while True:
            result = json.loads(await asyncio.wait_for(ws.recv(), 75))
            if result.get('id') == 1:
                if 'error' in result: raise RuntimeError(str(result['error']))
                return result.get('result', {})


async def evaluate(page, expression):
    result = await call(page, 'Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
    if result.get('exceptionDetails'):
        raise RuntimeError(result['exceptionDetails'].get('text', '') + ': ' + result['result'].get('description', ''))
    return result.get('result', {}).get('value')


async def until(check, label, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        value = await check()
        if value: return value
        await asyncio.sleep(.5)
    raise RuntimeError('Timed out: ' + label)


async def main():
    global fixture, plugin_id, chatbar, tab_id
    initial_pages = {p['id'] for p in pages()}
    workspace = next(p for p in pages() if 'panel=workspace' in p.get('url', ''))
    fixture = subprocess.Popen([args.cloud_python,
        str(CLOUD / 'server/tests/skills_e2e_server.py')], cwd=CLOUD, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=open(OUT / 'fixture-stderr.log', 'w', encoding='utf-8'), text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    line = await asyncio.wait_for(asyncio.to_thread(fixture.stdout.readline), 20)
    if not line: raise RuntimeError('Cloud fixture did not start; inspect fixture-stderr.log')
    info = json.loads(line); base = info['base']; report['space'] = info['space']
    tab_id = 'media-ops-e2e-' + info['space']
    body = json.loads((CLOUD / 'plugin/soduwork-plugin-draft.json').read_text(encoding='utf-8'))
    report['pluginVersion'] = body['version']
    body['key'] = 'ops-cloud-e2e-' + info['space'].rsplit('-', 1)[-1]
    body['name'] = '运营技能闭环测试'
    body['ui']['contributions'][0]['source']['url'] = base + '/__e2e__/bootstrap'
    installed = await evaluate(workspace, 'soduWorkAPI.personalPlugins.create(' + json.dumps(body) + ').then(r=>({ok:r.ok,reason:r.reason,id:r.plugin?.pluginId}))')
    assert installed['ok'], installed
    plugin_id = installed['id']; report['pluginId'] = plugin_id
    declaration = {'appId': 'plugin:' + plugin_id, 'contributionId': 'ops-cloud-console', 'origin': base,
                   'version': 1, 'capabilities': ['context.read', 'composer.control', 'conversation.send', 'mcp.connect', 'settings.read', 'settings.write']}
    payload = {'tabId': tab_id, 'url': base + '/__e2e__/bootstrap', 'label': body['name'], 'appBridge': declaration}
    result = await evaluate(workspace, 'soduWorkAPI.workPreview.showDetached(' + json.dumps(payload) + ')')
    assert result['ok'], result
    async def find_app():
        return next((p for p in pages() if p.get('url', '').startswith(base + '/home.html')), None)
    page = await until(find_app, 'native cloud app login')
    chatbar = await until(lambda: asyncio.sleep(0, result=next((p for p in pages() if p['id'] not in initial_pages and 'panel=chatbar' in p.get('url', '')), None)), 'isolated app conversation surface')
    await until(lambda: evaluate(page, '!!window.MediaOpsSeries && !!window.soduWorkApp'), 'public H5 bridge and create button')
    if args.model:
        await until(lambda: evaluate(chatbar, '!!window.__soduWorkChatbarReady && !!window.NativeChat?.enter'), 'test composer startup')
        await evaluate(chatbar, 'NativeChat.enter("",null,{modelName:' + json.dumps(args.model) + '})')
        report['model'] = args.model
        assert await evaluate(chatbar, 'NativeChat.sessionInfo().model') == args.model
    assert await evaluate(page, 'opsNewSeries.parentElement.id==="thumbs" && opsNewSeries===thumbs.lastElementChild')
    report['cases'].append('New series button is the last item of the right-hand series list, below recommendations.')
    await evaluate(page, 'opsNewSeries.click()')
    await until(lambda: evaluate(page, '!opsSeriesProduct.disabled && opsSeriesProduct.options.length>1'), 'inherited promotion products')
    await evaluate(page, 'opsSeriesExamples.click()')
    assert await evaluate(page, '!opsSeriesSamples.hidden && opsSeriesSamples.querySelectorAll("button").length===3')
    # A unique expected phrase permits independent DB/readback assertions.
    name = '闭环测试·笔记本效率系列'
    brief = '面向十人以下创业团队，每周两篇公众号图文。以会议纪要整理为唯一推广卖点，口吻像同行经验分享。必须写出栏目和节奏，禁止夸大自动决策能力。验收标记：云端技能闭环已核对。只完善文字设定，设定正文控制600字左右，不生成图片视频，不做外网调研。平台通行做法标明待补样本。写后MCP校验和读回即可，不要启动浏览器，页面由测试程序实测。回复只给要点和链接，不重复全文。'
    if args.natural_series:
        request = '在当前运营团队空间新增一个系列：新闻日报系列；面向客户为新闻日报社；主要关注国际民生，生成的视频或图文话题以正式官方国际民生相关。此次仅创建系列和约600字总体设定，不创建话题、不生成媒体、不发布；未做实时调研请如实标注。先查同名避免重复，用本轮授权MCP写入、check_data并读回，返回链接。不要启动浏览器，页面由测试程序核对。'
        await evaluate(page, 'opsSeriesDialog.close()')
        admission = await evaluate(page, 'soduWorkApp.chat.send({text:' + json.dumps(request) + ',requestId:"news-series-e2e"})')
        assert admission.get('ok'), admission
    else:
        await evaluate(page, 'opsSeriesName.value=' + json.dumps(name) + ';opsSeriesBrief.value=' + json.dumps(brief) + ';opsSeriesProduct.value="test";opsSeriesDialog.querySelector("form").requestSubmit()')
    async def state():
        if not any(p['id'] == page['id'] for p in pages()):
            raise RuntimeError('The isolated test app was closed outside this test; verification cannot continue')
        return await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(base + '/__e2e__/state', timeout=5)))
    async def created():
        value = await state()
        return value if len(value['series']) == 1 else None
    data = await until(created, 'real series row creation', 480 if args.natural_series else 40)
    series_id = data['series'][0]['id']; report['seriesId'] = series_id
    if not args.natural_series:
        assert data['series'][0]['data']['product_group'] == 'test'
    assert 'product_id' not in data['series'][0]['data']
    report['cases'].append('Natural-language app chat creates exactly one news series through MCP.' if args.natural_series else 'Actual form creates exactly one real PostgreSQL series with original brief and selected parent-enterprise product group.')
    async def settled_doc():
        value = await state()
        doc = next((r['data'].get('doc', '') for r in value['settings'] if r['id'] == series_id), '')
        if doc:
            report['docLength'] = len(doc)
            return value
        status = await evaluate(page, 'document.getElementById("opsSeriesStatus")?.textContent||""')
        if '失败' in status or '尚未确认' in status:
            report['sendStatus'] = status
            raise RuntimeError('H5 task was not accepted: ' + status)
        return None
    print(json.dumps({'stage': 'Waiting for real text model to use series-gen and write settings', 'space': info['space']}), flush=True)
    data = await until(settled_doc, 'real model series settings write', 480)
    assert len(data['series']) == 1
    report['cases'].append('Real configured text model receives H5 task through production native composer, invokes cloud MCP and persists series doc in preview table.')
    async def app_settled():
        return await evaluate(page, '!opsSeriesDialog.open && window.__mediaOpsRefreshCount>0')
    await until(app_settled, 'shell completion refresh', 240)
    await verify_tools('series')
    report['cases'].append('Shell turn-settled event refreshes real page data after the runtime completes.')
    check = await evaluate(page, '(async()=>{const r=await fetch("/api/mcp/check_data",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+localStorage.soduworkToken},body:JSON.stringify({space_id:' + json.dumps(info['space']) + '})});return await r.json()})()')
    assert check['errors'] == [], check
    report['checkData'] = {'errors': check['errors'], 'warnings': check.get('warnings', [])}
    screenshot = await call(page, 'Page.captureScreenshot', {'format': 'png'})
    (OUT / 'home-created.png').write_bytes(base64.b64decode(screenshot['data']))
    await call(page, 'Page.navigate', {'url': base + '/settings.html?space=' + info['space'] + '&series=' + series_id})
    page = await until(lambda: asyncio.sleep(0, result=next((p for p in pages() if p.get('url', '').startswith(base + '/settings.html')), None)), 'settings navigation')
    await until(lambda: evaluate(page, 'document.getElementById("doc")?.innerText.length>80'), 'real settings page doc')
    rendered = await evaluate(page, 'document.getElementById("doc").innerText')
    assert ('民生' if args.natural_series else '会议') in rendered and len(rendered) > 100
    report['renderedDocLength'] = len(rendered)
    screenshot = await call(page, 'Page.captureScreenshot', {'format': 'png'})
    (OUT / 'settings-readback.png').write_bytes(base64.b64decode(screenshot['data']))
    report['cases'].append('Actual settings.html renders the model-written series doc; check_data returns zero errors and no duplicate series.')
    await call(page, 'Page.navigate', {'url': base + '/list.html?space=' + info['space'] + '&series=' + series_id})
    page = await until(lambda: asyncio.sleep(0, result=next((p for p in pages() if p.get('url', '').startswith(base + '/list.html')), None)), 'topic list navigation')
    await until(lambda: evaluate(page, '!!document.getElementById("opsNewTopic")'), 'create topic action')
    assert await evaluate(page, 'opsNewTopic.tagName==="DIV" && !document.getElementById("opsSkillsButton") && !document.getElementById("opsSkillsDialog")')
    topic_brief = '帮我生成一个图文话题：' + ('国际民生公共服务观察，以正式官方口吻说明基本公共服务。' if args.natural_series else '三步整理创业小团队会议纪要。') + '只创建一个选题骨架和简短简介，kind=article，暂不生成正文、占位、图片或视频。不要启动浏览器，页面由测试程序实测。'
    await evaluate(page, 'opsNewTopic.click();opsTopicBrief.value=' + json.dumps(topic_brief) + ';opsTopicDialog.querySelector("form").requestSubmit()')
    print(json.dumps({'stage': 'Real series settings rendered; creating article topic through DIV action'}), flush=True)
    async def topic_created():
        value = await state()
        return value if len(value['topics']) == 1 else None
    data = await until(topic_created, 'real model article topic creation', 480)
    topic_id = data['topics'][0]['id']; report['topicId'] = topic_id
    report['stage'] = 'wait topic settlement and page refresh'
    await until(lambda: evaluate(page, 'window.__mediaOpsRefreshCount>0 && !opsTopicDialog.open'), 'topic shell refresh', 240)
    await verify_tools('topic')
    data = await state()
    report['topicKind'] = data['topics'][0]['data']['summary'].get('kind')
    assert report['topicKind'] == 'article', 'Expected article topic after settlement: ' + repr(data['topics'][0]['data']['summary'])
    title = data['topics'][0]['data']['summary']['title']
    await evaluate(page, '(()=>{const side=document.getElementById("side");if(side && getComputedStyle(side).display==="none")document.getElementById("hMenu").click()})()')
    await until(lambda: evaluate(page, 'document.body.innerText.includes(' + json.dumps(title) + ')'), 'topic title appears in real list', 30)
    report['cases'].append('DIV create-topic action and simple description automatically route article-gen through real conversation, persist one article topic and refresh it into the actual list; no skill picker.')
    screenshot = await call(page, 'Page.captureScreenshot', {'format': 'png'})
    (OUT / 'topic-list-readback.png').write_bytes(base64.b64decode(screenshot['data']))
    report['stage'] = 'verify article detail page'
    await call(page, 'Page.navigate', {'url': base + '/article.html?space=' + info['space'] + '&t=' + topic_id})
    page = await until(lambda: asyncio.sleep(0, result=next((p for p in pages() if p.get('url', '').startswith(base + '/article.html')), None)), 'article page navigation')
    await until(lambda: evaluate(page, '!!document.body?.innerText.includes(' + json.dumps(title) + ')'), 'created article detail title', 30)
    screenshot = await call(page, 'Page.captureScreenshot', {'format': 'png'})
    (OUT / 'article-detail-readback.png').write_bytes(base64.b64decode(screenshot['data']))
    report['cases'].append('New article skeleton opens its actual detail page before any images/storyboards exist.')
    report['ok'] = True


async def verify_tools(stage):
    trace = await evaluate(chatbar, '''soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref).then(r=>({
      ref:NativeChat.sessionInfo().ref,status:r.snapshot?.status,model:r.snapshot?.modelSelection?.name||r.snapshot?.model?.id,
      tools:(r.snapshot?.tools||[]).map(t=>({name:t.name,state:t.state,isError:t.isError,
      officialBridge:t.name==='bash'&&String(t.args?.command).includes('mcp.mjs'),
      bridgeFailure:t.isError&&t.name==='bash'&&String(t.args?.command).includes('mcp.mjs')&&
        /(?:失败：|错误：|参数不是合法 JSON|没有叫「|这个工具没有被当前插件|用法: mcp.mjs)/.test(String(t.result)),
      expectedMissingRead:t.isError&&t.name==='bash'&&/get_record/.test(String(t.args?.command))&&
        !/put_|create_record|update_record|delete_record/.test(String(t.args?.command))&&
        new RegExp('错误：(?:series|topics|topic_details)/[^ ]+ 不存在（空间 ').test(String(t.result)),
      bypass:t.name==='bash'&&/mcpcall\\.mjs|dumpschema\\.mjs|callfile\\.mjs/.test(String(t.args?.command))}))}))''')
    report.setdefault('toolTraces', {})[stage] = trace
    assert any(t['officialBridge'] for t in trace['tools']), 'No official MCP bridge call observed'
    assert not any((t['bridgeFailure'] and not t['expectedMissingRead']) or t['bypass'] for t in trace['tools']), 'MCP failure or bypass in model turn'


async def cleanup():
    if plugin_id:
        try:
            workspace = next(p for p in pages() if 'panel=workspace' in p.get('url', ''))
            await evaluate(workspace, 'soduWorkAPI.workPreview.destroy(' + json.dumps(tab_id) + ')')
            await evaluate(workspace, 'soduWorkAPI.personalPlugins.remove(' + json.dumps(plugin_id) + ')')
        except Exception as error:
            report['cleanupWarning'] = str(error)
    if fixture:
        if fixture.poll() is None:
            fixture.stdin.write('\n'); fixture.stdin.flush()
        try:
            remaining = await asyncio.wait_for(asyncio.to_thread(fixture.communicate), 20)
            report['rollbackConfirmed'] = '"rolledBack": true' in remaining[0]
        except Exception:
            fixture.terminate(); report['rollbackConfirmed'] = False


async def run():
    try: await main()
    except Exception as error:
        report['error'] = traceback.format_exc()
        print(json.dumps({'error': str(error)}, ensure_ascii=False), flush=True)
    finally:
        await cleanup()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False), flush=True)


asyncio.run(run())
sys.exit(0 if report['ok'] and report.get('rollbackConfirmed') else 1)
