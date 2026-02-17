export function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Task Agent Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    min-height: 100vh;
  }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  .header {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header h1 { font-size: 18px; font-weight: 600; color: #f0f6fc; }
  .header .status { font-size: 12px; color: #8b949e; }
  .container { display: flex; height: calc(100vh - 49px); }

  /* Sidebar */
  .sidebar {
    width: 260px;
    min-width: 260px;
    background: #161b22;
    border-right: 1px solid #30363d;
    overflow-y: auto;
    padding: 12px 0;
  }
  .sidebar h2 {
    font-size: 12px;
    text-transform: uppercase;
    color: #8b949e;
    padding: 8px 16px;
    letter-spacing: 0.5px;
  }
  .project-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background 0.1s;
  }
  .project-item:hover { background: #1c2128; }
  .project-item.active {
    background: #1c2128;
    border-left-color: #58a6ff;
  }
  .project-item .name { font-size: 14px; font-weight: 500; }
  .project-item .badge {
    font-size: 11px;
    background: #30363d;
    color: #8b949e;
    padding: 2px 8px;
    border-radius: 10px;
  }

  /* Main content */
  .main { flex: 1; overflow-y: auto; padding: 24px; }
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #8b949e;
    font-size: 16px;
  }

  /* Status groups */
  .status-group { margin-bottom: 24px; }
  .status-group h3 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #8b949e;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-group h3 .count {
    font-size: 11px;
    background: #30363d;
    padding: 1px 6px;
    border-radius: 8px;
  }
  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .status-dot.in_progress { background: #d29922; }
  .status-dot.todo { background: #58a6ff; }
  .status-dot.done { background: #3fb950; }
  .status-dot.failed { background: #f85149; }

  /* Task cards */
  .task-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .task-card:hover { border-color: #58a6ff; }
  .task-card .task-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .task-card .task-name { font-size: 14px; font-weight: 500; color: #f0f6fc; }
  .task-card .task-meta {
    font-size: 12px;
    color: #8b949e;
    margin-top: 4px;
    display: flex;
    gap: 12px;
  }
  .task-card .task-meta span { display: flex; align-items: center; gap: 4px; }

  /* Task detail (expanded) */
  .task-detail {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #30363d;
    display: none;
  }
  .task-card.expanded .task-detail { display: block; }
  .task-detail .desc {
    font-size: 13px;
    color: #c9d1d9;
    white-space: pre-wrap;
    line-height: 1.5;
    margin-bottom: 12px;
  }
  .task-detail .section-title {
    font-size: 11px;
    text-transform: uppercase;
    color: #8b949e;
    margin: 12px 0 6px;
    letter-spacing: 0.5px;
  }
  .comment {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 8px 12px;
    margin-bottom: 6px;
    font-size: 13px;
    line-height: 1.4;
  }
  .comment .comment-meta {
    font-size: 11px;
    color: #8b949e;
    margin-bottom: 4px;
  }
  .comment .comment-text { white-space: pre-wrap; word-break: break-word; }
  .attachment-list { list-style: none; }
  .attachment-list li {
    font-size: 13px;
    padding: 4px 0;
    color: #c9d1d9;
  }

  /* Responsive */
  @media (max-width: 700px) {
    .container { flex-direction: column; height: auto; }
    .sidebar { width: 100%; min-width: 0; border-right: 0; border-bottom: 1px solid #30363d; }
    .main { min-height: 60vh; }
  }
</style>
</head>
<body>
<div class="header">
  <h1>Task Agent</h1>
  <div class="status" id="status">Loading...</div>
</div>
<div class="container">
  <div class="sidebar">
    <h2>Projects</h2>
    <div id="project-list"></div>
  </div>
  <div class="main" id="main">
    <div class="empty-state">Select a project</div>
  </div>
</div>
<script>
(function() {
  let activeProject = null;
  let refreshTimer = null;

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function loadProjects() {
    try {
      const res = await fetch('/api/projects');
      const projects = await res.json();
      const list = document.getElementById('project-list');
      list.innerHTML = '';

      for (const p of projects) {
        const item = document.createElement('div');
        item.className = 'project-item' + (activeProject === p.name ? ' active' : '');
        item.innerHTML =
          '<span class="name">' + escapeHtml(p.name) + '</span>' +
          '<span class="badge">' + (p.taskCount || 0) + '</span>';
        item.onclick = function() { selectProject(p.name); };
        list.appendChild(item);
      }

      // Auto-select first project if none selected
      if (!activeProject && projects.length > 0) {
        selectProject(projects[0].name);
      }
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  }

  function selectProject(name) {
    activeProject = name;
    // Update sidebar active state
    document.querySelectorAll('.project-item').forEach(function(el, i) {
      el.classList.toggle('active', el.querySelector('.name').textContent === name);
    });
    loadTasks();
    // Reset refresh timer
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadTasks, 30000);
  }

  async function loadTasks() {
    if (!activeProject) return;
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(activeProject) + '/tasks');
      const tasks = await res.json();
      renderTasks(tasks);
      updateStatus();
    } catch (e) {
      console.error('Failed to load tasks:', e);
    }
  }

  function renderTasks(tasks) {
    const main = document.getElementById('main');
    if (tasks.length === 0) {
      main.innerHTML = '<div class="empty-state">No tasks in this project</div>';
      return;
    }

    var groups = { in_progress: [], todo: [], done: [], failed: [] };
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (groups[t.status]) groups[t.status].push(t);
    }

    var html = '';
    var order = ['in_progress', 'todo', 'failed', 'done'];
    var labels = { in_progress: 'In Progress', todo: 'To Do', failed: 'Failed', done: 'Done' };

    for (var o = 0; o < order.length; o++) {
      var status = order[o];
      var list = groups[status];
      if (list.length === 0) continue;

      html += '<div class="status-group">';
      html += '<h3><span class="status-dot ' + status + '"></span>' + labels[status] +
              ' <span class="count">' + list.length + '</span></h3>';

      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        html += '<div class="task-card" onclick="this.classList.toggle(&quot;expanded&quot;)">';
        html += '<div class="task-header">';
        html += '<div class="task-name">' + escapeHtml(t.name) + '</div>';
        html += '</div>';
        html += '<div class="task-meta">';
        html += '<span>Created ' + formatDate(t.createdAt) + '</span>';
        if (t.comments && t.comments.length > 0) {
          html += '<span>' + t.comments.length + ' comment' + (t.comments.length === 1 ? '' : 's') + '</span>';
        }
        if (t.attachments && t.attachments.length > 0) {
          html += '<span>' + t.attachments.length + ' attachment' + (t.attachments.length === 1 ? '' : 's') + '</span>';
        }
        html += '</div>';

        // Detail section
        html += '<div class="task-detail">';
        if (t.desc) {
          html += '<div class="desc">' + escapeHtml(t.desc) + '</div>';
        }
        if (t.attachments && t.attachments.length > 0) {
          html += '<div class="section-title">Attachments</div>';
          html += '<ul class="attachment-list">';
          for (var a = 0; a < t.attachments.length; a++) {
            html += '<li>' + escapeHtml(t.attachments[a].name) + '</li>';
          }
          html += '</ul>';
        }
        if (t.comments && t.comments.length > 0) {
          html += '<div class="section-title">Comments</div>';
          for (var c = 0; c < t.comments.length; c++) {
            var cm = t.comments[c];
            html += '<div class="comment">';
            html += '<div class="comment-meta">' + cm.source + ' &middot; ' + formatDate(cm.createdAt) + '</div>';
            html += '<div class="comment-text">' + escapeHtml(cm.text) + '</div>';
            html += '</div>';
          }
        }
        html += '</div>'; // task-detail
        html += '</div>'; // task-card
      }
      html += '</div>'; // status-group
    }

    main.innerHTML = html;
  }

  async function updateStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      const hours = Math.floor(data.uptime / 3600);
      const mins = Math.floor((data.uptime % 3600) / 60);
      document.getElementById('status').textContent =
        'Up ' + hours + 'h ' + mins + 'm | ' + data.projects + ' projects | ' + data.totalTasks + ' tasks';
    } catch (e) {}
  }

  // Also refresh project list to update task counts
  async function refreshAll() {
    await loadProjects();
    if (activeProject) await loadTasks();
  }

  loadProjects();
  updateStatus();
  // Refresh project list every 60s
  setInterval(loadProjects, 60000);
})();
</script>
</body>
</html>`;
}
