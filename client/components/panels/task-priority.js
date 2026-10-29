/* Shared presentation of the persisted Hub priority values. */
(function (global) {
  'use strict';
  const labels = Object.freeze({ low: '低', normal: '普通', high: '高', critical: '紧急' });
  global.TaskPriority = Object.freeze({
    labels,
    values: Object.freeze(Object.keys(labels)),
    descriptions: Object.freeze({
      low: '不急，有空再说', normal: '正常排期', high: '优先做', critical: '需要立即处理',
    }),
  });
})(window);
