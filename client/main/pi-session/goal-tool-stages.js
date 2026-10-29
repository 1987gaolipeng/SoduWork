'use strict';

function restore(harness, tools) {
  const marks = (Array.isArray(harness && harness.progress) ? harness.progress : [])
    .map((item, index) => ({ item, index, toolCount: Number(item && item.toolCount) }))
    .filter((row) => Number.isFinite(row.toolCount));
  if (!marks.length) return;
  (Array.isArray(tools) ? tools : []).forEach((tool, index) => {
    const ordinal = index + 1;
    let boundary = 0;
    marks.forEach((row) => {
      if (row.toolCount >= ordinal) return;
      boundary = row.index + 1;
    });
    if (boundary) tool.goalProgressCount = boundary;
  });
}

function mark(tool, harness) {
  if (!tool) return;
  const progress = Array.isArray(harness && harness.progress) ? harness.progress : [];
  tool.goalProgressCount = progress.length;
  tool.goalPhase = String((harness && harness.phase) || '');
  tool.goalProgressEvent = progress.length
    ? String(progress[progress.length - 1].id || '') : '';
}

function evidenceStart(harness, tools, fallback) {
  const rows = Array.isArray(tools) ? tools : [];
  const from = harness && harness.evidenceToolFrom;
  if (Number.isInteger(from) && from >= 0 && from <= rows.length) return from;
  const start = (Array.isArray(harness && harness.progress) ? harness.progress : [])
    .find(item => item && item.type === 'run.started' && Number.isInteger(item.toolCount));
  if (start && start.toolCount >= 0 && start.toolCount <= rows.length) return start.toolCount;
  const index = rows.findIndex(item => item && /^goal-/.test(String(item.scope || '')));
  return index >= 0 ? index : fallback;
}

module.exports = { mark, restore, evidenceStart };
