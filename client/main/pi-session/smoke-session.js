/*
 * Live session smoke test uses actual device credentials, Hub proxy, model, skills, and
 * tools. Run with a compatible Electron Node runtime on an enrolled installation with
 * model configuration. Only app directory lookup is stubbed; this test incurs real service
 * activity.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('./session');

/*
 * Discover skill directories through the same application path instead of testing a
 * manually narrowed fixture list.
 */
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', '..', 'skills');
const SKILL = path.join(SKILLS_ROOT, 'computer-use');
const ALL_SKILLS = (() => {
  try {
    return fs.readdirSync(SKILLS_ROOT).map((n) => path.join(SKILLS_ROOT, n))
      .filter((d) => { try { return fs.existsSync(path.join(d, 'SKILL.md')); } catch (e) { return false; } });
  } catch (e) { return [SKILL]; }
})();
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-smoke-'));
const WORK = path.join(BASE, 'work');
const USERDATA = path.join(BASE, 'userdata');

let failed = 0;
function chk(name, ok, detail) {
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : '   → ' + JSON.stringify(detail)) + '\n');
  if (!ok) failed += 1;
}

const fakeApp = { isPackaged: false, getPath: () => USERDATA };

function identityFile() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  /* Check the current user-data directory and legacy installations when locating smoke-test identity. */
  for (const name of ['SoduWork']) {
    const file = path.join(roaming, name, 'runner', 'config.json');
    try { if (fs.existsSync(file)) return file; } catch (e) { /* Try the next candidate. */ }
  }
  return path.join(roaming, 'SoduWork', 'runner', 'config.json');
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(USERDATA, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'hello.txt'), '这是冒烟用的样本文件\n', 'utf8');
  process.stdout.write('运行时 node=' + process.versions.node +
    (process.versions.electron ? ' electron=' + process.versions.electron : ' (系统 node)') +
    '\n临时目录 ' + BASE + '\n\n');

  const p = await session.probe(fakeApp);
  chk('probe：这个运行时能加载 pi 内核', p.ok, p);
  if (!p.ok) {
    process.stdout.write('\n内核加载不了，后面不用跑了。这在 Electron 30 上是预期结果。\n');
    process.exit(1);
  }

  const identity = JSON.parse(fs.readFileSync(identityFile(), 'utf8'));
  chk('拿到设备身份', !!(identity.hub && identity.clientId && identity.secret), { hub: identity.hub });

  const opened = await session.open({
    app: fakeApp, identity, cwd: WORK, skillDirs: ALL_SKILLS, taskRef: 'smoke-001',
  });
  chk('会话起来了', opened.ok, opened);
  if (!opened.ok) process.exit(1);
  const s = opened.session;

  chk('模型是后端指派的那个', !!s.model.id, s.model.id);
  chk('taskRef 带住了（对话能挂在任务上）', s.taskRef === 'smoke-001', s.taskRef);

  const mj = fs.readFileSync(path.join(USERDATA, 'pi-agent', 'models.json'), 'utf8');
  chk('★models.json 里只有变量引用，没有明文密钥',
    mj.indexOf('$SODUWORK_PROXY_KEY') >= 0 && mj.indexOf(identity.secret) < 0, mj.slice(0, 120));
  /*
   * Use session-specific additionalSkillPaths rather than copying into a shared agent
   * directory that concurrent sessions could overwrite.
   */
  const activeSkills = new Set(s.skills || []);
  chk('★computer-use 只挂到本次会话', activeSkills.has('computer-use'), [...activeSkills]);
  chk('★task 只挂到本次会话', activeSkills.has('task'), [...activeSkills]);
  chk('★mcp-tools 桥接技能只挂到本次会话', activeSkills.has('mcp-tools'), [...activeSkills]);
  chk('★没有把会话能力复制进共享目录',
    !fs.existsSync(path.join(USERDATA, 'pi-agent', 'skills', 'computer-use')), USERDATA);

  const mcpFile = path.join(USERDATA, 'pi-agent', 'mcp', 'servers.json');
  chk('★MCP 配置写好了（桥靠 SODUWORK_MCP_SERVERS 找它）',
    fs.existsSync(mcpFile) && process.env.SODUWORK_MCP_SERVERS === mcpFile, process.env.SODUWORK_MCP_SERVERS);
  if (fs.existsSync(mcpFile)) {
    const m = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    chk('★soduwork 这条是 http 型、指向本机 hub',
      m.servers && m.servers.soduwork && m.servers.soduwork.type === 'http' &&
      String(m.servers.soduwork.url).startsWith(identity.hub.replace(/\/+$/, '')),
      m.servers && m.servers.soduwork);
  }

  const seen = [];
  s.on((touched) => { if (touched && touched.kind !== 'ignored') seen.push(touched.kind); });

  process.stdout.write('\n  …真跑一轮（读工作目录里的 hello.txt）\n\n');
  const sent = await s.send('读一下当前目录里的 hello.txt，然后用一句话复述它的内容。不要操作桌面。');
  chk('这一轮跑成了', sent.ok, sent);

  const snap = s.snapshot();
  chk('状态收敛成 idle（不是 unreachable）', snap.status === 'idle',
    { status: snap.status, text: snap.statusText });
  chk('产生了 token', (snap.usage && snap.usage.totalTokens) > 0, snap.usage);

  const blocks = snap.messages.flatMap((m) => m.blocks);
  const texts = blocks.filter((b) => b.kind === 'text' && b.text.trim());
  chk('有正文', texts.length > 0, blocks.map((b) => b.kind + '#' + b.index));
  chk('★真调了工具', snap.tools.length > 0, snap.tools.map((t) => t.name));
  /* Find the actual read result rather than assuming the first successful tool performed the read. */
  const done = snap.tools.find((t) => t.state === 'done' && String(t.result).indexOf('冒烟') >= 0);
  chk('工具跑成了并拿回内容', !!done && String(done.result).indexOf('冒烟') >= 0,
    done ? String(done.result).slice(0, 80) : null);
  chk('事件里既有块又有工具', seen.indexOf('block') >= 0 && seen.indexOf('tool') >= 0, seen.slice(0, 12));

  process.stdout.write('\n  ---- 正文 ----\n  ' + texts.map((b) => b.text.trim()).join('\n  ') +
    '\n  ---- usage ---- ' + JSON.stringify(snap.usage) + '\n');

  s.close();
  chk('关掉之后会话表里没有它了', session.get(s.ref) === null, session.list().length);

  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* Leaving the optional artifact is harmless. */ }
  process.stdout.write('\n' + (failed ? '  ✗ ' + failed + ' 项没过\n' : '  ✅ 全过\n'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stdout.write('\n  ✗ 冒烟中断：' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
