/* Shared display-only projection of Runner tool inputs. Never used for execution. */
(function (global) {
  'use strict';
  const files = /^(?:read|read_file|open_file|write|write_file|create_file|edit|edit_file|replace|replace_in_file|delete|delete_file|remove_file|unlink)$/i;
  const commands = /^(?:bash|shell|command|exec|exec_command|run_shell_command|command_execution|terminal|run|write_stdin)$/i;
  const pathKeys = ['path', 'file_path', 'filePath', 'filepath', 'filename', 'file', 'target'];
  function kind(item) {
    const declared = String(item.toolKind || '').toLowerCase();
    if (['execute', 'command', 'terminal'].includes(declared)) return 'command';
    if (['read', 'write', 'edit', 'delete', 'remove'].includes(declared)) return 'file';
    if (['search', 'list'].includes(declared)) return declared;
    const name = String(item.tool || item.toolName || item.name || '');
    if (commands.test(name)) return 'command';
    if (files.test(name)) return 'file';
    if (/^(?:grep|search)(?:_files)?$/i.test(name)) return 'search';
    if (/^(?:ls|list|glob|find)(?:_files|_directory)?$/i.test(name)) return 'list';
    return '';
  }
  function normalize(item) {
    const input = item.arguments || item.args, type = kind(item);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      // Older cloud journals put every do.text into command, even for read/write.
      // Repair that exact shape only with explicit file semantics; never infer a
      // path from a shell command, an MCP name or an arbitrary argument object.
      if (type === 'file' && Object.keys(input).length === 1 && typeof input.command === 'string' &&
          input.command && !pathKeys.some(key => input[key])) return { path: input.command };
      return input;
    }
    const text = String(item.full || item.text || '');
    if (type === 'file' || type === 'list') return text ? { path: text } : {};
    if (type === 'command') return { command: text };
    if (type === 'search') return { query: text };
    return text ? { detail: text } : {};
  }
  const api = { normalize, kind };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ExecutionToolArgs = api;
})(typeof window === 'undefined' ? globalThis : window);
