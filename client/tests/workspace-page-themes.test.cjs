const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('workspace business pages opt into the same compact single-title layout',()=>{
  for(const file of ['requirements/requirements-board.js','panels/panels-schedules.js','panels/panels-capabilities.js','reports/work-briefs.js','panels/panels-desk.js'])
    assert.match(read('components/'+file),/ws-page-head/,file);
  for(const entry of ['desk.html','index.html'])assert.match(read(entry),/theme\/workspace-page-heads\.css/);
  const css=read('theme/workspace-page-heads.css');
  assert.match(css,/#schPanel,#historyBoard,#capPanel,#briefPanel,#aiDeskPanel/);
  assert.match(css,/\.dk-title-name/);
  assert.match(css,/--ws-head-height:60px/);
  assert.match(css,/display:none!important/);
  assert.match(css,/650 18px/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/:focus-visible/);
});
test('requirement and action controls use skin tokens instead of a fixed blue',()=>{
  for(const file of ['requirements-board.css']){
    const css=read('components/requirements/'+file);
    assert.doesNotMatch(css,/#(?:397fe9|246fe5|4384f6|3d8bff|edf4ff|fafdff|91b8ec)\b/i,file);
    assert.match(css,/var\(--accent\)/);
    assert.match(css,/var\(--bg-0\)/);
    assert.match(css,/var\(--s-done(?:,|\))/);
    assert.doesNotMatch(css,/\d+\.\d{10,}%/);
  }
});
