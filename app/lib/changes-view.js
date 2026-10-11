// The Changes view: Spark's checkpoints on the left (turn snapshots and mission pins, from
// checkpoints.ts), the chosen one on the right with what changed since and a guarded restore.
const KIND = { turn: 'turn', 'mission-start': 'mission', task: 'task', 'mission-end': 'mission' };
const FILE_KIND = { modified: 'changed', new: 'new since', deleted: 'deleted since', binary: 'binary', lockfile: 'lockfile' };
const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function createChangesView({ spark, el, onToggle }) {
  const root = document.getElementById('changes');
  const items = document.getElementById('checkpoint-items');
  const detail = document.getElementById('checkpoint-detail');
  let selected = null;

  async function renderList() {
    const out = await spark.checkpoints();
    if (out.error) {
      items.replaceChildren(el('li', 'empty', out.error));
      detail.replaceChildren();
      return [];
    }
    if (!out.list.length) {
      items.replaceChildren(el('li', 'empty', 'No checkpoints yet: Spark takes one before each prompt you send.'));
      return [];
    }
    items.replaceChildren(
      ...out.list.map((c) => {
        const li = el('li', `item${c.sha === selected ? ' selected' : ''}`);
        const button = el('button');
        button.type = 'button';
        button.append(el('span', 'title', c.label), el('span', 'meta', `${when(c.at)} · ${KIND[c.kind]}`));
        if (c.tests) button.append(el('span', `pill ${c.tests === 'passed' ? 'finished' : 'blocked'}`, `tests ${c.tests}`));
        if (c.sha === selected) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => show(c));
        li.append(button);
        return li;
      }),
    );
    return out.list;
  }

  function patchNode(patch) {
    const pre = el('pre', 'patch');
    for (const line of patch.split('\n')) {
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '';
      pre.append(el('span', cls, `${line}\n`));
    }
    return pre;
  }

  function filesNode(diffs) {
    if (!diffs.length) return el('p', 'none', 'The working tree matches this checkpoint.');
    const ul = el('ul', 'change-files');
    for (const d of diffs) {
      const li = el('li', `change ${d.kind}`);
      const head = `${d.path} · ${FILE_KIND[d.kind] ?? d.kind}${d.kind === 'binary' ? '' : ` · +${d.added} −${d.removed}`}`;
      if (d.patch) {
        const more = el('details');
        more.append(el('summary', '', head), patchNode(d.patch));
        li.append(more);
      } else li.append(el('span', '', head));
      ul.append(li);
    }
    return ul;
  }

  // The confirmation: which files a restore changes, in three kinds, and the way back.
  function confirmNode(c, changes, actions) {
    const box = el('div', 'restore-confirm');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', 'Restore this checkpoint?');
    const { putBack, removed, broughtBack } = changes.plan;
    const n = putBack.length + removed.length + broughtBack.length;
    box.append(el('p', '', `Restoring makes ${n} file${n === 1 ? '' : 's'} match this checkpoint:`));
    const group = (title, files) => {
      if (!files.length) return;
      const ul = el('ul');
      for (const f of files) ul.append(el('li', '', f));
      box.append(el('h5', '', title), ul);
    };
    group('Put back as they were', putBack);
    group('Deleted (made since)', removed);
    group('Brought back (deleted since)', broughtBack);
    box.append(el('p', 'note', 'Spark saves the current state as a checkpoint first: restore that one to undo. Files git ignores are not touched.'));
    const bar = el('div', 'buttons');
    const go = el('button', 'no', 'Restore');
    const cancel = el('button', 'ghost', 'Cancel');
    go.type = cancel.type = 'button';
    cancel.addEventListener('click', () => box.replaceWith(actions));
    go.addEventListener('click', async () => {
      go.disabled = cancel.disabled = true;
      const out = await spark.checkpointRestore(c.sha);
      if (out.error) {
        box.replaceWith(actions);
        actions.append(el('span', 'error', out.error));
        return;
      }
      await renderList();
      const done = el('div', 'restore-done');
      done.setAttribute('role', 'status');
      done.append(el('p', '', `Restored. The state from just before is saved as “${out.undo.label}”.`));
      const undo = el('button', 'ghost', 'Undo this restore');
      undo.type = 'button';
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        const back = await spark.checkpointRestore(out.undo.sha);
        done.append(el('p', back.error ? 'error' : '', back.error ?? 'Undone: the files are as they were before the restore.'));
        await renderList();
      });
      done.append(undo);
      box.replaceWith(done);
    });
    bar.append(go, cancel);
    box.append(bar);
    return box;
  }

  async function show(c) {
    selected = c.sha;
    renderList();
    const head = el('header', 'mission-head');
    const facts = el('div', 'facts');
    facts.append(el('span', '', when(c.at)), el('span', '', KIND[c.kind]), ...(c.tests ? [el('span', c.tests === 'passed' ? 'ok' : 'fail', `tests ${c.tests} on this code`)] : []));
    const actions = el('div', 'mission-actions');
    head.append(el('h2', '', c.label), facts, actions);
    const since = el('section', 'since');
    since.append(el('h3', '', 'Since this checkpoint'), el('p', 'none', 'Comparing with the working tree…'));
    detail.replaceChildren(head, since);
    const changes = await spark.checkpointChanges(c.sha);
    if (selected !== c.sha) return;
    if (changes.error) {
      since.replaceChildren(el('h3', '', 'Since this checkpoint'), el('p', 'error', changes.error));
      return;
    }
    since.replaceChildren(el('h3', '', 'Since this checkpoint'), filesNode(changes.diffs));
    if (changes.diffs.length) {
      const restore = el('button', 'no', 'Restore to this checkpoint');
      restore.type = 'button';
      restore.addEventListener('click', () => actions.replaceWith(confirmNode(c, changes, actions)));
      actions.append(restore);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden && !document.querySelector('dialog[open]')) onToggle(false);
  });

  return {
    isOpen: () => !root.hidden,
    async open() {
      onToggle(true);
      const list = await renderList();
      const first = list.find((c) => c.sha === selected) ?? list[0];
      if (first) show(first);
      else detail.replaceChildren(el('p', 'empty', 'Pick a checkpoint to see what changed since then.'));
    },
    close: () => onToggle(false),
  };
}
