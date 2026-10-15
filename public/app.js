(() => {
  const basePath = globalThis.location.pathname.startsWith('/dev-log/') ? '/dev-log' : '';
  const projectSelect = document.querySelector('#project-select');
  const workspace = document.querySelector('#workspace');
  const loading = document.querySelector('#loading');
  const notice = document.querySelector('#notice');
  const projectForm = document.querySelector('#new-project-form');
  const bugFilter = document.querySelector('#bug-filter-status');

  const state = {
    activeProject: '',
    projects: [],
    selectedDocId: '',
    bugFilter: 'all',
    data: {
      board: { ideas: [], development: [] },
      sprints: [],
      agents: [],
      agentRuns: [],
      runs: [],
      stats: null,
      bugs: [],
      docs: [],
      reports: [],
    },
    errors: {},
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);

  const statusLabel = (status) => ({
    running: 'Läuft',
    passed: 'Bestanden',
    failed: 'Fehlgeschlagen',
    skipped: 'Übersprungen',
    idea: 'Idee',
    considering: 'In Prüfung',
    requested: 'Anforderung angefragt',
    drafting: 'Agent schreibt Anforderung',
    accepted: 'Angenommen',
    rejected: 'Verworfen',
    backlog: 'Backlog',
    planned: 'Geplant',
    in_progress: 'In Arbeit',
    blocked: 'Blockiert',
    done: 'Erledigt',
    open: 'Offen',
    fixed: 'Behoben',
    wontfix: 'Kein Fix',
    planned_sprint: 'Geplant',
    active: 'Aktiv',
    completed: 'Abgeschlossen',
  })[status] ?? status;

  const priorityLabel = (priority) => ({ low: 'Niedrig', medium: 'Mittel', high: 'Hoch' })[priority] ?? priority;
  const severityLabel = (severity) => ({ low: 'Niedrig', medium: 'Mittel', high: 'Hoch', critical: 'Kritisch' })[severity] ?? severity;
  const sprintStatusLabel = (status) => ({ planned: 'Geplant', active: 'Aktiv', completed: 'Abgeschlossen' })[status] ?? status;
  const sourceLabel = (source) => ({ agent: 'Agent', manual: 'Manuell' })[source] ?? source;
  const docKindLabel = (kind) => ({ manual: 'Handbuch', sprint: 'Sprint-Dokumentation', order: 'Auftrags-Doku', repo: 'Repository' })[kind] ?? kind;
  const kindLabel = (kind) => ({ feature: 'Feature', bug: 'Bug' })[kind] ?? kind;
  const ROLE_LABELS = {
    author: 'Auftragsautor',
    developer: 'Entwickler',
    tester: 'Tester',
    reviewer: 'Reviewer',
    documenter: 'Dokumentierer',
    bug_reviewer: 'Bug-Wächter',
    manual_writer: 'Handbuch-Autor',
    custom: 'Eigene Rolle',
  };
  const PHASES = [
    { key: 'pre_task', label: 'Pre Task', hint: 'Vorbereitung: Auftrag, Bugs und Kontext prüfen' },
    { key: 'while_task', label: 'While Task', hint: 'Umsetzung des Auftrags' },
    { key: 'after_task', label: 'After Task', hint: 'Tests, Review und Dokumentation' },
  ];
  const COLUMNS = [
    { key: 'todo', label: 'Zu erledigen', statuses: ['backlog', 'planned'] },
    { key: 'progress', label: 'In Arbeit', statuses: ['in_progress'] },
    { key: 'blocked', label: 'Blockiert', statuses: ['blocked'] },
    { key: 'done', label: 'Erledigt', statuses: ['done'] },
  ];
  const RESOURCE_LABELS = {
    board: 'Entwicklungsboard',
    sprints: 'Sprints',
    agents: 'Agents',
    agentRuns: 'Agent-Läufe',
    runs: 'Testläufe',
    stats: 'Dashboard',
    bugs: 'Bugs',
    docs: 'Dokumentation',
    reports: 'Sprintberichte',
  };

  async function api(path, options = {}) {
    const response = await fetch(`${basePath}${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || `Anfrage fehlgeschlagen (${response.status}).`);
    }
    return response.status === 204 ? null : response.json();
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.classList.remove('hidden');
  }

  function clearNotice() {
    notice.classList.add('hidden');
  }

  function shortKey(id) {
    return `MNT-${escapeHtml(String(id ?? '').slice(0, 4).toUpperCase())}`;
  }

  function formatDate(date) {
    return date ? new Date(`${date}T00:00:00`).toLocaleDateString('de-DE') : '–';
  }

  function formatDateTime(date) {
    return date ? new Date(date).toLocaleString('de-DE') : '–';
  }

  function formatHours(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '–';
    return `${Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
  }

  function formatTokens(value) {
    const number = Number(value ?? 0);
    if (!number) return '0';
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace('.', ',')} Mio.`;
    if (number >= 1000) return `${Math.round(number / 1000)}k`;
    return String(number);
  }

  function formatDuration(durationMs) {
    const value = Number(durationMs ?? 0);
    if (!value) return '0 ms';
    if (value >= 60_000) return `${(value / 60_000).toFixed(1).replace('.', ',')} min`;
    if (value >= 1000) return `${(value / 1000).toFixed(1).replace('.', ',')} s`;
    return `${value} ms`;
  }

  function numberOrNull(value) {
    return value === '' || value === null || value === undefined ? null : Number(value);
  }

  function estimateBody(data) {
    return {
      ...(data.has('title') ? { title: String(data.get('title')).trim(), description: String(data.get('description') ?? ''), priority: data.get('priority') } : {}),
      effortHours: numberOrNull(data.get('effortHours')),
      tokenEstimate: numberOrNull(data.get('tokenEstimate')),
      benefit: numberOrNull(data.get('benefit')),
      cost: numberOrNull(data.get('cost')),
    };
  }

  function parseCommand(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed.split(/\s+/);
  }

  function options(values, labelFn, selected) {
    return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(labelFn(value))}</option>`).join('');
  }

  function sprintName(id) {
    return state.data.sprints.find((sprint) => sprint.id === id)?.name ?? 'Kein Sprint';
  }

  function sprintOptions(selected, placeholder, includeCompleted = false) {
    return `<option value="">${escapeHtml(placeholder)}</option>${state.data.sprints
      .filter((sprint) => includeCompleted || sprint.status !== 'completed')
      .map((sprint) => `<option value="${escapeHtml(sprint.id)}" ${sprint.id === selected ? 'selected' : ''}>${escapeHtml(sprint.name)}</option>`)
      .join('')}`;
  }

  function estimateChips(item) {
    const chips = [];
    if (item.effortHours !== null && item.effortHours !== undefined) chips.push(`<span class="chip">⏱ ${escapeHtml(String(item.effortHours))} Std.</span>`);
    if (item.tokenEstimate !== null && item.tokenEstimate !== undefined) chips.push(`<span class="chip">◈ ${escapeHtml(formatTokens(item.tokenEstimate))} Token</span>`);
    return chips.join('');
  }

  function meter(label, value, tone) {
    if (value === null || value === undefined) {
      return `<span class="meter empty"><span class="meter-label">${label}</span><span class="meter-value">–</span></span>`;
    }
    return `<span class="meter ${tone}" title="${escapeHtml(label)} ${escapeHtml(String(value))}/10"><span class="meter-label">${label}</span><span class="meter-bar"><span style="width:${Math.max(0, Math.min(100, Number(value) * 10))}%"></span></span><span class="meter-value">${escapeHtml(String(value))}</span></span>`;
  }

  function inlineError(resourceKey) {
    const message = state.errors[resourceKey];
    if (!message) return '';
    return `<div class="inline-error"><strong>${escapeHtml(RESOURCE_LABELS[resourceKey] ?? resourceKey)}</strong><span>${escapeHtml(message)}</span></div>`;
  }

  function emptyState(message) {
    return `<div class="state-message compact">${escapeHtml(message)}</div>`;
  }

  function hintState(message) {
    return `<div class="empty-panel">${escapeHtml(message)}</div>`;
  }

  function buildReportMarkdown(report, sprint) {
    const implemented = report.implemented ?? [];
    const missing = report.missing ?? [];
    const problems = report.problems ?? [];
    const total = implemented.length + missing.length;
    const percent = total ? Math.round((implemented.length / total) * 100) : 0;
    return [
      `# Sprint-Dokumentation: ${report.sprintName}`,
      '',
      `**Sprintziel:** ${sprint?.goal || '—'}`,
      '',
      `${implemented.length} von ${total} Aufträgen umgesetzt (${percent} %). ${missing.length} offen, ${problems.length} Problem(e) dokumentiert.`,
      '',
      '## Umgesetzt (Featureliste)',
      '',
      ...(implemented.length ? implemented.map((item) => `- ${item.title}`) : ['- Nichts umgesetzt.']),
      '',
      '## Offen / nicht umgesetzt',
      '',
      ...(missing.length ? missing.map((item) => `- ${item.title} (${statusLabel(item.status)})`) : ['- Alles erledigt.']),
      '',
      '## Probleme',
      '',
      ...(problems.length ? problems.map((problem) => `- **${problem.title}** – ${problem.detail}`) : ['- Keine Probleme dokumentiert.']),
      ...(report.notes ? ['', '## Notizen', '', report.notes] : []),
    ].join('\n');
  }

  function isOrphanBugOrder(item, bugs) {
    if (item?.kind !== 'bug' || item?.bugId) return false;
    const normalizedTitle = String(item.title ?? '').replace(/^Bug:\s*/i, '').trim();
    if (!normalizedTitle) return false;
    return !bugs.some((bug) => String(bug.title ?? '').trim() === normalizedTitle);
  }

  function reconcileProjectData() {
    const bugs = state.data.bugs ?? [];
    const board = state.data.board ?? { ideas: [], development: [] };
    const hiddenDevelopmentIds = new Set(board.development.filter((item) => isOrphanBugOrder(item, bugs)).map((item) => item.id));
    if (hiddenDevelopmentIds.size) {
      state.data.board = { ...board, development: board.development.filter((item) => !hiddenDevelopmentIds.has(item.id)) };
    }
    if (hiddenDevelopmentIds.size && Array.isArray(state.data.reports)) {
      const bugTitles = new Set(bugs.map((bug) => String(bug.title ?? '').trim()));
      state.data.reports = state.data.reports.map((report) => ({
        ...report,
        implemented: (report.implemented ?? []).filter((item) => !hiddenDevelopmentIds.has(item.id)),
        missing: (report.missing ?? []).filter((item) => !hiddenDevelopmentIds.has(item.id)),
        problems: (report.problems ?? []).filter((problem) => problem.type !== 'bug' || bugTitles.has(String(problem.title ?? '').trim())),
      }));
    }
    if (Array.isArray(state.data.docs) && Array.isArray(state.data.reports)) {
      state.data.docs = state.data.docs.map((doc) => {
        if (doc.kind !== 'sprint' || !doc.sprintId) return doc;
        const report = state.data.reports.find((entry) => entry.sprintId === doc.sprintId);
        if (!report) return doc;
        const sprint = state.data.sprints.find((entry) => entry.id === doc.sprintId);
        return {
          ...doc,
          content: buildReportMarkdown(report, sprint),
          updatedAt: report.generatedAt ?? doc.updatedAt,
        };
      });
    }
  }

  function developmentStatusCounts() {
    return (state.data.board.development ?? []).reduce((counts, item) => {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      return counts;
    }, {});
  }

  function sprintMetrics() {
    return (state.data.sprints ?? []).map((sprint) => {
      const items = (state.data.board.development ?? []).filter((item) => item.sprintId === sprint.id);
      const done = items.filter((item) => item.status === 'done').length;
      const total = items.length;
      const hours = items.reduce((sum, item) => sum + Number(item.effortHours ?? 0), 0);
      return {
        id: sprint.id,
        name: sprint.name,
        status: sprint.status,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
        total,
        done,
        hours,
        percent: total ? Math.round((done / total) * 100) : 0,
      };
    });
  }

  function kpiCard(label, value, meta, tone = '') {
    return `<article class="kpi-card ${tone}"><span class="kpi-label">${escapeHtml(label)}</span><strong class="kpi-value">${escapeHtml(value)}</strong><span class="kpi-meta">${escapeHtml(meta)}</span></article>`;
  }

  function stackBar(data, order, labelFn) {
    const total = order.reduce((sum, key) => sum + Number(data?.[key] ?? 0), 0);
    if (!total) return hintState('Noch keine Werte vorhanden.');
    return `<div class="stack-card">
      <div class="stack-bar">${order.map((key) => {
        const count = Number(data?.[key] ?? 0);
        if (!count) return '';
        return `<span class="stack-segment tone-${escapeHtml(key)}" style="width:${(count / total) * 100}%" title="${escapeHtml(labelFn(key))}: ${count}"></span>`;
      }).join('')}</div>
      <div class="stack-legend">${order.map((key) => {
        const count = Number(data?.[key] ?? 0);
        return `<span class="legend-item"><span class="legend-dot tone-${escapeHtml(key)}"></span>${escapeHtml(labelFn(key))}<strong>${count}</strong></span>`;
      }).join('')}</div>
    </div>`;
  }

  function barList(data, order, labelFn) {
    const max = Math.max(0, ...order.map((key) => Number(data?.[key] ?? 0)));
    if (!max) return hintState('Keine offenen Bugs nach Schweregrad vorhanden.');
    return `<div class="bar-list">${order.map((key) => {
      const count = Number(data?.[key] ?? 0);
      return `<div class="bar-row"><span>${escapeHtml(labelFn(key))}</span><div class="bar-track severity-${escapeHtml(key)}"><span style="width:${max ? (count / max) * 100 : 0}%"></span></div><strong>${count}</strong></div>`;
    }).join('')}</div>`;
  }

  function renderLineChart(points, width, height, maxY, minY = 0) {
    if (!points.length) return '';
    const left = 22;
    const right = 10;
    const top = 12;
    const bottom = 18;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const range = Math.max(1, maxY - minY);
    const coords = points.map((point, index) => {
      const x = left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
      const y = top + innerHeight - (((point.value ?? 0) - minY) / range) * innerHeight;
      return { ...point, x, y };
    });
    const polyline = coords.map((point) => `${point.x},${point.y}`).join(' ');
    const last = coords[coords.length - 1];
    return `<svg viewBox="0 0 ${width} ${height}" class="line-chart" role="img" aria-label="Verlauf">
      <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" class="axis"></line>
      <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="axis"></line>
      <polyline fill="none" stroke="currentColor" stroke-width="2.5" points="${polyline}"></polyline>
      ${coords.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3.5"></circle>`).join('')}
      <text x="${last.x}" y="${Math.max(12, last.y - 8)}" text-anchor="end">${escapeHtml(String(last.value))}</text>
      ${coords.map((point) => `<text x="${point.x}" y="${height - 2}" text-anchor="middle">${escapeHtml(point.label)}</text>`).join('')}
    </svg>`;
  }

  function renderBurndown(sprint) {
    if (!sprint) return hintState('Kein aktiver Sprint. Sobald ein Sprint aktiv ist, erscheinen Fortschritt und Burndown hier.');
    const points = (sprint.burndown ?? []).map((entry) => ({
      label: new Date(`${entry.day}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
      value: Number(entry.remaining ?? 0),
    }));
    const max = Math.max(sprint.total ?? 0, ...points.map((point) => point.value), 1);
    return `<div class="sprint-dashboard-card">
      <div>
        <div class="card-eyebrow">Aktiver Sprint</div>
        <h3>${escapeHtml(sprint.name)}</h3>
        <div class="issue-meta"><span>${formatDate(sprint.startDate)} – ${formatDate(sprint.endDate)}</span><span>${escapeHtml(String(sprint.done ?? 0))}/${escapeHtml(String(sprint.total ?? 0))} erledigt</span></div>
        <div class="progress large" role="progressbar" aria-valuenow="${Number(sprint.percent ?? 0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, Number(sprint.percent ?? 0)))}%"></span></div>
      </div>
      <div class="chart-card">
        <div class="chart-head"><strong>Burndown</strong><span>${escapeHtml(String(sprint.percent ?? 0))}%</span></div>
        ${points.length ? renderLineChart(points, 360, 160, max, 0) : hintState('Noch keine Burndown-Daten verfügbar.')}
      </div>
    </div>`;
  }

  function renderVelocity(velocity) {
    if (!velocity.length) return hintState('Noch keine Sprint-Historie für Velocity verfügbar.');
    const max = Math.max(...velocity.map((item) => Number(item.total ?? 0)), 1);
    return `<div class="velocity-chart">${velocity.map((item) => {
      const done = Number(item.done ?? 0);
      const total = Number(item.total ?? 0);
      const percent = total ? Math.round((done / total) * 100) : 0;
      const height = total ? Math.max(18, (done / max) * 120) : 18;
      return `<div class="velocity-item">
        <div class="velocity-bar ${escapeHtml(item.status)}" style="height:${height}px"><span>${done}/${total}</span></div>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${percent}% · ${escapeHtml(formatHours(item.hours))}</small>
      </div>`;
    }).join('')}</div>`;
  }

  function renderTestHistory(testRuns) {
    const recent = testRuns?.recent ?? [];
    if (!recent.length) return hintState('Keine Testläufe im Verlauf vorhanden.');
    const points = recent.map((run, index) => ({
      label: String(index + 1),
      value: run.status === 'passed' ? 1 : 0,
      status: run.status,
      startedAt: run.startedAt,
    }));
    return `<div class="chart-stack">
      <div class="history-dots">${recent.map((run) => `<span class="history-dot ${escapeHtml(run.status)}" title="${escapeHtml(formatDateTime(run.startedAt))}: ${escapeHtml(statusLabel(run.status))}"></span>`).join('')}</div>
      <svg viewBox="0 0 320 96" class="sparkline" role="img" aria-label="Testlaufverlauf">
        <polyline fill="none" stroke="currentColor" stroke-width="2.5" points="${points.map((point, index) => `${16 + (index / Math.max(points.length - 1, 1)) * 288},${point.value ? 22 : 74}`).join(' ')}"></polyline>
        ${points.map((point, index) => `<circle class="${escapeHtml(point.status)}" cx="${16 + (index / Math.max(points.length - 1, 1)) * 288}" cy="${point.value ? 22 : 74}" r="5"></circle>`).join('')}
      </svg>
      <div class="issue-meta"><span>Passrate: ${testRuns.passRate === null || testRuns.passRate === undefined ? '–' : `${testRuns.passRate}%`}</span><span>${recent.length} Lauf/Läufe</span></div>
    </div>`;
  }

  function renderAgentStats(agents) {
    if (!agents.length) return hintState('Noch keine Agent-Erfolgsdaten vorhanden.');
    return `<div class="agent-metrics">${agents.map((agent) => {
      const passed = Number(agent.passed ?? 0);
      const failed = Number(agent.failed ?? 0);
      const skipped = Number(agent.skipped ?? 0);
      const total = Math.max(1, passed + failed + skipped);
      return `<article class="agent-metric-card">
        <div class="chart-head"><strong>${escapeHtml(agent.agent)}</strong><span>${passed}/${total}</span></div>
        <div class="stack-bar agent-stack">
          <span class="stack-segment tone-passed" style="width:${(passed / total) * 100}%"></span>
          <span class="stack-segment tone-failed" style="width:${(failed / total) * 100}%"></span>
          <span class="stack-segment tone-skipped" style="width:${(skipped / total) * 100}%"></span>
        </div>
        <div class="stack-legend slim"><span class="legend-item"><span class="legend-dot tone-passed"></span>OK <strong>${passed}</strong></span><span class="legend-item"><span class="legend-dot tone-failed"></span>Fehler <strong>${failed}</strong></span><span class="legend-item"><span class="legend-dot tone-skipped"></span>Skip <strong>${skipped}</strong></span></div>
      </article>`;
    }).join('')}</div>`;
  }

  function renderIdeaMatrix(ideas) {
    const points = ideas.filter((idea) => idea.benefit !== null && idea.benefit !== undefined && idea.cost !== null && idea.cost !== undefined);
    if (!points.length) return hintState('Noch keine Ideen mit Nutzen/Kosten-Bewertung vorhanden.');
    const width = 320;
    const height = 240;
    const left = 28;
    const bottom = 24;
    const top = 16;
    const right = 18;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    return `<div class="matrix-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="matrix-chart" role="img" aria-label="Ideenmatrix Nutzen zu Kosten">
        ${Array.from({ length: 11 }).map((_, index) => `<line x1="${left + (index / 10) * innerWidth}" y1="${top}" x2="${left + (index / 10) * innerWidth}" y2="${height - bottom}" class="grid"></line>`).join('')}
        ${Array.from({ length: 11 }).map((_, index) => `<line x1="${left}" y1="${top + (index / 10) * innerHeight}" x2="${width - right}" y2="${top + (index / 10) * innerHeight}" class="grid"></line>`).join('')}
        <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="axis"></line>
        <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" class="axis"></line>
        <text x="${width / 2}" y="${height - 4}" text-anchor="middle">Kosten</text>
        <text x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})">Nutzen</text>
        ${points.map((idea) => {
          const x = left + (Number(idea.cost) / 10) * innerWidth;
          const y = top + innerHeight - (Number(idea.benefit) / 10) * innerHeight;
          return `<g><circle cx="${x}" cy="${y}" r="7" class="matrix-point ${escapeHtml(idea.priority)}"></circle><text x="${x}" y="${y + 4}" text-anchor="middle">${escapeHtml(shortKey(idea.id).replace('MNT-', ''))}</text></g>`;
        }).join('')}
      </svg>
      <div class="matrix-legend">${points.map((idea) => `<div class="matrix-legend-item"><span class="issue-key">${shortKey(idea.id)}</span><span>${escapeHtml(idea.title)}</span><strong>${escapeHtml(String(idea.benefit))}/${escapeHtml(String(idea.cost))}</strong></div>`).join('')}</div>
    </div>`;
  }

  function renderDashboard() {
    const container = document.querySelector('#dashboard-content');
    const stats = state.data.stats;
    const ideas = state.data.board.ideas ?? [];
    const developmentCounts = developmentStatusCounts();
    if (!stats && state.errors.stats) {
      container.innerHTML = inlineError('stats');
      return;
    }
    const orderCounts = Object.keys(developmentCounts).length ? developmentCounts : (stats?.orders ?? {});
    const doneOrders = Number(orderCounts.done ?? 0);
    const openOrders = Object.entries(orderCounts).reduce((sum, [key, value]) => sum + (key === 'done' ? 0 : Number(value ?? 0)), 0);
    const openBugs = (state.data.bugs ?? []).filter((bug) => bug.status === 'open' || bug.status === 'in_progress').length;
    const effort = stats?.effort ?? {};
    const sprintViews = sprintMetrics();
    const activeSprintMetrics = sprintViews.find((entry) => entry.status === 'active') ?? null;
    const sprint = activeSprintMetrics ? { ...(stats?.sprint ?? {}), ...activeSprintMetrics } : (stats?.sprint ?? null);
    const passRate = stats?.testRuns?.passRate;
    container.innerHTML = `${inlineError('stats')}
      <div class="dashboard-grid">
        <div class="kpi-grid">
          ${kpiCard('Offene Aufträge', String(openOrders), 'Nicht erledigte Tickets', 'tone-warm')}
          ${kpiCard('Erledigt', String(doneOrders), 'Abgeschlossene Aufträge', 'tone-good')}
          ${kpiCard('Offene Bugs', String(openBugs), 'Offen + in Arbeit', 'tone-alert')}
          ${kpiCard('Test-Passrate', passRate === null || passRate === undefined ? '–' : `${passRate}%`, 'Letzte Testläufe', 'tone-cool')}
          ${kpiCard('Aktiver Sprint', sprint ? `${sprint.percent}%` : '–', sprint ? `${sprint.done}/${sprint.total} erledigt` : 'Kein aktiver Sprint', '')}
          ${kpiCard('Aufwand', `${formatHours(effort.doneHours)} / ${formatHours(effort.plannedHours)}`, 'Erledigt / geplant', '')}
          ${kpiCard('Tokens', formatTokens(effort.tokens), 'Geschätzter Verbrauch', '')}
        </div>
        <div class="dashboard-main">
          <article class="chart-panel span-two">
            <div class="chart-head"><strong>Sprint-Fortschritt</strong><span>${sprint ? 'Aktiv' : 'Kein Sprint'}</span></div>
            ${renderBurndown(sprint)}
          </article>
          <article class="chart-panel">
            <div class="chart-head"><strong>Aufträge nach Status</strong><span>${Object.values(orderCounts).reduce((sum, value) => sum + Number(value ?? 0), 0)} gesamt</span></div>
            ${stackBar(orderCounts, ['backlog', 'planned', 'in_progress', 'blocked', 'done'], statusLabel)}
          </article>
          <article class="chart-panel">
            <div class="chart-head"><strong>Bugs nach Schweregrad</strong><span>${openBugs} offen</span></div>
            ${barList(stats?.openBugsBySeverity ?? {}, ['critical', 'high', 'medium', 'low'], severityLabel)}
          </article>
          <article class="chart-panel">
            <div class="chart-head"><strong>Velocity</strong><span>${sprintViews.length || state.data.stats?.velocity?.length || 0} Sprint(s)</span></div>
            ${renderVelocity(sprintViews.length ? sprintViews : (stats?.velocity ?? []))}
          </article>
          <article class="chart-panel">
            <div class="chart-head"><strong>Testlauf-Historie</strong><span>${passRate === null || passRate === undefined ? '–' : `${passRate}%`}</span></div>
            ${renderTestHistory(stats?.testRuns ?? { recent: [], passRate: null })}
          </article>
          <article class="chart-panel">
            <div class="chart-head"><strong>Agent-Erfolg</strong><span>${stats?.agents?.length ?? 0} Rollen</span></div>
            ${renderAgentStats(stats?.agents ?? [])}
          </article>
          <article class="chart-panel span-two">
            <div class="chart-head"><strong>Ideen-Matrix</strong><span>Nutzen vs. Kosten</span></div>
            ${renderIdeaMatrix(ideas)}
          </article>
        </div>
      </div>`;
  }

  function renderIssueAvatar(item) {
    const label = item.kind === 'bug' || item.bugId ? '🐞' : item.priority === 'high' ? '▲' : item.priority === 'low' ? '●' : '■';
    return `<span class="issue-avatar ${escapeHtml(item.kind ?? 'feature')}">${label}</span>`;
  }

  function estimateFields(item) {
    const value = (field) => item[field] ?? '';
    return `<div class="estimate-grid">
      <label>Aufwand (Std.)<input name="effortHours" type="number" min="0" max="100000" step="0.5" value="${escapeHtml(String(value('effortHours')))}"></label>
      <label>Token-Schätzung<input name="tokenEstimate" type="number" min="0" max="1000000000" step="1000" value="${escapeHtml(String(value('tokenEstimate')))}"></label>
      <label>Nutzen (0–10)<input name="benefit" type="number" min="0" max="10" step="1" value="${escapeHtml(String(value('benefit')))}"></label>
      <label>Kosten (0–10)<input name="cost" type="number" min="0" max="10" step="1" value="${escapeHtml(String(value('cost')))}"></label>
    </div>`;
  }

  function issueCard(item, kind, extraControls) {
    const badges = [
      kind === 'idea' ? '' : `<span class="status ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span>`,
      `<span class="chip prio-${escapeHtml(item.priority)}">${escapeHtml(priorityLabel(item.priority))}</span>`,
      item.kind ? `<span class="chip kind-${escapeHtml(item.kind)}">${escapeHtml(kindLabel(item.kind))}</span>` : '',
      item.bugId ? '<span class="chip kind-bug">🐞 Verknüpfter Bug</span>' : '',
      item.ideationId ? '<span class="chip">Aus Idee</span>' : '',
      item.testRunId ? '<span class="chip">Aus Testlauf</span>' : '',
      item.completedAt ? `<span class="chip">Fertig: ${escapeHtml(formatDateTime(item.completedAt))}</span>` : '',
      estimateChips(item),
      meter('Nutzen', item.benefit, 'good'),
      meter('Kosten', item.cost, 'cost'),
    ].join('');
    return `<article class="issue-card priority-${escapeHtml(item.priority)} ${item.kind === 'bug' || item.bugId ? 'is-bug' : ''}">
      <div class="issue-main">
        <div class="issue-head">${renderIssueAvatar(item)}<span class="issue-key">${shortKey(item.id)}</span><span class="issue-title">${escapeHtml(item.title)}</span></div>
        ${item.description ? `<p class="board-description">${escapeHtml(item.description)}</p>` : ''}
        <div class="issue-meta">${badges}</div>
        ${item.agentNote ? `<p class="agent-note">${escapeHtml(item.agentNote)}</p>` : ''}
        <details class="edit-details"><summary>Bearbeiten</summary>
          <form data-form="estimate-${escapeHtml(kind)}" data-id="${escapeHtml(item.id)}" class="item-edit-form">
            <label>Titel<input name="title" maxlength="180" value="${escapeHtml(item.title)}" required></label>
            <label>Beschreibung / Anforderung<textarea name="description" rows="8" maxlength="10000">${escapeHtml(item.description ?? '')}</textarea></label>
            <label>Priorität<select name="priority">${options(['low', 'medium', 'high'], priorityLabel, item.priority)}</select></label>
            ${estimateFields(item)}<button class="btn btn-primary" type="submit">Speichern</button>
          </form>
        </details>
      </div>
      <div class="issue-controls">${extraControls}</div>
    </article>`;
  }

  function renderBoard() {
    const ideas = state.data.board.ideas ?? [];
    const development = state.data.board.development ?? [];
    document.querySelector('#idea-count').textContent = String(ideas.filter((idea) => idea.status !== 'rejected').length);
    document.querySelector('#development-count').textContent = String(development.filter((item) => item.status !== 'done').length);

    const promoted = new Set(development.map((item) => item.ideationId).filter(Boolean));
    document.querySelector('#ideas-list').innerHTML = `${inlineError('board')}${ideas.length ? ideas.map((idea) => issueCard(idea, 'idea', `
      ${(() => {
        const order = development.find((item) => item.ideationId === idea.id);
        const busy = idea.status === 'drafting';
        const waiting = idea.status === 'requested';
        return `<div class="promoted">${order ? 'Auftrag erstellt – Sprint unter „Entwicklung“ zuweisen' : busy ? 'Agent schreibt gerade …' : waiting ? 'Wartet auf den Agenten (Worker)' : 'Agent konnte keinen Auftrag erstellen'}${order && waiting ? ' · Überarbeitung läuft' : ''}</div>
        <form data-form="revise-idea" data-id="${escapeHtml(idea.id)}" class="revise-form">
          <input name="prompt" maxlength="4000" required placeholder="${order ? 'Änderungswunsch an den Auftrag …' : 'Hinweis für einen neuen Versuch …'}" aria-label="Änderungswunsch">
          <button class="btn btn-outline" type="submit"${busy ? ' disabled' : ''}>Erneut anfragen</button>
        </form>`;
      })()}`)).join('') : emptyState('Noch keine Ideen. Halte hier Vorschläge und Verbesserungen fest.')}`;

    document.querySelector('#development-list').innerHTML = `${inlineError('board')}${development.length ? development.map((item) => issueCard(item, 'development', `
      <select data-development-id="${escapeHtml(item.id)}" aria-label="Auftragsstatus">${options(['backlog', 'planned', 'in_progress', 'blocked', 'done'], statusLabel, item.status)}</select>
      <select data-item-sprint="${escapeHtml(item.id)}" aria-label="Sprint">${sprintOptions(item.sprintId, 'Kein Sprint')}</select>`)).join('') : emptyState('Noch keine Entwicklungsaufträge. Erstelle sie aus Ideen oder lege sie direkt an.')}`;
  }

  function kanbanCard(item) {
    return `<article class="kanban-card priority-${escapeHtml(item.priority)} ${item.kind === 'bug' || item.bugId ? 'is-bug' : ''}">
      <div class="issue-head compact">${renderIssueAvatar(item)}<span class="issue-key">${shortKey(item.id)}</span></div>
      <div class="issue-title">${escapeHtml(item.title)}</div>
      <div class="issue-meta"><span class="chip kind-${escapeHtml(item.kind ?? 'feature')}">${escapeHtml(kindLabel(item.kind ?? 'feature'))}</span>${item.bugId ? '<span class="chip kind-bug">🐞 Bug</span>' : ''}${estimateChips(item)}</div>
      <select data-development-id="${escapeHtml(item.id)}" aria-label="Status">${options(['backlog', 'planned', 'in_progress', 'blocked', 'done'], statusLabel, item.status)}</select>
    </article>`;
  }

  function reportPanel(report) {
    const implemented = report.implemented ?? [];
    const missing = report.missing ?? [];
    const problems = report.problems ?? [];
    const total = implemented.length + missing.length;
    const summary = total
      ? `${implemented.length} von ${total} Aufträgen umgesetzt (${Math.round((implemented.length / total) * 100)} %). ${missing.length} offen, ${problems.length} Problem(e) dokumentiert.`
      : (report.summary || 'Noch keine Berichtsdaten.');
    return `<details class="report-panel" ${report.sprintStatus === 'completed' ? 'open' : ''}>
      <summary>
        <span class="section-title-wrap"><strong>Sprintbericht</strong><span class="status ${escapeHtml(report.sprintStatus)}">${escapeHtml(sprintStatusLabel(report.sprintStatus))}</span></span>
        <span class="result-count">${escapeHtml(summary)}</span>
      </summary>
      <div class="report-grid">
        <section><h4>Umgesetzt</h4>${implemented.length ? `<ul class="report-list">${implemented.map((item) => `<li><span class="issue-key">${shortKey(item.id)}</span><span>${escapeHtml(item.title)}</span><span class="chip kind-${escapeHtml(item.kind)}">${escapeHtml(kindLabel(item.kind))}</span><span class="chip">${escapeHtml(formatHours(item.effortHours))}</span></li>`).join('')}</ul>` : hintState('Nichts umgesetzt.')}</section>
        <section><h4>Offen / fehlt</h4>${missing.length ? `<ul class="report-list">${missing.map((item) => `<li><span class="issue-key">${shortKey(item.id)}</span><span>${escapeHtml(item.title)}</span><span class="status ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></li>`).join('')}</ul>` : hintState('Alles erledigt.')}</section>
        <section><h4>Probleme</h4>${problems.length ? `<ul class="report-list problems">${problems.map((problem) => `<li><strong>${escapeHtml(problem.title)}</strong><span class="chip">${escapeHtml(problem.type)}</span><p>${escapeHtml(problem.detail)}</p></li>`).join('')}</ul>` : hintState('Keine Probleme dokumentiert.')}</section>
      </div>
      <form class="report-notes-form" data-form="report-notes" data-id="${escapeHtml(report.sprintId)}">
        <label>Notizen<textarea name="notes" maxlength="30000" placeholder="Zusätzliche Sprint-Notizen …">${escapeHtml(report.notes ?? '')}</textarea></label>
        <div class="report-actions"><button class="btn btn-outline" type="submit">Notizen speichern</button><button class="btn btn-primary" type="button" data-action="report-refresh" data-id="${escapeHtml(report.sprintId)}">Bericht aktualisieren</button><span class="result-count">Generiert: ${escapeHtml(formatDateTime(report.generatedAt))}</span></div>
      </form>
    </details>`;
  }

  function renderSprints() {
    document.querySelector('#sprint-count').textContent = state.data.sprints.some((sprint) => sprint.status === 'active') ? '1' : '0';
    const list = document.querySelector('#sprints-list');
    const development = state.data.board.development ?? [];
    const reportsBySprint = new Map((state.data.reports ?? []).map((report) => [report.sprintId, report]));
    const unassigned = development.filter((item) => !item.sprintId && item.status !== 'done');
    const sprintCards = state.data.sprints.map((sprint) => {
      const items = development.filter((item) => item.sprintId === sprint.id);
      const done = items.filter((item) => item.status === 'done').length;
      const percent = items.length ? Math.round((done / items.length) * 100) : 0;
      const effort = items.reduce((sum, item) => sum + Number(item.effortHours ?? 0), 0);
      const tokens = items.reduce((sum, item) => sum + Number(item.tokenEstimate ?? 0), 0);
      const actions = sprint.status === 'planned'
        ? `<button class="btn btn-primary" type="button" data-action="sprint-status" data-id="${escapeHtml(sprint.id)}" data-status="active">Sprint starten</button>`
        : sprint.status === 'active'
          ? `<button class="btn btn-outline" type="button" data-action="sprint-status" data-id="${escapeHtml(sprint.id)}" data-status="completed">Sprint abschließen</button>`
          : `<button class="btn btn-outline" type="button" data-action="sprint-status" data-id="${escapeHtml(sprint.id)}" data-status="planned">Wieder öffnen</button>`;
      const board = sprint.status === 'completed' ? '' : `<div class="kanban">${COLUMNS.map((column) => {
        const cards = items.filter((item) => column.statuses.includes(item.status));
        return `<div class="kanban-column"><h4>${column.label} <span>${cards.length}</span></h4>${cards.map(kanbanCard).join('') || '<div class="kanban-empty">Leer</div>'}</div>`;
      }).join('')}</div>`;
      const gitInfo = sprint.gitSync ? `<div class="git-status git-${escapeHtml(sprint.gitSync)}"><strong>Git:</strong> ${escapeHtml({ pending: 'Sicherung wartet auf den Worker', running: 'wird gesichert …', done: 'gesichert', failed: 'fehlgeschlagen' }[sprint.gitSync] ?? sprint.gitSync)}${sprint.gitCommit ? ` · <code>${escapeHtml(sprint.gitCommit)}</code>` : ''}${sprint.gitMessage ? ` – ${escapeHtml(sprint.gitMessage)}` : ''}${['done', 'failed'].includes(sprint.gitSync) ? ` <button class="btn btn-outline" type="button" data-action="git-resync" data-id="${escapeHtml(sprint.id)}">Erneut sichern</button>` : ''}</div>` : '';
      return `<article class="sprint-card ${escapeHtml(sprint.status)}">
        <header class="sprint-head">
          <div>
            <div class="sprint-title"><h3>${escapeHtml(sprint.name)}</h3><span class="sprint-badge ${escapeHtml(sprint.status)}">${escapeHtml(sprintStatusLabel(sprint.status))}</span></div>
            <div class="issue-meta"><span>${formatDate(sprint.startDate)} – ${formatDate(sprint.endDate)}</span><span>${items.length} Aufträge</span><span>⏱ ${escapeHtml(String(effort))} Std.</span><span>◈ ${escapeHtml(formatTokens(tokens))} Token</span></div>
            ${sprint.goal ? `<p class="board-description">${escapeHtml(sprint.goal)}</p>` : ''}
          </div>
          <div class="sprint-actions">${actions}<button class="btn btn-danger" type="button" data-action="sprint-delete" data-id="${escapeHtml(sprint.id)}">Löschen</button></div>
        </header>
        ${gitInfo}
        <div class="progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>
        ${board}
        ${reportsBySprint.has(sprint.id) ? reportPanel(reportsBySprint.get(sprint.id)) : `<div class="report-panel static">${state.errors.reports ? inlineError('reports') : `<div class="report-actions"><button class="btn btn-primary" type="button" data-action="report-refresh" data-id="${escapeHtml(sprint.id)}">Bericht aktualisieren</button><span class="result-count">Noch kein Sprintbericht vorhanden.</span></div>`}</div>`}
      </article>`;
    }).join('');

    const backlog = `<article class="sprint-card backlog">
      <header class="sprint-head"><div><div class="sprint-title"><h3>Auftrags-Backlog</h3><span class="sprint-badge planned">${unassigned.length}</span></div><p class="board-description">Aufträge ohne Sprint. Einem Sprint zuordnen, um sie einzuplanen.</p></div></header>
      ${unassigned.map((item) => `<div class="backlog-row ${item.kind === 'bug' || item.bugId ? 'is-bug' : ''}">${renderIssueAvatar(item)}<span class="issue-key">${shortKey(item.id)}</span><span class="issue-title">${escapeHtml(item.title)}</span>${item.bugId ? '<span class="chip kind-bug">🐞 Bug</span>' : ''}${estimateChips(item)}<select data-item-sprint="${escapeHtml(item.id)}" aria-label="Sprint">${sprintOptions('', 'Sprint wählen …')}</select></div>`).join('') || '<div class="kanban-empty">Keine unzugeordneten Aufträge.</div>'}
    </article>`;

    list.innerHTML = `${inlineError('sprints')}${inlineError('reports')}${sprintCards || emptyState('Noch keine Sprints angelegt.')} ${backlog}`;
  }

  function defaultAgentCommandText(agent) {
    if (agent.command?.length) return escapeHtml(agent.command.join(' '));
    return agent.role === 'tester' ? 'Standard: Build + Tests' : 'Standard: lokales Modell (Ollama)';
  }

  function renderAgents() {
    document.querySelector('#agent-count').textContent = String(state.data.agents.length);
    document.querySelector('#default-agents-button').classList.toggle('hidden', state.data.agents.length > 0);
    document.querySelector('#agents-board').innerHTML = `${inlineError('agents')}${PHASES.map((phase, phaseIndex) => {
      const inPhase = state.data.agents.filter((agent) => agent.phase === phase.key);
      return `<div class="lane"><header class="lane-head"><span class="lane-step">${phaseIndex + 1}</span><div><h3>${phase.label}</h3><small>${phase.hint}</small></div></header>
        ${inPhase.map((agent, index) => `<article class="agent-card ${agent.enabled ? '' : 'disabled'}">
          <div class="agent-top"><span class="agent-order">${index + 1}</span><strong>${escapeHtml(agent.name)}</strong><span class="chip">${escapeHtml(ROLE_LABELS[agent.role] ?? agent.role)}</span></div>
          ${agent.instructions ? `<p class="board-description">${escapeHtml(agent.instructions)}</p>` : ''}
          <code class="agent-command ${agent.command ? '' : 'missing'}">${defaultAgentCommandText(agent)}</code>
          <div class="agent-actions">
            <button class="icon-btn" type="button" title="Nach oben" data-action="agent-move" data-id="${escapeHtml(agent.id)}" data-phase="${phase.key}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" type="button" title="Nach unten" data-action="agent-move" data-id="${escapeHtml(agent.id)}" data-phase="${phase.key}" data-direction="1" ${index === inPhase.length - 1 ? 'disabled' : ''}>↓</button>
            <select data-agent-phase="${escapeHtml(agent.id)}" aria-label="Phase">${options(PHASES.map((entry) => entry.key), (key) => PHASES.find((entry) => entry.key === key)?.label ?? key, agent.phase)}</select>
            <button class="btn btn-outline" type="button" data-action="agent-toggle" data-id="${escapeHtml(agent.id)}" data-enabled="${escapeHtml(String(agent.enabled))}">${agent.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
            <button class="btn btn-danger" type="button" data-action="agent-delete" data-id="${escapeHtml(agent.id)}">Löschen</button>
          </div>
        </article>`).join('') || '<div class="kanban-empty">Kein Agent in dieser Phase.</div>'}
      </div>`;
    }).join('')}`;
  }

  function renderAgentRuns() {
    const container = document.querySelector('#agent-runs');
    const development = state.data.board.development ?? [];
    const titleFor = (id) => development.find((item) => item.id === id)?.title ?? id;
    if (!state.data.agentRuns.length) {
      container.innerHTML = `${inlineError('agentRuns')}${emptyState('Noch keine Agent-Läufe.')}`;
      return;
    }
    container.innerHTML = `${inlineError('agentRuns')}${state.data.agentRuns.map((run) => `<details class="run-card agent-run-card">
      <summary class="run-summary">
        <div><strong>${escapeHtml(titleFor(run.developmentId))}</strong><div class="run-meta"><span>${escapeHtml(formatDateTime(run.startedAt))}</span><span>${(run.steps ?? []).length} Schritt(e)</span></div></div>
        <span class="status ${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
      </summary>
      <div class="step-list">${(run.steps ?? []).map((step) => `<article class="step-card"><div class="step-head"><strong>${escapeHtml(step.agentName ?? 'Agent')}</strong><span class="status ${escapeHtml(step.status)}">${escapeHtml(statusLabel(step.status))}</span><span class="chip">${escapeHtml(formatDuration(step.durationMs))}</span></div><pre>${escapeHtml(step.output || 'Keine Konsolenausgabe.')}</pre></article>`).join('') || hintState('Keine Detail-Schritte vorhanden.')}</div>
    </details>`).join('')}`;
  }

  function renderRuns() {
    const runs = state.data.runs;
    document.querySelector('#run-count').textContent = String(runs.length);
    document.querySelector('#run-total').textContent = `${runs.length} letzte Läufe`;
    document.querySelector('#runs-list').innerHTML = `${inlineError('runs')}${runs.length ? runs.map((run) => `
      <article class="run-card">
        <div class="run-top">
          <span class="run-id">${escapeHtml(run.id)}</span>
          <span class="status ${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
        </div>
        <div class="run-meta">
          <span>${escapeHtml(formatDateTime(run.startedAt))}</span>
          <span>${escapeHtml(run.trigger === 'ci' ? 'CI' : 'Manuell')}</span>
          <span>${escapeHtml(run.branch ?? 'ohne Branch')}</span>
          <span>${escapeHtml(run.commitSha?.slice(0, 8) ?? 'ohne Commit')}</span>
        </div>
        <div class="step-list">${(run.steps ?? []).map((step) => `
          <details class="step">
            <summary>
              <span class="status ${escapeHtml(step.status)}">${escapeHtml(statusLabel(step.status))}</span>
              <span>${escapeHtml(step.command)}</span>
              <span>${escapeHtml(formatDuration(step.durationMs))}</span>
            </summary>
            <pre>${escapeHtml(step.output || 'Keine Konsolenausgabe.')}</pre>
          </details>`).join('')}
        </div>
      </article>`).join('') : hintState(`Für dieses Projekt gibt es noch keine Testläufe. Starte z. B. \`npm run dev-log:agent -- --project ${state.activeProject || '<slug>'}\`.`)}`;
  }

  function renderBugs() {
    const container = document.querySelector('#bugs-list');
    const select = document.querySelector('#bug-form [name="sprintId"]');
    select.innerHTML = sprintOptions('', 'Kein Sprint', false);
    bugFilter.value = state.bugFilter;
    if (state.errors.bugs && !state.data.bugs.length) {
      container.innerHTML = inlineError('bugs');
      return;
    }
    const bugs = state.data.bugs.filter((bug) => state.bugFilter === 'all' || bug.status === state.bugFilter);
    container.innerHTML = `${inlineError('bugs')}${bugs.length ? bugs.map((bug) => `<article class="issue-card bug-card severity-${escapeHtml(bug.severity)}">
      <div class="issue-main">
        <div class="issue-head"><span class="issue-avatar bug">🐞</span><span class="issue-key">${shortKey(bug.id)}</span><span class="issue-title">${escapeHtml(bug.title)}</span></div>
        ${bug.description ? `<p class="board-description">${escapeHtml(bug.description)}</p>` : ''}
        <div class="issue-meta"><span class="status ${escapeHtml(bug.status)}">${escapeHtml(statusLabel(bug.status))}</span><span class="severity-badge ${escapeHtml(bug.severity)}">${escapeHtml(severityLabel(bug.severity))}</span><span class="chip">${escapeHtml(sprintName(bug.sprintId))}</span>${bug.source === 'agent' ? '<span class="chip kind-bug">Agent</span>' : '<span class="chip">Manuell</span>'}<span class="chip">Gemeldet: ${escapeHtml(formatDateTime(bug.createdAt))}</span>${bug.fixedAt ? `<span class="chip">Behoben: ${escapeHtml(formatDateTime(bug.fixedAt))}</span>` : ''}</div>
        ${bug.fixNotes ? `<div class="bug-notes"><strong>Fix-Notizen</strong><p>${escapeHtml(bug.fixNotes)}</p></div>` : ''}
        <details class="edit-details"><summary>Bug bearbeiten</summary>
          <form data-form="bug-edit" data-id="${escapeHtml(bug.id)}" class="bug-edit-form">
            <label>Titel<input name="title" maxlength="180" value="${escapeHtml(bug.title)}" required></label>
            <label>Beschreibung<textarea name="description" maxlength="10000">${escapeHtml(bug.description ?? '')}</textarea></label>
            <div class="estimate-grid narrow"><label>Schweregrad<select name="severity">${options(['low', 'medium', 'high', 'critical'], severityLabel, bug.severity)}</select></label><label>Sprint<select name="sprintId">${sprintOptions(bug.sprintId, 'Kein Sprint', true)}</select></label></div>
            <label>Fix-Notizen<textarea name="fixNotes" maxlength="10000">${escapeHtml(bug.fixNotes ?? '')}</textarea></label>
            <button class="btn btn-outline" type="submit">Speichern</button>
          </form>
        </details>
      </div>
      <div class="issue-controls">
        <select data-bug-status="${escapeHtml(bug.id)}" aria-label="Bug-Status">${options(['open', 'in_progress', 'fixed', 'wontfix'], statusLabel, bug.status)}</select>
        <select data-bug-sprint="${escapeHtml(bug.id)}" aria-label="Sprint">${sprintOptions(bug.sprintId, 'Kein Sprint', true)}</select>
        <button class="btn btn-danger" type="button" data-action="bug-delete" data-id="${escapeHtml(bug.id)}">Löschen</button>
      </div>
    </article>`).join('') : emptyState(state.bugFilter === 'all' ? 'Noch keine Bugs gemeldet.' : 'Keine Bugs für diesen Status gefunden.')}`;
  }

  function renderInlineMarkdown(text) {
    const codes = [];
    let html = text.replace(/`([^`]+)`/g, (_, code) => `@@CODE${codes.push(code) - 1}@@`);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="doc-link">$1<span class="doc-link-url"> ($2)</span></span>');
    html = html.replace(/@@CODE(\d+)@@/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
    return html;
  }

  function renderMarkdown(markdown) {
    const lines = escapeHtml(markdown || '').split(/\r?\n/);
    const blocks = [];
    let paragraph = [];
    let listType = '';
    let listItems = [];
    let inCode = false;
    let codeLines = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!listItems.length) return;
      blocks.push(`<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${listType}>`);
      listItems = [];
      listType = '';
    };
    const flushCode = () => {
      if (!codeLines.length) return;
      blocks.push(`<pre class="doc-code"><code>${codeLines.join('\n')}</code></pre>`);
      codeLines = [];
    };

    for (const line of lines) {
      if (/^```/.test(line)) {
        flushParagraph();
        flushList();
        if (inCode) flushCode();
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        blocks.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      const unordered = line.match(/^[-*]\s+(.*)$/);
      if (unordered) {
        flushParagraph();
        if (listType && listType !== 'ul') flushList();
        listType = 'ul';
        listItems.push(unordered[1]);
        continue;
      }
      const ordered = line.match(/^\d+\.\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        if (listType && listType !== 'ol') flushList();
        listType = 'ol';
        listItems.push(ordered[1]);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    flushCode();
    return blocks.join('') || '<p>Keine Inhalte vorhanden.</p>';
  }

  function renderDocs() {
    const container = document.querySelector('#docs-content');
    const docs = state.data.docs;
    if (!docs.length && state.errors.docs) {
      container.innerHTML = inlineError('docs');
      return;
    }
    const groups = ['manual', 'sprint', 'order', 'repo'];
    const selected = docs.find((doc) => doc.id === state.selectedDocId) ?? docs[0] ?? null;
    state.selectedDocId = selected?.id ?? '';
    container.innerHTML = `${inlineError('docs')}
      <div class="docs-shell">
        <aside class="docs-sidebar">
          <div class="docs-groups">${groups.map((group) => {
            const inGroup = docs.filter((doc) => doc.kind === group);
            return `<section class="doc-group"><h3>${escapeHtml(docKindLabel(group))}</h3>${inGroup.length ? inGroup.map((doc) => `<button class="doc-link-item ${selected?.id === doc.id ? 'active' : ''}" type="button" data-doc-select="${escapeHtml(doc.id)}"><span>${escapeHtml(doc.title)}</span><small>${escapeHtml(formatDateTime(doc.updatedAt))}</small></button>`).join('') : '<div class="kanban-empty">Keine Einträge</div>'}</section>`;
          }).join('')}</div>
          <form id="doc-create-form" class="card-form single-column">
            <h3>Neues Dokument</h3>
            <label>Titel<input name="title" maxlength="180" required placeholder="Titel des Handbuchs"></label>
            <label>Inhalt<textarea name="content" maxlength="30000" required placeholder="# Überblick"></textarea></label>
            <button class="btn btn-primary" type="submit">Dokument speichern</button>
          </form>
        </aside>
        <section class="doc-reader">${selected ? `
          <header class="doc-reader-head"><div><span class="chip">${escapeHtml(docKindLabel(selected.kind))}</span><h3>${escapeHtml(selected.title)}</h3><div class="issue-meta"><span>Aktualisiert: ${escapeHtml(formatDateTime(selected.updatedAt))}</span>${selected.sprintId ? `<span>Sprint: ${escapeHtml(sprintName(selected.sprintId))}</span>` : ''}</div></div></header>
          <article class="doc-preview">${renderMarkdown(selected.content)}</article>
          ${selected.kind === 'manual' ? `<form id="doc-edit-form" class="card-form single-column" data-doc-id="${escapeHtml(selected.id)}"><h3>Dokument bearbeiten</h3><label>Titel<input name="title" maxlength="180" value="${escapeHtml(selected.title)}" required></label><label>Inhalt<textarea name="content" maxlength="30000" required>${escapeHtml(selected.content ?? '')}</textarea></label><div class="docs-actions"><button class="btn btn-primary" type="submit">Speichern</button><button class="btn btn-danger" type="button" data-action="doc-delete" data-id="${escapeHtml(selected.id)}">Löschen</button></div></form>` : '<div class="empty-panel">Automatisch erzeugte Dokumentation ist schreibgeschützt. Nutze ein Handbuch-Dokument für manuelle Ergänzungen.</div>'}` : hintState('Noch keine Dokumente vorhanden. Lege links ein neues Handbuch an oder erzeuge Sprint-Dokumentation.')}
        </section>
      </div>`;
  }

  function updateSummary() {
    const project = state.projects.find((item) => item.slug === state.activeProject);
    document.querySelector('#project-repository').textContent = project?.repository ?? '';
    const settings = document.querySelector('#git-remote-form');
    if (project && !settings.contains(document.activeElement)) {
      settings.elements.repository.value = project.repository ?? '';
      settings.elements.gitRemote.value = project.gitRemote ?? '';
      settings.elements.testCommands.value = (project.testCommands ?? []).map((command) => command.join(' ')).join('\n');
    }
    document.querySelector('#nav-count-dashboard').textContent = state.data.stats?.sprint ? '1' : '0';
    document.querySelector('#nav-count-development').textContent = String((state.data.board.development ?? []).filter((item) => item.status !== 'done').length);
    document.querySelector('#nav-count-sprints').textContent = String(state.data.sprints.length);
    document.querySelector('#nav-count-ideation').textContent = String((state.data.board.ideas ?? []).filter((item) => item.status !== 'rejected').length);
    document.querySelector('#nav-count-bugs').textContent = String((state.data.bugs ?? []).filter((bug) => bug.status === 'open' || bug.status === 'in_progress').length);
    document.querySelector('#nav-count-docs').textContent = String(state.data.docs.length);
    document.querySelector('#nav-count-agents').textContent = String(state.data.agents.length);
    document.querySelector('#nav-count-runs').textContent = String(state.data.runs.length);
  }

  function renderAll() {
    updateSummary();
    renderDashboard();
    renderBoard();
    renderSprints();
    renderBugs();
    renderDocs();
    renderAgents();
    renderAgentRuns();
    renderRuns();
  }

  async function refreshWorker() {
    const box = document.querySelector('#worker-status');
    const text = document.querySelector('#worker-text');
    if (!box || !state.activeProject) {
      return;
    }
    try {
      const data = await api(`/api/projects/${encodeURIComponent(state.activeProject)}/worker`);
      const busy = data.running?.length > 0;
      box.className = `worker-status ${!data.online ? 'worker-offline' : busy ? 'worker-busy' : 'worker-online'}`;
      if (!data.online) {
        text.textContent = data.worker ? 'Worker offline' : 'Worker nie gestartet';
        box.title = 'Start: dev-log/scripts/install-worker.sh ' + state.activeProject;
      } else if (busy) {
        text.textContent = `Worker arbeitet: ${data.running[0].title}`;
        box.title = `Seit ${new Date(data.running[0].startedAt).toLocaleTimeString('de-CH')}`;
      } else {
        text.textContent = 'Worker bereit';
        box.title = data.worker.lastError ? `Letzter Fehler: ${data.worker.lastError}` : `Prüft alle ${data.worker.intervalSeconds} s auf Aufträge im aktiven Sprint`;
      }
    } catch {
      box.className = 'worker-status worker-offline';
      text.textContent = 'Status nicht abrufbar';
    }
  }

  async function loadProject(slug) {
    state.activeProject = slug;
    refreshWorker();
    if (!slug) {
      workspace.classList.add('hidden');
      return;
    }
    clearNotice();
    loading.classList.remove('hidden');
    workspace.classList.add('hidden');

    const base = `/api/projects/${encodeURIComponent(slug)}`;
    const requests = {
      board: api(`${base}/board`),
      sprints: api(`${base}/sprints`),
      agents: api(`${base}/agents`),
      agentRuns: api(`${base}/agent-runs`),
      runs: api(`${base}/test-runs`),
      stats: api(`${base}/stats`),
      bugs: api(`${base}/bugs`),
      docs: api(`${base}/docs`),
      reports: api(`${base}/sprint-reports`),
    };
    const defaults = {
      board: { ideas: [], development: [] },
      sprints: [],
      agents: [],
      agentRuns: [],
      runs: [],
      stats: null,
      bugs: [],
      docs: [],
      reports: [],
    };
    const normalizers = {
      board: (result) => ({ ideas: result.ideas ?? [], development: result.development ?? [] }),
      sprints: (result) => result.sprints ?? [],
      agents: (result) => result.agents ?? [],
      agentRuns: (result) => result.runs ?? [],
      runs: (result) => result.runs ?? [],
      stats: (result) => result,
      bugs: (result) => result.bugs ?? [],
      docs: (result) => result.docs ?? [],
      reports: (result) => result.reports ?? [],
    };

    const entries = Object.entries(requests);
    const settled = await Promise.allSettled(entries.map(([, request]) => request));
    state.errors = {};
    entries.forEach(([key], index) => {
      const result = settled[index];
      if (result.status === 'fulfilled') {
        state.data[key] = normalizers[key](result.value);
      } else {
        state.data[key] = defaults[key];
        state.errors[key] = result.reason instanceof Error ? result.reason.message : 'Daten konnten nicht geladen werden.';
      }
    });
    reconcileProjectData();

    if (!state.data.docs.some((doc) => doc.id === state.selectedDocId)) {
      state.selectedDocId = state.data.docs[0]?.id ?? '';
    }

    renderAll();
    workspace.classList.remove('hidden');
    loading.classList.add('hidden');

    const failedResources = Object.keys(state.errors);
    if (failedResources.length) {
      showNotice(`Einige Bereiche konnten nicht geladen werden: ${failedResources.map((key) => RESOURCE_LABELS[key] ?? key).join(', ')}.`);
    }
  }

  async function loadProjects(selectedSlug) {
    const result = await api('/api/projects');
    state.projects = result.projects ?? [];
    projectSelect.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.slug)}">${escapeHtml(project.name)}</option>`).join('');
    if (!state.projects.length) {
      projectSelect.innerHTML = '<option value="">Noch kein Projekt</option>';
      workspace.classList.add('hidden');
      showNotice('Lege ein Projekt an oder führe den Test-Agenten aus. Der Agent registriert das Projekt automatisch.');
      loading.classList.add('hidden');
      return;
    }
    const slug = selectedSlug && state.projects.some((project) => project.slug === selectedSlug) ? selectedSlug : state.projects[0].slug;
    projectSelect.value = slug;
    await loadProject(slug);
  }

  async function run(action, success) {
    try {
      await action();
      await loadProject(state.activeProject);
      if (success) showNotice(success);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Aktion fehlgeschlagen.');
    }
  }

  const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const projectPath = () => `/api/projects/${encodeURIComponent(state.activeProject)}`;

  function showView() {
    const views = [...document.querySelectorAll('.view')];
    const fallback = 'dashboard';
    const hash = globalThis.location.hash.slice(1);
    const name = views.some((view) => view.id === hash) ? hash : fallback;
    if (hash !== name && globalThis.location.hash !== `#${name}`) globalThis.location.hash = `#${name}`;
    views.forEach((view) => view.classList.toggle('hidden', view.id !== name));
    document.querySelectorAll('.rail-link').forEach((link) => link.classList.toggle('active', link.dataset.section === name));
  }

  function handleWorkspaceChange(event) {
    const target = event.target;
    if (target.id === 'bug-filter-status') {
      state.bugFilter = target.value;
      renderBugs();
      return;
    }
    if (target.dataset.developmentId) {
      void run(() => patch(`/api/development/${encodeURIComponent(target.dataset.developmentId)}`, { status: target.value }), 'Entwicklungsstatus wurde gespeichert.');
      return;
    }
    if (target.dataset.itemSprint) {
      void run(() => patch(`/api/development/${encodeURIComponent(target.dataset.itemSprint)}`, { sprintId: target.value || null }), 'Sprint-Zuordnung gespeichert.');
      return;
    }
    if (target.dataset.agentPhase) {
      void run(() => patch(`/api/agents/${encodeURIComponent(target.dataset.agentPhase)}`, { phase: target.value }), 'Agent verschoben.');
      return;
    }
    if (target.dataset.ideaId) {
      void run(() => patch(`/api/ideation/${encodeURIComponent(target.dataset.ideaId)}`, { status: target.value }), 'Ideenstatus wurde gespeichert.');
      return;
    }
    if (target.dataset.bugStatus) {
      void run(() => patch(`/api/bugs/${encodeURIComponent(target.dataset.bugStatus)}`, { status: target.value }), 'Bug-Status wurde gespeichert.');
      return;
    }
    if (target.dataset.bugSprint) {
      void run(() => patch(`/api/bugs/${encodeURIComponent(target.dataset.bugSprint)}`, { sprintId: target.value || null }), 'Sprint-Zuordnung für Bug gespeichert.');
    }
  }

  document.querySelector('#new-project-toggle').addEventListener('click', () => {
    projectForm.classList.toggle('hidden');
  });

  document.querySelector('#refresh-button').addEventListener('click', () => {
    void loadProjects(state.activeProject).catch((error) => showNotice(error instanceof Error ? error.message : 'Projekt konnte nicht geladen werden.'));
  });

  document.querySelector('#git-remote-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.activeProject) return;
    const data = new FormData(event.currentTarget);
    const body = {
      repository: String(data.get('repository') ?? '').trim(),
      gitRemote: String(data.get('gitRemote') ?? '').trim(),
      testCommands: String(data.get('testCommands') ?? ''),
    };
    void run(async () => {
      const { project } = await api(`/api/projects/${encodeURIComponent(state.activeProject)}`, { method: 'PATCH', body: JSON.stringify(body) });
      const index = state.projects.findIndex((item) => item.slug === state.activeProject);
      if (index >= 0) state.projects[index] = { ...state.projects[index], ...project };
    }, 'Projekteinstellungen gespeichert.');
  });

  projectSelect.addEventListener('change', () => void loadProject(projectSelect.value));
  bugFilter.addEventListener('change', handleWorkspaceChange);
  document.querySelector('#workspace').addEventListener('change', handleWorkspaceChange);
  globalThis.addEventListener('hashchange', showView);

  projectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(projectForm);
    try {
      const result = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ slug: data.get('slug'), name: data.get('name'), repository: data.get('repository') }),
      });
      if (String(data.get('gitRemote') ?? '').trim()) {
        await api(`/api/projects/${encodeURIComponent(String(data.get('slug')))}`, {
          method: 'PATCH',
          body: JSON.stringify({ gitRemote: String(data.get('gitRemote')).trim() }),
        });
      }
      projectForm.reset();
      projectForm.classList.add('hidden');
      await loadProjects(result.project.slug);
      showNotice('Projekt wurde gespeichert.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Projekt konnte nicht gespeichert werden.');
    }
  });

  document.querySelector('#idea-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api(`${projectPath()}/ideation`, {
        method: 'POST',
        body: JSON.stringify({
          title: data.get('title'),
          description: data.get('description'),
          priority: data.get('priority'),
          ...estimateBody(data),
        }),
      });
      form.reset();
      await loadProject(state.activeProject);
      showNotice('Idee wurde hinzugefügt.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Idee konnte nicht gespeichert werden.');
    }
  });

  document.querySelector('#development-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api(`${projectPath()}/development`, {
        method: 'POST',
        body: JSON.stringify({ title: data.get('title'), priority: data.get('priority') }),
      });
      form.reset();
      await loadProject(state.activeProject);
      showNotice('Entwicklungsauftrag wurde hinzugefügt.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Aufgabe konnte nicht gespeichert werden.');
    }
  });

  document.querySelector('#sprint-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await post(`${projectPath()}/sprints`, {
        name: data.get('name'),
        goal: data.get('goal'),
        startDate: data.get('startDate') || null,
        endDate: data.get('endDate') || null,
      });
      form.reset();
    }, 'Sprint angelegt.');
  });

  document.querySelector('#agent-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await post(`${projectPath()}/agents`, {
        name: data.get('name'),
        role: data.get('role'),
        phase: data.get('phase'),
        instructions: data.get('instructions'),
        command: parseCommand(String(data.get('command') ?? '')),
      });
      form.reset();
    }, 'Agent angelegt.');
  });

  document.querySelector('#bug-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await post(`${projectPath()}/bugs`, {
        title: data.get('title'),
        description: data.get('description') || '',
        severity: data.get('severity') || 'medium',
        sprintId: data.get('sprintId') || null,
      });
      form.reset();
    }, 'Bug wurde gemeldet.');
  });

  document.querySelector('#workspace').addEventListener('submit', (event) => {
    const form = event.target.closest('form');
    if (!form) return;
    if (form.dataset.form === 'revise-idea') {
      event.preventDefault();
      const prompt = new FormData(form).get('prompt');
      void run(() => post(`/api/ideation/${encodeURIComponent(form.dataset.id)}/revise`, { prompt }), 'Der Agent überarbeitet die Anforderung.');
      return;
    }
    if (form.dataset.form === 'estimate-idea' || form.dataset.form === 'estimate-development') {
      event.preventDefault();
      const kind = form.dataset.form === 'estimate-idea' ? 'ideation' : 'development';
      void run(() => patch(`/api/${kind}/${encodeURIComponent(form.dataset.id)}`, estimateBody(new FormData(form))), 'Änderungen gespeichert.');
      return;
    }
    if (form.dataset.form === 'bug-edit') {
      event.preventDefault();
      const data = new FormData(form);
      void run(() => patch(`/api/bugs/${encodeURIComponent(form.dataset.id)}`, {
        title: data.get('title'),
        description: data.get('description') || '',
        severity: data.get('severity'),
        sprintId: data.get('sprintId') || null,
        fixNotes: data.get('fixNotes') || '',
      }), 'Bug wurde gespeichert.');
      return;
    }
    if (form.dataset.form === 'report-notes') {
      event.preventDefault();
      const data = new FormData(form);
      void run(() => patch(`/api/sprints/${encodeURIComponent(form.dataset.id)}/report`, { notes: data.get('notes') || '' }), 'Sprintbericht-Notizen gespeichert.');
      return;
    }
    if (form.id === 'doc-create-form') {
      event.preventDefault();
      const data = new FormData(form);
      void run(async () => {
        await post(`${projectPath()}/docs`, { title: data.get('title'), content: data.get('content') });
        form.reset();
      }, 'Dokument gespeichert.');
      return;
    }
    if (form.id === 'doc-edit-form') {
      event.preventDefault();
      const data = new FormData(form);
      const docId = form.dataset.docId;
      void run(() => patch(`/api/docs/${encodeURIComponent(docId)}`, { title: data.get('title'), content: data.get('content') }), 'Dokument gespeichert.');
    }
  });

  document.querySelector('#default-agents-button').addEventListener('click', () => {
    void run(() => post(`${projectPath()}/agents/defaults`), 'Standard-Workflow angelegt.');
  });

  document.querySelector('#workspace').addEventListener('click', (event) => {
    const target = event.target.closest('[data-action], [data-doc-select]');
    if (!target) return;
    if (target.dataset.docSelect) {
      state.selectedDocId = target.dataset.docSelect;
      renderDocs();
      return;
    }
    const { action, id } = target.dataset;
    if (action === 'git-resync') {
      void run(() => post(`/api/sprints/${encodeURIComponent(id)}/git-sync`, {}), 'Git-Sicherung wird vom Worker erneut ausgeführt.');
      return;
    }
    if (action === 'draft') {
      void run(() => patch(`/api/ideation/${encodeURIComponent(id)}`, { status: 'requested' }), 'Anforderung angefragt – der Worker erstellt den Auftrag.');
      return;
    }
    if (action === 'promote') {
      const sprintId = document.querySelector(`[data-promote-sprint="${CSS.escape(id)}"]`)?.value || null;
      void run(() => post(`/api/ideation/${encodeURIComponent(id)}/promote`, { sprintId }), 'Entwicklungsauftrag erstellt.');
      return;
    }
    if (action === 'sprint-status') {
      void run(() => patch(`/api/sprints/${encodeURIComponent(id)}`, { status: target.dataset.status }), 'Sprint aktualisiert.');
      return;
    }
    if (action === 'sprint-delete') {
      if (globalThis.confirm('Sprint löschen? Die Aufträge bleiben im Backlog erhalten.')) {
        void run(() => api(`/api/sprints/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Sprint gelöscht.');
      }
      return;
    }
    if (action === 'agent-toggle') {
      void run(() => patch(`/api/agents/${encodeURIComponent(id)}`, { enabled: target.dataset.enabled !== 'true' }), 'Agent aktualisiert.');
      return;
    }
    if (action === 'agent-delete') {
      if (globalThis.confirm('Agent löschen?')) {
        void run(() => api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Agent gelöscht.');
      }
      return;
    }
    if (action === 'agent-move') {
      const ids = state.data.agents.filter((agent) => agent.phase === target.dataset.phase).map((agent) => agent.id);
      const index = ids.indexOf(id);
      const nextIndex = index + Number(target.dataset.direction);
      if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
      [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
      void run(() => post(`${projectPath()}/agents/order`, { phase: target.dataset.phase, ids }), 'Reihenfolge gespeichert.');
      return;
    }
    if (action === 'bug-delete') {
      if (globalThis.confirm('Bug löschen?')) {
        void run(() => api(`/api/bugs/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Bug gelöscht.');
      }
      return;
    }
    if (action === 'report-refresh') {
      void run(() => post(`/api/sprints/${encodeURIComponent(id)}/report`), 'Sprintbericht wurde aktualisiert.');
      return;
    }
    if (action === 'doc-delete') {
      if (globalThis.confirm('Dokument löschen?')) {
        void run(async () => {
          await api(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (state.selectedDocId === id) state.selectedDocId = '';
        }, 'Dokument gelöscht.');
      }
    }
  });

  showView();
  loadProjects().catch((error) => {
    loading.classList.add('hidden');
    showNotice(error instanceof Error ? error.message : 'Dev Log konnte nicht geladen werden.');
  });
  setInterval(refreshWorker, 10000);
})();
