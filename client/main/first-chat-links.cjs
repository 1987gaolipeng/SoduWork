'use strict';

// External links can display these two desktop settings pages. They carry no
// Hub address, account, file path or action to execute.
const views = new Map([
  ['soduwork://first-chat/runtime', 'agents'],
  ['soduwork://first-chat/model', 'models'],
]);

function fromArgs(args = []) {
  return args.find(arg => views.has(arg)) || '';
}

module.exports = { fromArgs, view: url => views.get(url) };
