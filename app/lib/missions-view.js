// The Missions view: this folder's missions on the left, the chosen one on the right. Main sends
// ready-made timeline rows and report sections (mission-report.ts); this only lays them out.
const LIVE = new Set(['draft', 'running', 'waiting']);
const OVER = new Set(['finished', 'blocked', 'cancelled']);
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const age = (at) => {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

export function createMissionsView({ spark, el, markdown, onStart, onToggle }) {
  const root = document.getElementById('missions');
  const items = document.getElementById('mission-items');
  const detail = document.getElementById('mission-detail');
  const objective = document.getElementById('mission-objective');
  let selected = null;
  let timeline = null;
  // Missions whose checks are running: from main's 'verifying' until their report.
  const checking = new Set();

  const pill = (status) => el('span', `pill ${status}`, status);

  async function renderList() {
    const missions = await spark.missions();
    if (!missions.length) {
      items.replaceChildren(el('li', 'empty', 'No missions in this folder yet. Say what should be true when the work is done, and Claude drafts criteria for you to approve.'));
      return;
    }
    items.replaceChildren(
      ...missions.map((m) => {
        const li = el('li', `item${m.id === selected ? ' selected' : ''}`);
        const button = el('button');
        button.type = 'button';
        if (m.unreadable) button.append(el('span', 'title', m.id), el('span', 'meta', 'unreadable mission file'));
        else button.append(el('span', 'title', m.title), el('span', 'meta', age(m.createdAt)), pill(m.status));
        if (m.id === selected) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => show(m.id));
        li.append(button);
        return li;
      }),
    );
  }

  function header(view) {
    const m = view.mission;
    const head = el('header', 'mission-head');
    const started = m.approvedAt ?? m.createdAt;
    const elapsed = el('span', 'elapsed', mmss((m.endedAt ?? Date.now()) - started));
    elapsed.dataset.since = String(started);
    elapsed.dataset.live = String(LIVE.has(m.status));
    const cost = view.totals.usd === undefined ? 'cost not reported' : `$${view.totals.usd.toFixed(2)} at API rates`;
    const tokens = view.totals.tokens === undefined ? '' : ` · ${Math.round(view.totals.tokens / 1000)}k tokens`;
    const status = el('span', 'state');
    status.setAttribute('role', 'status');
    status.append(pill(m.status), el('span', 'reason', m.reason));
    const facts = el('div', 'facts');
    facts.append(status, elapsed, el('span', 'cost', `${cost}${tokens}`));
    const actions = el('div', 'mission-actions');
    const button = (label, cls, action) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        const out = await spark.mission({ action, id: m.id });
        if (out.error) actions.append(el('span', 'error', out.error));
      });
      return b;
    };
    if (m.status === 'paused' || m.status === 'interrupted') actions.append(button('Resume', 'yes', 'resume'));
    if (!OVER.has(m.status)) actions.append(button('Cancel', 'no', 'cancel'));
    if (checking.has(m.id)) status.append(el('span', 'reason', 'Spark is running its checks…'));
    else if (OVER.has(m.status)) {
      const again = button('Check again', 'ghost', 'check-again');
      again.title = "Run Spark's checks again, on the working tree as it is now";
      actions.append(again);
    }
    const back = el('button', 'ghost', 'Back to chat');
    back.type = 'button';
    back.addEventListener('click', () => onToggle(false));
    actions.append(back);
    head.append(el('h2', '', m.title), ...(m.objective === m.title ? [] : [el('p', 'objective', m.objective)]), facts, actions);
    return head;
  }

  function rowNode(row) {
    const li = el('li', `tl-row ${row.tone}`);
    li.append(el('time', '', time(row.at)), el('span', 'glyph', row.glyph), el('span', 'text', row.text));
    if (row.detail) {
      const more = el('details');
      more.append(el('summary', '', 'output'), el('pre', '', row.detail));
      li.append(more);
    }
    return li;
  }

  function reportNode(sections) {
    const box = el('section', 'report');
    box.append(el('h3', '', 'Report'));
    for (const s of sections) {
      const part = el('div', 'part');
      part.append(el('h4', '', s.heading));
      if (s.markdown) {
        const body = el('div', 'claude');
        body.innerHTML = markdown(s.lines[0]?.text ?? '');
        part.append(body);
      } else if (!s.lines.length) part.append(el('p', 'none', 'none'));
      else {
        const ul = el('ul');
        for (const line of s.lines) ul.append(el('li', line.tone ?? '', line.text));
        part.append(ul);
      }
      box.append(part);
    }
    return box;
  }

  // The task graph in layers: a task sits one layer below the longest chain it waits for, so
  // tasks in one layer don't wait for each other. Selecting one shows what happened in it.
  function planNode(plan, spec) {
    const box = el('section', 'plan');
    box.append(el('h3', '', 'Plan'));
    if (spec) box.append(el('p', 'spec', spec));
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const panel = el('div', 'task-panel');
    const graph = el('div', 'plan-graph');
    const select = (t, node) => {
      for (const n of graph.querySelectorAll('.task-node')) n.setAttribute('aria-pressed', String(n === node));
      panel.replaceChildren(...taskDetail(t));
    };
    plan.layers.forEach((layer, i) => {
      if (i) graph.append(el('div', 'layer-arrow', '↓'));
      const row = el('div', 'layer');
      for (const id of layer) {
        const t = byId.get(id);
        const node = el('button', `task-node ${t.state.replace(' ', '-')}`);
        node.type = 'button';
        node.setAttribute('aria-pressed', 'false');
        node.append(el('span', 'task-id', t.id), el('span', 'task-title', t.title), el('span', 'task-state', t.state), el('span', 'task-after', t.after.length ? `after ${t.after.join(', ')}` : 'starts first'));
        node.addEventListener('click', () => select(t, node));
        row.append(node);
      }
      graph.append(row);
    });
    const parallel = plan.layers.some((l) => l.length > 1);
    box.append(graph, ...(parallel ? [el('p', 'note', 'Tasks side by side don’t wait for each other; Spark still runs them one at a time.')] : []), panel);
    panel.append(el('p', 'none', 'Select a task to see its instructions, changes, check and timeline.'));
    return box;
  }

  function taskDetail(t) {
    const out = [el('h4', '', `${t.id} · ${t.title}`), el('p', 'task-do', t.do)];
    const facts = el('ul', 'task-facts');
    facts.append(el('li', '', `State: ${t.state}${t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}`));
    facts.append(el('li', '', t.after.length ? `Waits for ${t.after.join(', ')}` : 'Waits for nothing'));
    facts.append(el('li', '', t.check ? `Check: ${t.check}` : 'No check: Spark takes Claude’s word for this task'));
    const c = t.checkResult;
    if (c) facts.append(el('li', c.status === 'pass' ? 'ok' : c.status === 'not-run' ? 'warn' : 'fail', `Result: ${c.status}${c.exit === undefined ? '' : ` (exit ${c.exit})`}${c.reason ? ` · ${c.reason}` : ''}`));
    if (t.note) facts.append(el('li', 'warn', t.note));
    out.push(facts);
    if (t.files?.length) {
      const files = el('ul', 'task-files');
      for (const f of t.files) files.append(el('li', '', `${f.path} +${f.added} −${f.removed}`));
      out.push(el('h5', '', 'Changed files'), files);
    }
    if (t.rows.length) {
      const rows = el('ol', 'task-rows');
      rows.append(...t.rows.map(rowNode));
      out.push(el('h5', '', 'Timeline'), rows);
    }
    return out;
  }

  async function show(id) {
    selected = id;
    const view = id ? await spark.missionView(id) : undefined;
    if (!view) {
      detail.replaceChildren(el('p', 'empty', 'Pick a mission, or start one on the left.'));
      timeline = null;
    } else {
      const criteria = el('section', 'criteria-list');
      criteria.append(el('h3', '', 'Criteria'));
      if (!view.mission.criteria.length) criteria.append(el('p', 'none', 'none yet'));
      const ol = el('ol');
      for (const c of view.mission.criteria) ol.append(el('li', '', `${c.text} · ${c.how}${c.by === 'you' ? ' · yours' : ''}`));
      criteria.append(ol);
      const log = el('section', 'timeline');
      log.append(el('h3', '', 'Timeline'));
      timeline = el('ol');
      timeline.append(...view.rows.map(rowNode));
      log.append(timeline);
      const plan = view.plan ? [planNode(view.plan, view.mission.spec)] : [];
      detail.replaceChildren(header(view), ...(view.sections ? [reportNode(view.sections)] : []), ...plan, criteria, log);
    }
    renderList();
  }

  document.getElementById('mission-new').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = objective.value.trim();
    if (!text) return;
    objective.value = '';
    onStart(text);
  });
  // On the document: re-rendering the list drops focus to the body, outside the view.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden && !document.querySelector('dialog[open]')) onToggle(false);
  });

  return {
    isOpen: () => !root.hidden,
    async open(id) {
      onToggle(true);
      await show(id ?? selected ?? (await spark.missions()).find((m) => !m.unreadable)?.id ?? null);
      objective.focus();
    },
    close: () => onToggle(false),
    update(mission) {
      if (root.hidden) return;
      if (mission.id === selected) show(selected);
      else renderList();
    },
    addRow(id, row) {
      if (!root.hidden && id === selected && timeline) timeline.append(rowNode(row));
    },
    verifying(id) {
      checking.add(id);
      if (!root.hidden && id === selected) show(id);
    },
    showReport(id) {
      checking.delete(id);
      if (!root.hidden && id === selected) show(id);
    },
    tick() {
      const node = detail.querySelector('.elapsed[data-live="true"]');
      if (node) node.textContent = mmss(Date.now() - Number(node.dataset.since));
    },
  };
}
