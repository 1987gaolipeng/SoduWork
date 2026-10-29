/* ===== Device identity (core/user.js) =====
   A locally generated device ID (u-xxx) and editable display name, both stored on this device.
   - User.id: generated on first launch and persisted in localStorage until storage is cleared.
   - userName: editable local display name.
   Dependencies: none; this logic layer is consumed by skin-registry and skin-manager.

   User.id is the device ID sent in X-Soduwork-Device, not the backend user UUID.
   Task fields such as createdBy, assigneeUserId, and reviewedBy contain backend user UUIDs;
   comparing them with User.id cannot identify the current owner.
   Use window.__teamCap.meId for the device owner; app.js populates it through
   _probeTeamCap from /team/capability during startup. */

const User = (function () {
  const LS_UID = 'soduwork_work_user_id';
  const LS_UNAME = 'soduwork_work_user_name';

  function _genId() {
    return 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  let _id = localStorage.getItem(LS_UID);
  if (!_id) {
    _id = _genId();
    localStorage.setItem(LS_UID, _id);
  }
  let _name = localStorage.getItem(LS_UNAME) || '';

  return {
    get id() { return _id; },
    get name() { return _name; },
    get hasName() { return !!_name; },

    /* Set the local display name without connecting to a separate skin service. */
    async setName(name) {
      _name = String(name || '').slice(0, 30);
      localStorage.setItem(LS_UNAME, _name);
      return _name;
    },

    /* Retain the legacy entry point; the public build does not sync profiles from a separate skin service. */
    async fetchProfile() {}
  };
})();
