// A council in the chat: first the pre-flight to approve, then the run as it happens, then the
// result. Everything comes from the record main.js saves; nothing here guesses at a state.
const ACCESS = {
  'claude-plan': 'your Claude plan',
  'free-hosted': 'free hosted',
  'paid-hosted': 'paid hosted',
  'gemini-key': 'your Gemini key',
  local: 'local',
};
const ROLE = { proposer: 'proposes', judge: 'judges', synth: 'synthesizes' };
const access = (s) => `${ACCESS[s.access] ?? s.access}${s.openWeights ? ', open weights' : ''}`;
const money = (usd) => `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;

export function councilCard({ el, markdown, spark, note, cap }) {
  const node = el('div', 'council-card');
  let council = null;
  let consent = false;
  let dataCollection = 'deny';

  const section = (title, ...children) => {
    const s = el('section', 'council-part');
    s.append(el('h4', '', title), ...children);
    return s;
  };
  const line = (cls, text) => el('p', cls, text);

  function seats() {
    const p = council.panel;
    return [...p.proposers.map((s) => ['proposer', s]), ...p.judges.map((s) => ['judge', s]), ['synth', p.synth]];
  }

  function panelTable() {
    const table = el('table', 'council-panel');
    const head = el('tr');
    for (const h of ['Role', 'Model', 'Access', 'Why', 'Estimate', 'State']) head.append(el('th', '', h));
    table.append(head);
    for (const [role, s] of seats()) {
      const log = council.run?.seats?.[`${role}:${s.id}`];
      const state = log?.state ?? 'selected';
      const row = el('tr');
      const model = el('td');
      model.append(el('span', 'model-name', s.name), ...(s.name === s.id ? [] : [el('span', 'model-id', s.id)]));
      const stateCell = el('td');
      stateCell.append(el('span', `seat-state ${state.replace(' ', '-')}`, state));
      if (log?.tries > 1) stateCell.append(el('span', 'seat-note', `${log.tries} tries`));
      if (log?.error && state !== 'done') stateCell.append(el('span', 'seat-note', log.error));
      row.append(el('td', '', `${ROLE[role]}${s.perspective ? ` · ${s.perspective}` : ''}`), model, el('td', '', access(s)), el('td', 'why', s.reason), el('td', '', s.estimate?.label ?? ''), stateCell);
      table.append(row);
    }
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    return wrap;
  }

  function briefNode() {
    const b = council.brief;
    const box = el('details', 'council-brief');
    box.open = !council.run;
    box.append(el('summary', '', 'Problem brief: exactly what the models get'));
    const body = el('div', 'brief-body');
    body.append(line('', `Objective: ${b.objective}`));
    for (const [label, items] of [['Constraints', b.constraints], ['Acceptance criteria', b.criteria], ['Verification', b.verification]]) {
      if (!items.length) continue;
      const ul = el('ul');
      for (const i of items) ul.append(el('li', '', i));
      body.append(el('h5', '', label), ul);
    }
    for (const c of b.context) body.append(el('h5', '', `File ${c.file}`), el('pre', '', c.excerpt));
    box.append(body);
    return box;
  }

  function preflight() {
    const parts = [];
    const facts = el('ul', 'council-facts');
    for (const n of council.notes ?? []) facts.append(el('li', '', n));
    if (council.empty.length) facts.append(el('li', 'warn', `Empty seats: ${council.empty.join(', ')}. No proposer is reused as a judge to fill them.`));
    if (council.freeLeft !== undefined) facts.append(el('li', council.freeLeft < council.estimate.freeCalls ? 'warn' : '', `OpenRouter free requests left today: ${council.freeLeft} (this run needs about ${council.estimate.freeCalls})`));
    facts.append(el('li', council.estimate.meteredUsd > cap() ? 'warn' : '', `Paid models: ~${money(council.estimate.meteredUsd)} estimated, against your ${money(cap())} cap. Claude calls are on your plan; Gemini doesn't report cost.`));
    parts.push(facts);
    if (council.consentNeeded.length) {
      const box = el('div', 'council-consent');
      const label = el('label', 'check');
      const tick = el('input');
      tick.type = 'checkbox';
      tick.checked = consent;
      tick.addEventListener('change', () => (consent = tick.checked));
      label.append(tick, ` Send the brief above to ${council.consentNeeded.join(' and ')}. Spark remembers this. Free endpoints often keep prompts or train on them.`);
      box.append(label);
      if (council.consentNeeded.includes('openrouter')) {
        const choice = el('div', 'council-choice');
        for (const [value, text] of [
          ['deny', 'Only OpenRouter endpoints that keep no prompts (some free models may then be unavailable)'],
          ['allow', 'Any endpoint, including ones that log prompts or train on them'],
        ]) {
          const opt = el('label', 'check');
          const radio = el('input');
          radio.type = 'radio';
          radio.name = `dc-${council.id}`;
          radio.value = value;
          radio.checked = dataCollection === value;
          radio.addEventListener('change', () => (dataCollection = value));
          opt.append(radio, ` ${text}`);
          choice.append(opt);
        }
        box.append(choice);
      }
      parts.push(box);
    }
    const bar = el('div', 'buttons');
    const run = el('button', 'yes', council.empty.length ? 'Run with a reduced panel' : 'Run the council');
    const dismiss = el('button', 'no', 'Cancel');
    run.type = dismiss.type = 'button';
    run.addEventListener('click', async () => {
      run.disabled = true;
      const out = await spark.councilRun(council.id, { consent, dataCollection, reduced: council.empty.length > 0 });
      run.disabled = false;
      if (out.error) note(out.error);
    });
    dismiss.addEventListener('click', () => bar.replaceWith(el('div', 'answered denied', 'Council not run')));
    bar.append(run, dismiss);
    parts.push(bar);
    return parts;
  }

  function results() {
    const r = council.run;
    const parts = [];
    if (r.status === 'running') {
      const stop = el('button', 'no', 'Stop the council');
      stop.type = 'button';
      stop.addEventListener('click', () => spark.councilCancel(council.id));
      parts.push(stop);
    }
    const reveal = r.status !== 'running';
    if (r.packets?.length) {
      const gallery = el('div', 'gallery');
      for (const p of r.packets) {
        const fold = el('details');
        fold.append(el('summary', '', `Proposal ${p.letter}${reveal && r.mapping[p.letter] ? ` · ${r.mapping[p.letter]}` : ''}`));
        const body = el('div', 'proposal');
        body.innerHTML = markdown(p.text);
        fold.append(body);
        gallery.append(fold);
      }
      parts.push(section('Proposals (judged blind, as letters)', gallery));
    }
    const a = r.aggregate;
    if (a) {
      const judges = r.verdicts.map((v) => v.seatId);
      const table = el('table', 'council-matrix');
      const head = el('tr');
      for (const h of ['Proposal', ...judges.map((j, i) => `J${i + 1} ${j}`), 'Mean', 'Borda', 'Firsts', 'Flags']) head.append(el('th', '', h));
      table.append(head);
      for (const letter of a.ranking) {
        const row = el('tr', letter === a.leader ? 'lead' : '');
        const flags = a.flags.filter((f) => f.proposal === letter);
        row.append(el('td', '', letter), ...a.totals[letter].map((t) => el('td', 'num', String(t))), el('td', 'num', String(a.mean[letter])), el('td', 'num', String(a.borda[letter])), el('td', 'num', String(a.firsts[letter])), el('td', flags.length ? 'fail' : '', flags.map((f) => `critical: ${f.issue}`).join('; ')));
        table.append(row);
      }
      const wrap = el('div', 'table-wrap');
      wrap.append(table);
      const verdictLine = line('council-case', `Case: ${a.case}. ${a.judged} of ${council.panel.judges.length} judges answered. Weighted totals out of 100, computed by Spark from each judge's 0–10 scores.`);
      const disagreements = el('ul');
      for (const d of a.disagreements) disagreements.append(el('li', 'warn', `${d.proposal} · ${d.criterion}: judges gave ${d.low} to ${d.high}`));
      parts.push(section('Voting matrix', verdictLine, wrap, ...(a.disagreements.length ? [el('h5', '', 'Disagreements'), disagreements] : [])));
      const combos = el('ul', 'combos');
      r.verdicts.forEach(({ seatId, verdict: v }, i) => {
        const takes = v.hybrid.take.map((t) => `${t.from}: ${t.contribution}`).join('; ') || 'nothing';
        const conflicts = v.hybrid.conflicts.map((c) => `${c.between} → ${c.resolution}`).join('; ');
        combos.append(el('li', '', `J${i + 1} (${seatId}) prefers ${v.preferred}${v.alternative ? `, then ${v.alternative}` : ''}. Hybrid ${v.hybrid.worthIt ? 'worth it' : 'not worth it'}: base ${v.hybrid.base}, take ${takes}${v.hybrid.drop.length ? `; drop ${v.hybrid.drop.join('; ')}` : ''}${conflicts ? `; conflicts ${conflicts}` : ''}. Confidence ${v.confidence}.`));
      });
      parts.push(section('Combination analysis', combos));
    }
    if (r.synthesis) {
      const body = el('div', 'synthesis');
      body.innerHTML = markdown(r.synthesis);
      const go = el('button', 'yes', 'Start as mission');
      go.type = 'button';
      go.addEventListener('click', async () => {
        const out = await spark.councilMission(council.id);
        if (out.error) return note(out.error);
        go.replaceWith(el('div', 'answered allowed', 'Mission created: approve its criteria below'));
      });
      parts.push(section(`Final synthesis by ${council.panel.synth.name}`, body, go));
    }
    if (reveal) parts.push(section('Execution summary', ...summary()));
    return parts;
  }

  function summary() {
    const r = council.run;
    const logs = Object.values(r.seats);
    const ok = logs.filter((l) => l.state === 'done');
    const bad = logs.filter((l) => !['done', 'queued', 'skipped'].includes(l.state));
    const byProvider = {};
    const providerOf = Object.fromEntries(seats().map(([role, s]) => [`${role}:${s.id}`, s.provider]));
    for (const [key, l] of Object.entries(r.seats)) if (typeof l.usd === 'number') byProvider[providerOf[key]] = (byProvider[providerOf[key]] ?? 0) + l.usd;
    if (typeof council.briefCost === 'number') byProvider.claude = (byProvider.claude ?? 0) + council.briefCost;
    const cost = el('ul');
    for (const [p, usd] of Object.entries(byProvider)) cost.append(el('li', '', p === 'claude' ? `Claude: ${money(usd)} at API rates, on your plan` : p === 'openrouter' ? `OpenRouter: ${money(usd)} in credits` : `${p}: ${money(usd)}`));
    if (seats().some(([, s]) => s.provider === 'gemini')) cost.append(el('li', '', 'Gemini: not reported (your key)'));
    const out = [line('', `${ok.length} calls answered, ${bad.length} did not.${council.reduced ? ' Reduced panel.' : ''}${r.reason ? ` ${r.status}: ${r.reason}.` : ''}`)];
    if (bad.length) {
      const ul = el('ul');
      for (const l of bad) ul.append(el('li', 'warn', `${l.seatId} (${l.role}): ${l.state}${l.error ? `, ${l.error}` : ''}`));
      out.push(ul);
    }
    out.push(el('h5', '', 'Cost as reported'), cost);
    return out;
  }

  function render() {
    const status = council.run ? `${council.run.status}${council.run.status === 'running' ? ` · ${council.run.stage}` : ''}` : 'waiting for you';
    const head = el('div', 'council-head');
    head.append(el('div', 'mission-kicker', `Council · ${council.mode === 'full' ? 'Full' : 'Light'} · ${status}`), el('div', 'mission-title', council.question));
    node.replaceChildren(head, briefNode(), section('Panel', panelTable()), ...(council.run ? results() : preflight()));
  }

  return {
    node,
    waiting(text) {
      node.replaceChildren(el('div', 'mission-kicker', 'Council'), line('mission-note', text));
    },
    failed(text) {
      node.replaceChildren(el('div', 'mission-kicker', 'Council'), line('mission-warn', `Not started: ${text}`));
    },
    update(next) {
      council = next;
      render();
    },
  };
}
