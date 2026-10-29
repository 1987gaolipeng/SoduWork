const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'../components/panels/chat-collaboration.css'),'utf8').replace(/\r\n/g,'\n');
const pickerSource=fs.readFileSync(path.join(__dirname,'../components/panels/chat-collaboration.js'),'utf8');
const picker=css.slice(css.indexOf('.ncollab-picker{\n'),css.indexOf('.ncollab-session-notice{z-index:'));
test('task picker shares semantic foreground, surface and theme accent tokens',()=>{
 for(const rule of ['--task-ink:var(--ink)','--task-muted:var(--ink-3)','--task-line:var(--line)','--task-wash:var(--bg-1)','--task-accent:var(--accent)','--picker-soft:var(--accent-soft)'])assert.ok(css.includes(rule),rule);
 assert.doesNotMatch(picker,/#(?!fff(?:[;}]|\b))[0-9a-f]{3,8}\b/i);
});
test('task picker uses product font families, never local Windows font overrides',()=>{
 assert.match(css,/var\(--font-ui,system-ui\)/);assert.match(picker,/var\(--font-display,var\(--font-ui,system-ui\)\)/);
 assert.doesNotMatch(css,/Segoe UI|Microsoft YaHei/);
});
test('task picker uses a compact fixed scale with a 12px readable floor',()=>{
 assert.match(picker,/--task-text-xs:12px/);assert.match(picker,/--task-text-sm:13px/);
 assert.match(picker,/--task-text-base:14px/);assert.match(picker,/--task-text-title:18px/);
 assert.doesNotMatch(picker,/--task-text-(?:xs|sm|base|title):[^;]*var\(--font-scale/);
 assert.doesNotMatch(picker,/font-size:\s*\d+px/);assert.doesNotMatch(picker,/font-size:[^;}]+!important/);
});
test('search focus, hover, checked and disabled states use theme tokens',()=>{
 for(const text of ['border-color:var(--accent)','background:var(--accent-hover)','background:var(--picker-soft)','background:var(--bg-2);color:var(--ink-4)','border-color:var(--picker-line)'])assert.ok(picker.includes(text),text);
});
test('task picker inherits shared radii, shadows and scrollbar without local chrome',()=>{
 assert.match(picker,/border-radius:var\(--r-xl\)/);assert.match(picker,/box-shadow:var\(--shadow-xl\)/);
 assert.doesNotMatch(picker,/scrollbar-width|scrollbar-color/);
 assert.match(css,/prefers-reduced-motion:reduce/);
});
test('task picker stays concise and keeps its own 12px readable floor',()=>{
 assert.match(picker,/--font-min-readable:12px/);
 assert.doesNotMatch(pickerSource,/保留当前会话的上下文、Agent、模型与工作目录/);
 assert.doesNotMatch(pickerSource,/带入说明与材料，按当前会话顺序执行/);
 assert.match(pickerSource,/暂无可添加的待办/);
 assert.match(pickerSource,/未选择需求/);
});
