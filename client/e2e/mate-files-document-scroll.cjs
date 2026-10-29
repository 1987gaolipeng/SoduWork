'use strict';
// Use real Chromium components and styles with local fixture file selection and sending.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mate-scroll-'));
app.setPath('userData', path.join(temp, 'profile'));
let win;
const checks = [];
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let n = 0; n < 100; n++) {
    if (await js(code)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('等待超时：' + code);
}
app.whenReady().then(async () => {
  const href = file => pathToFileURL(path.join(root, file)).href;
  const css = ['panels-chat.css', 'code-workbench.css', 'chat-workbench-toolbar.css', 'chat-plugin-mention.css'];
  const fixture = path.join(temp, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
    ${css.map(file => `<link rel="stylesheet" href="${href('components/panels/' + file)}">`).join('')}
    <style>body{margin:0;font:15px sans-serif}#doc{height:400px;width:500px;display:flex;flex-direction:column}
    #host{position:relative;margin-top:30px}.nmate-card{position:fixed;top:10px;bottom:auto;left:10px}</style>
    <section id="doc"><div class="ncw-body"><div class="ncw-dochead">文档工具栏</div>
    <div class="ncw-code-modebar"><button>源码</button><button>Diff</button></div>
    <div class="ncw-truncated">截断提示占位</div><div class="ncw-markdown">
    ${'<p>长文内容：验证末尾在滚到底时可以完整显示。</p>'.repeat(100)}<p id="last">文档最后一行</p></div></div></section>
    <div id="host"><textarea id="input"></textarea></div>
    <script src="${href('components/panels/chat-mate-mention.js')}"></script>
    <script>
      window.sent=[];window.messages=[];window.currentRef='test';
      ChatMateMention.create({input:document.querySelector('#input'),host:document.querySelector('#host'),
        mates:async()=>({mates:[{id:'mate',name:'同事',hasBox:true}]}),
        context:()=>({ref:currentRef,api:{outputs:async()=>({ok:true,artifacts:[]})}}),
        progress:async()=>({text:'已完成，附件请查收'}),say:text=>messages.push(text),
        send:async(id,text,outputs)=>{sent.push(outputs);return {ok:true,messageId:'saved',status:'accepted'}}});
      window.choose=()=>{const input=document.querySelector('#input');input.value='@同事';
        input.selectionStart=input.selectionEnd=input.value.length;input.dispatchEvent(new Event('input',{bubbles:true}))};
      window.pick=(files)=>{const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));
        const input=document.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change'))};
    </script>`);
  win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { offscreen: true } });
  await win.loadFile(fixture);
  for (const width of [500, 280]) {
    for (const zoom of [1, 1.5]) {
      win.webContents.setZoomFactor(zoom);
      const result = await js(`(()=>{document.querySelector('#doc').style.width='${width}px';
        const body=document.querySelector('.ncw-body'), md=document.querySelector('.ncw-markdown');
        md.scrollTop=md.scrollHeight;const last=document.querySelector('#last').getBoundingClientRect();
        return {last:last.bottom,body:body.getBoundingClientRect().bottom,md:md.getBoundingClientRect().bottom,
          scrollable:md.scrollHeight>md.clientHeight}})()`);
      assert.ok(result.scrollable && result.last <= result.body + 1 && result.md <= result.body + 1, JSON.stringify(result));
      checks.push(`长文末尾可见 ${width}px / ${zoom}`);
    }
  }
  win.webContents.setZoomFactor(1);
  async function open() {
    await js('choose()'); await until('!!document.querySelector(".nmate-menu .nplugin-option")');
    await js('document.querySelector(".nmate-menu .nplugin-option").click()');
    await until('!document.querySelector(".nmate-card-send").disabled');
  }
  await open();
  await js(`pick([new File(['正文'], '嵌套目录中的需求.md'),new File([new Uint8Array([0,255,128,10])], '接口.docx')])`);
  await until('document.querySelectorAll(".nmate-result-row").length===2');
  await js('document.querySelector(".nmate-card-send").click()');
  await until('sent.length===1');
  const files = await js('sent[0].files');
  assert.deepEqual(files.map(f => f.name), ['嵌套目录中的需求.md', '接口.docx']);
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), '正文');
  assert.deepEqual([...Buffer.from(files[1].data, 'base64')], [0,255,128,10]);
  checks.push('手动多选文件通过现有发送链路保留文件名和字节');
  await open();
  await js(`pick([new File([new Uint8Array(21*1024*1024)],'过大.bin')])`);
  await until('messages.length>0');
  assert.equal(await js('document.querySelectorAll(".nmate-result-row").length'), 0);
  assert.match(await js('messages.at(-1)'), /20 MB/);
  checks.push('超限文件拒收且可继续操作');
  await js(`pick(Array.from({length:21},(_,i)=>new File(['x'],i+'.txt')))`);
  assert.match(await js('messages.at(-1)'), /20 份/);
  checks.push('超出数量限制整批拒收');
  await js(`pick([new File([new Uint8Array(13*1024*1024)],'a.bin'),new File([new Uint8Array(13*1024*1024)],'b.bin')])`);
  assert.match(await js('messages.at(-1)'), /24 MB/);
  assert.equal(await js('document.querySelectorAll(".nmate-result-row").length'), 0);
  checks.push('总大小超限整批拒收');
  await js(`pick([new File(['甲'],'同名.md'),new File(['乙'],'同名.md')])`);
  await until('document.querySelectorAll(".nmate-result-row").length===2');
  await js(`document.querySelector('.nmate-result-row input').click();document.querySelector('.nmate-card-send').click()`);
  await until('sent.length===2');
  assert.equal(await js('sent[1].files.length'), 1);
  assert.equal(Buffer.from(await js('sent[1].files[0].data'), 'base64').toString(), '乙');
  checks.push('同名文件独立勾选，取消项不发送');
  await open();
  await js(`pick([new File(['x'],'取消后不得回填.txt')]);document.querySelector('.nmate-card-close').click()`);
  await open();
  assert.equal(await js('document.querySelectorAll(".nmate-result-row").length'), 0);
  checks.push('关闭重开隔离迟到文件读取');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (win) win.destroy(); app.quit();
});
