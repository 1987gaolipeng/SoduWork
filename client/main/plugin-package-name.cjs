'use strict';

// Archive bytes and schema use the current SoduWork package suffix.
function archivePath(selectedPath) {
  const selected = String(selectedPath).replace(/\.json$/i, '');
  return /\.(?:soduwork-plugin|zip)$/i.test(selected)
    ? selected : selected + '.soduwork-plugin';
}

module.exports = { archivePath };
