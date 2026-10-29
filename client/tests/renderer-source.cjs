'use strict';
// Source contracts follow logical modules. Real file-size guards still read each
// physical file separately; this helper never changes production loading.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const dependencies = {
  'panels-schedules.css': ['panels-models.css', 'panels-skills.css'],
  'team.js': ['team-overview.js'],
  'panels-plugin-maker.js': ['panels-plugin-maker-fields.js'],
  'api.js': ['core/api-work-plugins.js'],
  'chat-plugin-mention.js': ['compose-candidate-navigation.js', 'chat-plugin-mention-model.js'],
  'panels-compose-skills.js': ['compose-candidate-navigation.js'],
  'panels-chat.css': ['chat-execution.css'],
  'panels-chat-tools.js': ['chat-dom-patch.js'],
  'chat-message-renderer.js': ['chat-acceptance-results.js', 'chat-turn-summary.js'],
  'chat-task-controller.js': ['chat-task-start.js'],
  'panels-chat.js': ['chat-composer-bindings.js', 'chat-session-controller.js', 'chat-task-start.js', 'chat-task-controller.js', 'chat-context-meter.js', 'chat-scroll-follow.js', 'chat-markdown.js', 'chat-acceptance-results.js', 'chat-message-renderer.js', 'chat-send-queue.js', 'chat-work-intent.js', 'chat-draft-recovery.js'],
  'panels-chat-workspace.js': ['chat-workspace-controls.js'],
  'panels-compose.js': ['compose-surface.js'],
  'panels-add.js': ['task-create-navigation.js'],
  'workspace-shell.js': ['workspace-chat-list.js', 'workspace-chat-history.js'],
  'workspace-shell.css': ['workspace-navigation.css', 'workspace-page-layout.css'],
  'session.js': ['session-resources.js', 'history-seed.js', 'session-open.js', 'session-handle.js', 'session-send.js', 'session-events.js'],
  'ipc.js': ['environment-ipc.js', 'history-ipc.js', 'goal-actions.js', 'open-reply.js', 'artifact-ipc.js', 'runtime-selection-ipc.js'],
};
function readFileSync(file, options) {
  const source = fs.readFileSync(file, options);
  if(typeof source !== 'string' || typeof file !== 'string') return source;
  if (path.basename(file) === 'api.js' && path.resolve(file) !== path.resolve(__dirname, '../api.js')) return source;
  const deps = dependencies[path.basename(file)];
  if(!deps) return source;
  return deps.map(name => fs.readFileSync(path.join(path.dirname(file), name), options)).join('\n') + '\n' + source;
}
function factoryMethods(file, name) {
  const window = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), {window});
  return window[name].create({});
}
function factoryFunction(file, name, method) {
  const fn = factoryMethods(file, name)[method];
  if (typeof fn !== 'function') throw Error(`Missing ${file}: ${method}`);
  return fn.toString() + '\n';
}
module.exports = {...fs, readFileSync, factoryMethods, factoryFunction};
