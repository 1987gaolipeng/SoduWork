/* Shared 24-unit glyphs for the desktop dock and workspace navigation.
   Geometry stays the same across themes and selected states. */
(function (global) {
  'use strict';

  const dock = Object.freeze({
    home: '<path d="M3.25 10.85 12 3.55l8.75 7.3"/><path d="M5.35 9.15v10.45c0 .95.75 1.7 1.7 1.7h2.25v-6.35h5.4v6.35h2.25c.95 0 1.7-.75 1.7-1.7V9.15"/>',
    automation: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.5v4.75l3.25 2"/>',
    compose: '<path d="M13.5 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7.5"/><path d="M10 14l.7-3.2L17.5 4a1.8 1.8 0 0 1 2.5 2.5l-6.8 6.8z"/>',
    taskboard: '<path d="M4 8.5h16v10.25A1.75 1.75 0 0 1 18.25 20.5H5.75A1.75 1.75 0 0 1 4 18.75Z"/><path d="M3.5 8.5 5.1 4h13.8l1.6 4.5M3.5 8.5h17M9 12h6"/>',
    notice: '<path d="M18.6 16.5H5.4c.95-1.25 1.45-2.95 1.45-5.65V9.9a5.15 5.15 0 0 1 10.3 0v.95c0 2.7.5 4.4 1.45 5.65Z"/><path d="M9.6 19.2h4.8M10.4 19.2a1.6 1.6 0 0 0 3.2 0"/>',
    approval: '<path d="M12 3l7 2.8v5.3c0 4.3-2.8 7.9-7 9.4-4.2-1.5-7-5.1-7-9.4V5.8z"/><path d="M9.2 12.1l2 2 3.6-3.8"/>',
  });

  global.SoduWorkIconRegistry = Object.freeze({ dock });
})(window);
