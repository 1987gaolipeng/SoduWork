/* The desktop overlay only owns the pet and shortcuts. Requirements live in the workspace. */
let petRefreshTimer = null;
function render() {
  clearTimeout(petRefreshTimer); petRefreshTimer = null;
  if (typeof updatePet === 'function') updatePet();
  if (typeof _paintDock === 'function') _paintDock();
}
function renderSoon() {
  if (petRefreshTimer) return;
  petRefreshTimer = setTimeout(render, 110);
}
