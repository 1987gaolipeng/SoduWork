/* Shared, stateless navigation over the exact rows displayed in a chooser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ComposeCandidateNavigation = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function move(rows, index, direction, selectable) {
    const count = rows.length;
    if (!count) return -1;
    const delta = direction < 0 ? -1 : 1;
    let next = index >= 0 && index < count ? index : (delta > 0 ? -1 : 0);
    for (let step = 0; step < count; step++) {
      next = (next + delta + count) % count;
      if (selectable(rows[next])) return next;
    }
    return -1;
  }

  function normalize(rows, index, selectable) {
    return index >= 0 && index < rows.length && selectable(rows[index])
      ? index : move(rows, -1, 1, selectable);
  }

  // Adjust only this overflow container. scrollIntoView can move the workspace
  // and interrupt transcript reading when menus sit inside nested scrollers.
  function reveal(menu, option) {
    if (!menu || !option || !menu.clientHeight) return;
    const viewport = menu.getBoundingClientRect();
    const bounds = option.getBoundingClientRect();
    const top = viewport.top + menu.clientTop;
    const bottom = top + menu.clientHeight;
    if (bounds.top < top) menu.scrollTop += bounds.top - top;
    else if (bounds.bottom > bottom) menu.scrollTop += bounds.bottom - bottom;
  }

  function highlight(menu, input, selector, activeClass, index, revealActive) {
    const options = menu.querySelectorAll(selector);
    options.forEach((option, row) => {
      const active = row === index;
      option.classList.toggle(activeClass, active);
      // Skill aria-selected represents chosen chips; plugin aria-selected
      // already represents its current keyboard option.
      if (activeClass === 'is-active') option.setAttribute('aria-selected', String(active));
    });
    const option = options[index];
    if (option) input.setAttribute('aria-activedescendant', option.id);
    else input.removeAttribute('aria-activedescendant');
    if (revealActive) reveal(menu, option);
  }

  return { move, normalize, reveal, highlight };
});
