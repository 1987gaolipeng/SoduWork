/* Serialize explicit selection changes; old responses cannot erase later clicks. */
(function (global) {
  'use strict';
  function create(options) {
    let base = {company: [], personal: [], enabledCompany: []};
    let pending = new Map(), serial = 0, epoch = 0, running = null, error = '';
    const key = item => item.kind + ':' + item.id;
    function view() {
      const result = {...base, personal: (base.personal || []).map(x => ({...x}))};
      const selected = new Set(base.enabledCompany || []);
      for (const change of pending.values()) {
        if (change.kind === 'company') change.enabled ? selected.add(change.id) : selected.delete(change.id);
        else { const row = result.personal.find(x => x.id === change.id); if (row) row.enabled = change.enabled; }
      }
      result.enabledCompany = [...selected];
      return result;
    }
    const state = () => ({saving: !!running, pending: pending.size, error});
    const emit = () => options.onChange(view(), state());
    function replace(value) { base = value; emit(); }
    function reset(value) {
      epoch++; pending.clear(); running = null; error = ''; base = value || {company: [], personal: [], enabledCompany: []}; emit();
    }
    function toggle(kind, id) {
      const current = view();
      if (kind === 'company' ? !(current.company || []).some(x => x.name === id) : !current.personal.some(x => x.id === id)) return;
      const enabled = kind === 'company' ? !current.enabledCompany.includes(id) : !current.personal.find(x => x.id === id).enabled;
      pending.set(kind + ':' + id, {kind, id, enabled, revision: ++serial});
      error = ''; emit(); void flush();
    }
    function flush() {
      if (running) return running;
      if (!pending.size) return Promise.resolve(true);
      error = '';
      const generation = epoch;
      running = Promise.resolve().then(async () => {
        try {
          while (pending.size && generation === epoch) {
            const batch = [...pending.values()].slice(0, 50);
            const result = await options.save(batch.map(({revision, ...item}) => item));
            if (generation !== epoch) return false;
            base = result;
            for (const item of batch) if (pending.get(key(item))?.revision === item.revision) pending.delete(key(item));
            if (result.warning) options.onWarning?.(result.warning);
            emit();
          }
          return true;
        } catch (e) {
          if (generation === epoch) error = options.errorText?.(e) || String(e.message || e);
          return false;
        } finally {
          if (generation === epoch) { running = null; emit(); }
        }
      });
      emit(); return running;
    }
    return {view, state, replace, reset, toggle, flush};
  }
  global.SoduWorkConnectorSelection = {create};
})(typeof window === 'undefined' ? globalThis : window);
