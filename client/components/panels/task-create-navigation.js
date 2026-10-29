/* Shared task creation date and conversation navigation helpers. */
function _todayInputValue() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function _openCreatedTaskInChat(taskId, title, task) {
  if (task && task.readOnly) {
    if (typeof window.openDetailEntry === 'function') window.openDetailEntry(taskId);
    else if (window.WorkspaceHost) window.WorkspaceHost.open('detail', { taskId });
    return;
  }
  if (typeof window.openTaskConversation === 'function') {
    window.openTaskConversation(taskId, title || '', {
      source: 'task-create', taskSession: true,
      projectId: task && task.projectId || '', repoId: task && task.repoId || '',
      task: task || null,
    });
    return;
  }
  if (window.WorkspaceHost && typeof WorkspaceHost.open === 'function') {
    WorkspaceHost.open('create', {
      tab: 'chat', taskId: taskId, taskTitle: title || '', taskSession: true,
    });
    return;
  }
  if (typeof openDetailEntry === 'function') openDetailEntry(taskId);
}
