/* Assignment directory for the task form. Kept separate from task creation so the form stays small and focused. */
function _addMateAvailable(item) {
  if (!item || typeof item !== 'object') return false;
  const flag = Object.prototype.hasOwnProperty.call(item, 'canReceive')
    ? item.canReceive
    : Object.prototype.hasOwnProperty.call(item, 'hasBox')
      ? item.hasBox : (item.available !== undefined ? item.available : item.soduWorkEnabled);
  if (flag === true || flag === 1) return true;
  return ['1', 'true', 'yes'].includes(String(flag == null ? '' : flag).trim().toLowerCase());
}

let _addAssignLoadSeq = 0;
let _addAssignLoading = false;
let _addAssignMembers = [];
let _addAssignPending = Promise.resolve();

/*
 * Load assignment options in parallel on opening; submission awaits that same load rather
 * than silently failing after a quick click.
 */
function _requestPopulateAssign() {
  const pending = _populateAssign();
  _addAssignPending = pending;
  return pending;
}

async function _populateAssign() {
  const field = document.getElementById('assignField');
  const sel = document.getElementById('inAssign');
  if (!field || !sel) return;
  const seq = ++_addAssignLoadSeq;
  _addAssignLoading = true;
  _addAssignMembers = [];
  field.style.display = '';
  sel.disabled = true;
  sel.innerHTML = '<option value="">正在检查可用同事…</option>';
  if (!(window.SoduWorkAPI && SoduWorkAPI.listTeammates)) {
    _addAssignLoading = false;
    field.style.display = 'none';
    return;
  }
  try {
    const directory = await SoduWorkAPI.listTeammates();
    if (seq !== _addAssignLoadSeq || document.getElementById('inAssign') !== sel) return;
    if (!directory || directory.ok === false) {
      _addAssignLoading = false;
      field.style.display = 'none';
      return;
    }
    const byId = new Map();
    ((directory && directory.mates) || []).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const id = String(item.id || item.userId || item.uid || '').trim();
      if (!id || !_addMateAvailable(item)) return;
      const key = id.toLowerCase();
      const old = byId.get(key);
      if (!old) {
        byId.set(key, { id, name: String(item.name || item.displayName || item.username || '未命名同事').trim(),
          org: String(item.org || item.orgName || item.department || '').trim() });
      } else if (!old.name && item.name) {
        old.name = String(item.name).trim();
      }
    });
    const members = Array.from(byId.values()).sort((a, b) =>
      a.org.localeCompare(b.org, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    _addAssignMembers = members;
    _addAssignLoading = false;
    if (!members.length) { field.style.display = 'none'; return; }
    sel.innerHTML = '<option value="">我自己</option>' +
      members.map((m) => '<option value="' + esc(m.id) + '">' +
        esc(m.name + (m.org ? ' · ' + m.org : '')) + '</option>').join('');
    sel.value = '';
    sel.disabled = false;
    field.style.display = '';
    sel.onchange = () => {
      const af = document.getElementById('addAttField');
      if (af) af.style.display = '';
      const hp = document.getElementById('handlerPick');
      const hf = hp && hp.closest('.field');
      if (hf) hf.style.display = 'none';
    };
  } catch (e) {
    if (seq !== _addAssignLoadSeq || document.getElementById('inAssign') !== sel) return;
    _addAssignLoading = false;
    _addAssignMembers = [];
    field.style.display = 'none';
  }
}
