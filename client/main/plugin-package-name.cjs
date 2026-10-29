'use strict';

// Archive bytes and schema remain unchanged; both generations of suffixes work.
function archivePath(selectedPath) {
  const selected = String(selectedPath).replace(/\.json$/i, '');
  return /\.(?:soduwork-plugin|zip)$/i.test(selected)
    ? selected : selected + '.soduwork-plugin';
}

module.exports = { archivePath };
