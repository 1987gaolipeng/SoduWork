/* Folder navigation shared by ZIP files and conversation delivery packages. */
(function (global) {
  'use strict';
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const parent = path => path.split('/').slice(0, -1).join('/');
  const size = value => value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KB' : (value / 1048576).toFixed(1) + ' MB';
  function findEntry(files) {
    // ZIP tools often add a single enclosing folder and macOS metadata. Only
    // descend through that unambiguous wrapper; mixed documents stay browsable.
    const entries = (files || []).filter(file => file.path && !file.path.split('/').some(part => part.startsWith('.') || part === '__MACOSX'));
    let folder = '';
    for (let depth = 0; depth < 32; depth++) {
      for (const name of ['index.html', 'index.htm']) {
        const file = entries.find(file => !file.isDirectory && parent(file.path) === folder && file.path.split('/').pop().toLowerCase() === name);
        if (file) return file;
      }
      const prefix = folder ? folder + '/' : '';
      const children = new Set(entries.filter(file => file.path.startsWith(prefix)).map(file => file.path.slice(prefix.length).split('/')[0]).filter(Boolean));
      if (children.size !== 1) break;
      const next = prefix + [...children][0];
      if (entries.some(file => file.path === next && !file.isDirectory) || !entries.some(file => file.path.startsWith(next + '/'))) break;
      folder = next;
    }
    return null;
  }
  function create({ files, name, onFile, onFolder }) {
    const entries = new Map();
    for (const file of files) {
      const path = String(file.path || '').replace(/\/$/, '');
      if (!path) continue;
      entries.set(path, { ...file, path, filename: path.split('/').pop() });
      let folder = parent(path);
      while (folder) {
        if (!entries.has(folder)) entries.set(folder, { path: folder, filename: folder.split('/').pop(), isDirectory: true });
        folder = parent(folder);
      }
    }
    const element = node('aside', 'library-preview-archive'); element.setAttribute('aria-label', '压缩包文件');
    const top = node('div', 'library-archive-heading');
    const home = node('button', 'library-archive-home', name); home.type = 'button'; home.dataset.archiveRoot = ''; home.title = name;
    home.setAttribute('data-user-content', ''); top.append(home);
    const location = node('div', 'library-archive-location');
    const up = node('button', '', '↑'); up.type = 'button'; up.dataset.archiveUp = ''; up.title = '返回上一级'; up.setAttribute('aria-label', '返回上一级');
    const pathLabel = node('span', '', '全部文件'); pathLabel.setAttribute('data-user-content', ''); location.append(up, pathLabel);
    const listing = node('nav', 'library-archive-list'); listing.setAttribute('aria-label', '文件夹内容');
    const summary = node('div', 'library-archive-summary');
    element.append(top, location, listing, summary);
    let folder = '', selected = '';
    function mark() { listing.querySelectorAll('[data-archive-file]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.archiveFile === selected))); }
    function show(path, notify = true) {
      folder = path; selected = ''; up.disabled = !folder;
      pathLabel.textContent = folder || '全部文件'; pathLabel.title = folder || '全部文件';
      const children = [...entries.values()].filter(file => parent(file.path) === folder)
        .sort((a, b) => Number(Boolean(b.isDirectory)) - Number(Boolean(a.isDirectory)) || a.filename.localeCompare(b.filename, 'zh-CN', { numeric: true }));
      listing.replaceChildren();
      for (const file of children) {
        const b = node('button', 'library-archive-entry'); b.type = 'button'; b.title = file.path;
        const icon = node('span', 'library-archive-icon', file.isDirectory ? '' : (file.filename.includes('.') ? file.filename.split('.').pop().toUpperCase().slice(0, 5) : 'FILE'));
        if (file.isDirectory) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('fill', 'none');
          const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          shape.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z');
          shape.setAttribute('stroke', 'currentColor'); shape.setAttribute('stroke-width', '1.5'); shape.setAttribute('stroke-linejoin', 'round'); svg.append(shape); icon.append(svg);
        }
        icon.setAttribute('aria-hidden', 'true');
        const copy = node('span', 'library-archive-copy'); const label = node('b', '', file.filename); label.setAttribute('data-user-content', ''); copy.append(label);
        copy.append(node('small', '', file.isDirectory ? '文件夹' : size(Number(file.size) || 0))); b.append(icon, copy);
        if (file.isDirectory) { b.dataset.archiveFolder = file.path; b.addEventListener('click', () => show(file.path)); }
        else { b.dataset.archiveFile = file.path; b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', () => { selected = file.path; mark(); onFile(file); }); }
        listing.append(b);
      }
      if (!children.length) listing.append(node('p', 'library-archive-empty', '此文件夹为空'));
      const folders = children.filter(file => file.isDirectory).length;
      summary.textContent = folders + ' 个文件夹 · ' + (children.length - folders) + ' 个文件';
      if (notify) onFolder(folder, children);
    }
    home.addEventListener('click', () => show('')); up.addEventListener('click', () => show(parent(folder)));
    show('', false);
    return { element, select(path) { show(parent(path), false); selected = path; mark(); }, reset: () => show('') };
  }
  global.SoduWorkLibraryArchive = { create, findEntry };
})(window);
