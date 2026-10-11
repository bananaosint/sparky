/* global marked, DOMPurify, spark */
import { parseCommand, withModes, MODELS, EFFORTS } from './lib/commands.js';
import { parseMarathon, statusLine, clock, tierOf } from './lib/marathon.js';
import { costLine } from './lib/account.js';
import { elapsed } from './lib/elapsed.js';
import { doubleTab } from './lib/keys.js';
import { voxelize, project, closeEyes } from './lib/voxel.js';
import { MOVES, HATS, frameAt, emits } from './lib/sparky.js';
import { createMissionsView } from './lib/missions-view.js';
import { councilCard } from './lib/council-view.js';

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const VERBS = ['Sparking', 'Arcing', 'Crackling', 'Igniting', 'Fusing', 'Flaring', 'Charging'];
const TOOLS = {
  Bash: ['›_', 'cyan'],
  PowerShell: ['›_', 'cyan'],
  Edit: ['✎', 'violet'],
  MultiEdit: ['✎', 'violet'],
  Write: ['＋', 'green'],
  NotebookEdit: ['✎', 'violet'],
  Read: ['◱', 'blue'],
  Grep: ['⌕', 'amber'],
  Glob: ['⌕', 'amber'],
  WebFetch: ['◍', 'blue'],
  WebSearch: ['◍', 'blue'],
  TodoWrite: ['☑', 'green'],
  Agent: ['◆', 'violet'],
  Task: ['◆', 'violet'],
};

let look = { sprite: [], glow: [56, 232, 255] };
let cwd = '';
let settings = {};
let busy = false;
let attachments = [];
// The prompt as typed while the box holds Gemini's version of it.
let cookedFrom = null;
let streaming = null;
const tools = new Map();
let thinking = null;
// Spark modes (/antislop and friends) that ride along with each message.
let modes = [];
// Who pays for Claude's turns, from the sign-in Claude Code reports.
let who = { label: 'Claude', billed: false, note: 'priced at API rates' };
let model = '';
let turnTools = 0;
// The running marathon as main.js last reported it, for the header.
let marathonState = null;
// The mission this window runs, as main last reported it, for the header.
let activeMission = null;
// Skills Gemini picked for the prompt in the box, and which model picked them.
let picked = { skills: [], model: '' };
// The recent chat, for Gemini's quick answers.
let history = [];
const remember = (entry) => (history = [...history, entry].slice(-12));

// ---------- Sparky ----------

// Each canvas showing Sparky is an actor: it loops a base move (idle, work, sleep…) and
// plays one-shot moves (cheer, oops…) over it. One animation frame paints them all.
const still = matchMedia('(prefers-reduced-motion: reduce)');
const actors = new Set();
// The hat for the model answering, and the point on screen his eyes follow.
let hat;
let gaze = null;
const GLYPHS = { z: 'z', heart: '♥', bang: '!', star: '✦' };

function actor(canvas, base = 'idle', opts = {}) {
  const a = { canvas, base, name: base, start: performance.now(), last: 0, opts, once: {} };
  actors.add(a);
  return a;
}

function play(a, name, once = {}) {
  Object.assign(a, { name, start: performance.now(), last: 0, once });
}

// A new base takes over at once, unless a one-shot move is still playing.
function setBase(a, name) {
  a.base = name;
  if (MOVES[a.name].loop && a.name !== name) play(a, name);
}

function pupils(canvas) {
  if (!gaze) return undefined;
  const r = canvas.getBoundingClientRect();
  return { x: gaze.x < r.left + r.width / 2 ? 0 : 1, y: gaze.y < r.top + r.height * 0.45 ? 0 : 1 };
}

function paint(canvas, pixels) {
  const g = canvas.getContext('2d');
  const image = g.createImageData(16, 16);
  pixels.forEach((row, y) => row.forEach((c, x) => c && image.data.set([...c, 255], (y * 16 + x) * 4)));
  g.putImageData(image, 0, 0);
}

function spawn(canvas, p) {
  const node = el('span', `particle ${p.kind}`, GLYPHS[p.kind]);
  node.style.cssText = `--px:${canvas.clientWidth / 16}px;--x:${p.x};--y:${p.y};--dx:${p.dx};--dy:${p.dy};--life:${p.life}ms`;
  node.addEventListener('animationend', () => node.remove());
  canvas.parentElement.append(node);
}

function tick(now) {
  for (const a of actors) {
    if (!a.canvas.isConnected) actors.delete(a);
    if (!a.canvas.offsetParent || !look.sprite.length) continue;
    const t = now - a.start;
    const seconds = thinking ? (now - thinking.started) / 1000 : 0;
    const o = { sprite: look.sprite, glow: look.glow, hat, look: pupils(a.canvas), seconds, ...a.opts, ...a.once };
    const f = frameAt(a.name, t, o);
    paint(a.canvas, f.pixels);
    if (!still.matches) {
      const { x, y, sx, sy } = f.move;
      a.canvas.style.transform = `translate(${x * 6.25}%, ${y * 6.25}%) scale(${sx}, ${sy})`;
      for (const p of emits(a.name, a.last, t, o)) spawn(a.canvas, p);
    }
    a.last = t;
    if (f.done) play(a, a.base);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const mini = actor($('mini'));
const hero = actor($('hero'));
const both = (fn) => [mini, hero].forEach(fn);

// Left alone for a while, he dozes off; any movement wakes him with a start.
const SLEEP_AFTER = 90_000;
let lastActive = performance.now();
function wake() {
  lastActive = performance.now();
  if (mini.base !== 'sleep') return;
  both((a) => {
    setBase(a, 'idle');
    play(a, 'alert');
  });
}
setInterval(() => {
  if (!busy && mini.base === 'idle' && performance.now() - lastActive > SLEEP_AFTER) both((a) => setBase(a, 'sleep'));
}, 5000);
addEventListener('pointermove', (e) => {
  gaze = { x: e.clientX, y: e.clientY };
  wake();
});
// Typing, he watches the box.
addEventListener('keydown', () => {
  const r = $('composer').getBoundingClientRect();
  gaze = { x: r.left + r.width / 2, y: r.bottom };
  wake();
});

// Poke him and he giggles; five quick pokes and he overloads.
let pokes = [];
for (const a of [mini, hero])
  a.canvas.parentElement.addEventListener('click', () => {
    const now = performance.now();
    pokes = [...pokes.filter((t) => now - t < 2000), now];
    if (pokes.length < 5) return play(a, 'poke');
    pokes = [];
    play(a, 'charge', { level: 5 });
  });

// ---------- Sparky in 3D, on the welcome screen ----------

// He turns toward the pointer, bobs, blinks now and then, spins when dragged and flips when clicked.
// Reduced motion: one still frame, slightly turned.
const stage = $('hero3d');
const pen = stage.getContext('2d');
let shapes = null;
let spriteShaped = null;
const pose = { yaw: -0.45, pitch: 0.15, spin: 0, offset: 0 };
let dragFrom = null;
let flipStart = -Infinity;
let blinkAt = performance.now() + 2500;

function shapeSparky() {
  if (spriteShaped === look.sprite || !look.sprite.length) return;
  spriteShaped = look.sprite;
  shapes = { open: voxelize(look.sprite).faces, shut: voxelize(closeEyes(look.sprite)).faces };
  $('hero-wrap').classList.add('three');
}

function drawSparky3d(now) {
  shapeSparky();
  if (!shapes) return;
  const box = stage.getBoundingClientRect();
  const toward = (at, mid, span) => (gaze && !still.matches ? Math.max(-1, Math.min(1, (at - mid) / span)) : 0);
  const lookX = toward(gaze?.x, box.left + box.width / 2, innerWidth / 2);
  const lookY = toward(gaze?.y, box.top + box.height / 2, innerHeight / 2);
  // Ease toward where the pointer is; a drag or a fling adds its own turn on top. With motion
  // reduced he settles at once and doesn't coast.
  const ease = still.matches ? 1 : 0.08;
  pose.yaw += (lookX * 0.7 - 0.2 - pose.yaw) * ease;
  pose.pitch += (0.15 + lookY * 0.3 - pose.pitch) * ease;
  if (still.matches) pose.spin = 0;
  if (!dragFrom) {
    pose.offset += pose.spin;
    pose.spin *= 0.94;
  }
  const flip = Math.min(1, (now - flipStart) / 700);
  const flipTurn = flip < 1 ? (1 - (1 - flip) ** 3) * Math.PI * 2 : 0;
  if (now > blinkAt + 140) blinkAt = now + 2500 + Math.random() * 3500;
  const eyes = now >= blinkAt && !still.matches ? shapes.shut : shapes.open;
  const bob = still.matches ? 0 : Math.sin(now / 650) * 6;
  const polys = project(eyes, { yaw: pose.yaw + pose.offset, pitch: pose.pitch + flipTurn, scale: 14, cx: stage.width / 2, cy: stage.height / 2 + bob });
  pen.clearRect(0, 0, stage.width, stage.height);
  for (const p of polys) {
    pen.beginPath();
    p.points.forEach(([x, y], i) => (i ? pen.lineTo(x, y) : pen.moveTo(x, y)));
    pen.closePath();
    pen.fillStyle = pen.strokeStyle = p.fill;
    pen.fill();
    // A hairline in the face's own colour closes the seams canvas antialiasing leaves between quads.
    pen.stroke();
  }
}

// With motion reduced, a frame a second is enough to catch a new theme or the first sprite.
(function loop(now) {
  if (!$('welcome').hidden) drawSparky3d(now);
  if (still.matches) setTimeout(() => requestAnimationFrame(loop), 1000);
  else requestAnimationFrame(loop);
})(performance.now());

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragFrom = { x: e.clientX, offset: pose.offset, moved: 0, last: e.clientX };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragFrom) return;
  pose.spin = (e.clientX - dragFrom.last) * 0.012;
  dragFrom.last = e.clientX;
  dragFrom.moved = Math.max(dragFrom.moved, Math.abs(e.clientX - dragFrom.x));
  pose.offset = dragFrom.offset + (e.clientX - dragFrom.x) * 0.012;
  if (still.matches) drawSparky3d(performance.now());
});
stage.addEventListener('pointerup', () => {
  // A press that barely moved is a poke: he flips (the flat Sparky's poke handler adds the sparks).
  if (dragFrom && dragFrom.moved < 4 && !still.matches) flipStart = performance.now();
  if (dragFrom && dragFrom.moved >= 4) stage.addEventListener('click', (e) => e.stopPropagation(), { capture: true, once: true });
  dragFrom = null;
});
// A drag the system takes away (the window loses the pointer) just ends, with no poke.
stage.addEventListener('pointercancel', () => (dragFrom = null));

// ---------- messages ----------

const list = $('messages');
const markdown = (text) => DOMPurify.sanitize(marked.parse(text ?? ''));
const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
function append(node) {
  const follow = atBottom();
  $('welcome').hidden = true;
  list.append(node);
  if (thinking) list.append(thinking.el);
  if (follow) list.scrollTop = list.scrollHeight;
}

function relative(path = '') {
  const p = String(path).replace(/\\/g, '/');
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  return p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : p;
}

function summary(name, input) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description || input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return relative(input.file_path);
    case 'NotebookEdit':
      return relative(input.notebook_path);
    case 'Grep':
      return `"${input.pattern}"${input.path ? ` in ${relative(input.path)}` : ''}`;
    case 'Glob':
      return input.pattern;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'TodoWrite':
      return `${(input.todos ?? []).length} tasks`;
    case 'Agent':
    case 'Task':
      return input.description;
    default:
      return Object.values(input).find((v) => typeof v === 'string') ?? '';
  }
}

function diff(oldText = '', newText = '') {
  const pre = el('pre', 'diff');
  for (const line of oldText.split('\n')) pre.append(el('span', 'del', `- ${line}\n`));
  for (const line of newText.split('\n')) pre.append(el('span', 'add', `+ ${line}\n`));
  return pre;
}

function details(name, input) {
  const box = el('div', 'tool-detail');
  if (name === 'Bash' || name === 'PowerShell') box.append(el('pre', 'cmd', `$ ${input.command}`));
  else if (name === 'Edit') box.append(diff(input.old_string, input.new_string));
  else if (name === 'MultiEdit') for (const e of input.edits ?? []) box.append(diff(e.old_string, e.new_string));
  else if (name === 'Write') box.append(el('pre', 'code', (input.content ?? '').split('\n').slice(0, 60).join('\n')));
  else if (name === 'TodoWrite') {
    const ul = el('ul', 'todos');
    for (const t of input.todos ?? []) ul.append(el('li', t.status, `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`));
    box.append(ul);
  } else box.append(el('pre', 'code', JSON.stringify(input, null, 2)));
  return box;
}

function toolCard(id, name, input) {
  const [icon, tone] = TOOLS[name] ?? ['•', 'blue'];
  const card = el('div', `tool ${tone} running`);
  const head = el('button', 'tool-head');
  head.type = 'button';
  head.append(el('span', 'icon', icon), el('span', 'name', name), el('span', 'sum', summary(name, input)), el('span', 'state'));
  const body = el('div', 'tool-body');
  body.hidden = true;
  body.append(details(name, input));
  head.addEventListener('click', () => (body.hidden = !body.hidden));
  card.append(head, body);
  tools.set(id, { card, body });
  append(card);
}

function setThinking(on) {
  if (!on) {
    clearInterval(thinking?.timer);
    thinking?.el.remove();
    thinking = null;
    return;
  }
  if (thinking) return;
  const node = el('div', 'thinking');
  const pic = el('span', 'sparky');
  const canvas = el('canvas');
  canvas.width = canvas.height = 16;
  pic.append(canvas);
  const label = el('span', 'label');
  node.append(pic, label);
  const started = performance.now();
  let verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  const tick = () => {
    const ms = performance.now() - started;
    const s = Math.round(ms / 1000);
    if (s && s % 6 === 0) verb = VERBS[(VERBS.indexOf(verb) + 1) % VERBS.length];
    label.textContent = `${verb}… ${elapsed(ms)}`;
  };
  tick();
  thinking = { el: node, timer: setInterval(tick, 1000), started };
  actor(canvas, 'work');
  append(document.createDocumentFragment());
}

function setBusy(on) {
  busy = on;
  $('send').hidden = on;
  $('stop').hidden = !on;
  setThinking(on);
  both((a) => setBase(a, on ? 'work' : 'idle'));
  renderEngine();
}

function addUser(text, images) {
  const bubble = el('div', 'msg user');
  if (images.length) {
    const row = el('div', 'thumbs');
    for (const a of images) {
      const img = el('img');
      img.src = a.url;
      img.alt = 'pasted image';
      row.append(img);
    }
    bubble.append(row);
  }
  if (text) bubble.append(el('div', 'text', text));
  append(bubble);
}

function assistant() {
  if (!streaming) {
    streaming = { el: el('div', 'msg assistant'), text: '' };
    append(streaming.el);
  }
  return streaming;
}

// The header: the folder, then who answers and how hard it thinks, then Gemini's state.
function renderStatus() {
  const where = cwd.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
  const answering =
    settings.model === 'gemini'
      ? 'Gemini quick answers'
      : settings.model === 'auto'
        ? `Auto · ${settings.autoModels.length} models`
        : settings.model === 'ultracode'
          ? `UltraCode · ${settings.ultraModel}`
          : model || 'Claude';
  const effort =
    settings.model === 'ultracode' ? ' · max effort' : !['gemini', 'auto'].includes(settings.model) && settings.effort !== 'default' ? ` · ${settings.effort} effort` : '';
  const marathon = marathonState ? ` · ${statusLine(marathonState, Date.now())}` : '';
  const mission = activeMission ? ` · mission ${activeMission.status} ${elapsed(Date.now() - (activeMission.approvedAt ?? activeMission.createdAt))}` : '';
  $('status').textContent = `${where} · ${answering}${effort}${marathon}${mission} · ${settings.hasKey ? 'gemini on' : 'gemini off'}`;
  $('status').title = marathonState ? $('status').textContent : cwd;
  hat = settings.model in HATS ? settings.model : undefined;
  renderEngine();
}

// Above the prompt: active modes (click to turn off) and the skills Gemini picked.
function renderChips() {
  const row = $('chips');
  const items = modes.map((m) => {
    const chip = el('button', 'mode-chip', `${m} ✕`);
    chip.type = 'button';
    chip.title = `Turn ${m} off`;
    chip.addEventListener('click', () => {
      modes = modes.filter((x) => x !== m);
      renderChips();
    });
    return chip;
  });
  if (picked.skills.length) {
    items.push(el('span', 'chips-label', `skills · ${picked.model}`));
    for (const s of picked.skills) items.push(el('span', 'skill-chip', s));
  }
  row.replaceChildren(...items);
}

spark.on('payer', (p) => (who = p));

let renderQueued = false;
spark.on('event', (event) => {
  if (event.kind === 'init') {
    model = event.model ?? '';
    renderStatus();
  }
  if (event.kind === 'delta') {
    const s = assistant();
    s.text += event.text;
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        if (streaming) streaming.el.innerHTML = markdown(streaming.text);
        if (atBottom()) list.scrollTop = list.scrollHeight;
      });
    }
  }
  if (event.kind === 'text') {
    assistant().el.innerHTML = markdown(event.text);
    streaming = null;
    remember({ role: 'assistant', text: event.text });
  }
  if (event.kind === 'tool') {
    streaming = null;
    turnTools++;
    toolCard(event.id, event.name, event.input);
  }
  if (event.kind === 'tool-result') {
    const t = tools.get(event.id);
    if (!t) return;
    t.card.classList.remove('running');
    t.card.classList.add(event.isError ? 'failed' : 'done');
    // Only a working Sparky flinches, so a cheer or an alert plays out.
    if (event.isError) for (const a of actors) if (a.name === 'work') play(a, 'flinch');
    if (event.output) t.body.append(el('pre', event.isError ? 'output error' : 'output', event.output.slice(0, 20000)));
  }
  if (event.kind === 'result') {
    streaming = null;
    setBusy(false);
    both((a) => play(a, event.ok ? 'cheer' : 'oops', { tools: turnTools }));
    const line = el(
      'div',
      event.ok ? 'result' : 'result failed',
      event.ok ? `✦ done in ${elapsed(event.durationMs)} ·${costLine({ ...event, model, tools: turnTools }, who)}` : `✗ ${event.text || 'the turn ended with an error'}`,
    );
    line.title = `The price Claude Code reports for this turn at API rates: the model, the tokens it read and wrote, and its tool calls. ${who.label}: ${who.note}. Gemini rewrites and skill picks use your Gemini key's Google project.`;
    append(line);
  }
});

spark.on('marathon', (m) => {
  marathonState = m.kind === 'end' ? null : m.state;
  const say = (text, cls = 'result') => append(el('div', cls, text));
  if (m.kind === 'start') {
    say(`✦ marathon started · ${statusLine(m.state, Date.now())}. Spark keeps Claude working in review passes until a budget runs out.`);
    if (!settings.autoEdits) say('✦ auto-accept edits is off, so each file edit waits for your click while the clock runs. Turn it on in ⚙ settings for an unattended run.');
  }
  if (m.kind === 'pass') {
    turnTools = 0;
    setBusy(true);
    say(`✦ marathon pass ${m.state.pass} · ${m.lens} · ${statusLine(m.state, Date.now())}`);
  }
  if (m.kind === 'wait') say(`✦ marathon: the last ${m.state.idle} passes found nothing, so the next one waits ${clock(m.ms)}`);
  if (m.kind === 'switched') {
    model = m.tier;
    say(`✦ marathon moved Claude to ${m.tier}: the last passes found nothing to change`);
  }
  if (m.kind === 'switch-failed') say(`✗ marathon could not move to ${m.tier} (${m.error}); carrying on with the current model`, 'result failed');
  // The model was put back when it ended; the header follows.
  if (m.kind === 'end' && tierOf(model) === model) model = tierOf(settings.model) ?? '';
  if (m.kind === 'end') say(`✦ marathon over: ${m.reason} · ${m.summary}`, m.reason.startsWith('a turn failed') ? 'result failed' : 'result');
  renderStatus();
});
// The time left ticks down between events.
setInterval(() => marathonState && renderStatus(), 15_000);

spark.on('ultra', () => {
  turnTools = 0;
  setBusy(true);
  append(el('div', 'result', '✦ UltraCode review pass: checking the change against your request'));
});

// ---------- missions ----------

const missionsView = createMissionsView({
  spark,
  el,
  markdown,
  onStart: (objective) => startMission(objective),
  onToggle(open) {
    $('missions').hidden = !open;
    list.hidden = open;
    composer.hidden = open;
    $('missions-open').classList.toggle('on', open);
    $('missions-open').setAttribute('aria-pressed', String(open));
    if (!open) input.focus();
  },
});
$('missions-open').addEventListener('click', () => (missionsView.isOpen() ? missionsView.close() : missionsView.open(activeMission?.id)));

async function startMission(objective) {
  if (busy) return note('Sparky is still working: wait, or press ■ to stop.');
  if (marathonState) return note('a marathon is running: /marathon stop ends it first');
  const out = await spark.mission({ action: 'start', objective });
  if (out.error) return note(out.error);
  missionsView.close();
  const card = el('div', 'mission-card drafting');
  card.append(
    el('div', 'mission-kicker', 'Mission'),
    el('div', 'mission-title', out.mission.objective),
    el('p', 'mission-note', 'Claude is reading the project to draft acceptance criteria. Nothing changes while it drafts.'),
  );
  append(card);
  turnTools = 0;
  setBusy(true);
}

function missionCommand(args) {
  input.value = '';
  autosize();
  if (!args) return missionsView.open(activeMission?.id);
  if (args === 'cancel') {
    if (!activeMission) return note('no mission running');
    return spark.mission({ action: 'cancel', id: activeMission.id }).then((out) => out.error && note(out.error));
  }
  startMission(args);
}

function criteriaCard(mission) {
  const card = el('div', 'mission-card');
  card.append(el('div', 'mission-kicker', 'Mission · approve the criteria'), el('div', 'mission-title', mission.title));
  if (!mission.criteria.length) card.append(el('p', 'mission-warn', mission.reason));
  const rows = el('ol', 'criteria');
  const addRow = (c = { text: '', how: '' }) => {
    const li = el('li', 'criterion');
    const text = el('input');
    text.value = c.text;
    text.placeholder = 'One outcome someone can check';
    text.setAttribute('aria-label', 'Criterion');
    const how = el('input', 'how');
    how.value = c.how;
    how.placeholder = 'test, command, or manual';
    how.setAttribute('aria-label', 'How it is checked');
    const x = el('button', 'remove', '×');
    x.type = 'button';
    x.title = 'Remove this criterion';
    x.setAttribute('aria-label', 'Remove this criterion');
    x.addEventListener('click', () => li.remove());
    li.append(text, how, x);
    rows.append(li);
    return text;
  };
  (mission.criteria.length ? mission.criteria : [undefined]).forEach((c) => addRow(c));
  const add = el('button', 'ghost', '+ criterion');
  add.type = 'button';
  add.addEventListener('click', () => addRow().focus());
  const bar = el('div', 'buttons');
  const go = el('button', 'yes', 'Approve and start');
  const cancel = el('button', 'no', 'Cancel mission');
  go.type = cancel.type = 'button';
  const settle = (cls, text) => {
    bar.replaceWith(el('div', `answered ${cls}`, text));
    add.remove();
    for (const n of rows.querySelectorAll('input, button')) n.disabled = true;
  };
  go.addEventListener('click', async () => {
    const criteria = [...rows.children].map((li) => ({ text: li.children[0].value, how: li.children[1].value }));
    const out = await spark.mission({ action: 'approve', id: mission.id, criteria });
    if (out.error) return note(out.error);
    settle('allowed', `Approved ${out.mission.criteria.length} criteria`);
    turnTools = 0;
    setBusy(true);
  });
  cancel.addEventListener('click', async () => {
    const out = await spark.mission({ action: 'cancel', id: mission.id });
    if (out.error) return note(out.error);
    settle('denied', 'Mission cancelled');
  });
  bar.append(go, cancel);
  card.append(rows, add, bar);
  return card;
}

spark.on('mission', (m) => {
  if (m.kind === 'state') {
    if (m.active) activeMission = m.mission;
    else if (activeMission?.id === m.mission.id) activeMission = null;
    // A mission that just went to running has a turn in flight (Resume, an answer): ■ must show.
    if (m.active && m.mission.status === 'running' && !busy) {
      turnTools = 0;
      setBusy(true);
    }
    renderStatus();
    missionsView.update(m.mission);
  }
  if (m.kind === 'row') missionsView.addRow(m.id, m.row);
  if (m.kind === 'review') {
    setBusy(false);
    append(criteriaCard(m.mission));
  }
  if (m.kind === 'verifying') {
    append(el('div', 'result', `◆ mission: Spark is running its checks${m.again ? ' again' : ''}…`));
    missionsView.verifying(m.id);
  }
  if (m.kind === 'report') {
    const first = m.sections[0]?.lines[0];
    const status = first?.text || m.mission.status;
    const line = el('div', m.mission.status === 'finished' && first?.tone !== 'fail' ? 'result' : 'result failed', `◆ mission ${status} · `);
    const open = el('button', 'link', 'open the report');
    open.type = 'button';
    open.addEventListener('click', () => missionsView.open(m.id));
    line.append(open);
    append(line);
    missionsView.showReport(m.id);
  }
  if (m.kind === 'error') append(el('div', 'result failed', `✗ mission: ${m.error}`));
});
setInterval(() => {
  if (activeMission) renderStatus();
  missionsView.tick();
}, 1000);

// ---------- councils ----------

// Councils run beside the chat: the composer stays free, and each council's card updates itself.
const councilCards = new Map();

async function councilCommand(mode, question) {
  input.value = '';
  autosize();
  if (!question) return note('a council needs a question: /council [full] <question>');
  const card = councilCard({ el, markdown, spark, note, cap: () => settings.councilBudgetUsd ?? 1, payer: () => who });
  card.waiting(`${mode === 'full' ? 'Full' : 'Light'} council: Claude is reading the project to write the brief. Nothing leaves this machine until you approve the pre-flight.`, () => spark.councilBriefCancel());
  append(card.node);
  const out = await spark.councilPreflight(question, mode);
  if (out.error) return card.failed(out.error);
  councilCards.set(out.id, card);
  card.update(out);
}

// The councils run in this folder, newest first; one opens as its card, from its saved record.
async function councilList() {
  input.value = '';
  autosize();
  const all = await spark.councils();
  if (!all.length) return note('no councils in this folder yet: /council [full] <question>');
  const box = el('div', 'result');
  box.append(el('div', 'mission-kicker', 'Councils in this folder'));
  const ul = el('ul', 'council-list');
  for (const c of all.slice(0, 10)) {
    const open = el('button', 'link', c.question);
    open.type = 'button';
    open.addEventListener('click', async () => {
      const council = await spark.councilView(c.id);
      if (!council) return note('that council file could not be read');
      const card = councilCard({ el, markdown, spark, note, cap: () => settings.councilBudgetUsd ?? 1, payer: () => who });
      card.update(council);
      councilCards.set(c.id, card);
      append(card.node);
    });
    const li = el('li');
    li.append(open, el('span', 'meta', ` · ${c.mode} · ${c.run?.status ?? 'not run'} · ${new Date(c.createdAt).toLocaleString()}`));
    ul.append(li);
  }
  box.append(ul);
  append(box);
}

spark.on('council', (m) => councilCards.get(m.id)?.update(m.council));

spark.on('permission', ({ id, tool, input, note }) => {
  const card = el('div', 'permission');
  card.append(el('div', 'ask', `Claude wants to use ${tool}`), el('div', 'what', summary(tool, input)), details(tool, input));
  if (note) card.append(el('div', 'gate-note', `✦ spark gate: ${note}`));
  const row = el('div', 'buttons');
  const answer = (allow, always) => {
    spark.answerPermission({ id, allow, always });
    row.replaceWith(el('div', allow ? 'answered allowed' : 'answered denied', allow ? (always ? `Allowed (and ${tool} from now on)` : 'Allowed') : 'Denied'));
  };
  const yes = el('button', 'yes', 'Allow');
  const always = el('button', 'always', `Always allow ${tool}`);
  const no = el('button', 'no', 'Deny');
  yes.type = always.type = no.type = 'button';
  yes.addEventListener('click', () => answer(true, false));
  always.addEventListener('click', () => answer(true, true));
  no.addEventListener('click', () => answer(false, false));
  // The gate asks about its commands every time, so "always" isn't offered for them.
  row.append(yes, ...(note ? [] : [always]), no);
  card.append(row);
  both((a) => play(a, 'alert'));
  append(card);
  yes.focus();
});

spark.on('exit', ({ code, error }) => {
  setBusy(false);
  both((a) => play(a, 'oops'));
  streaming = null;
  const card = el('div', 'result failed');
  const signIn = /log ?in|auth|credential/i.test(error ?? '') ? ' If you have not signed in yet, run claude once in a terminal.' : '';
  card.textContent = `Claude Code stopped${code === undefined ? '' : ` (code ${code})`}. ${error ?? ''}${signIn}`;
  append(card);
});

spark.on('session', (s) => {
  look = s;
  cwd = s.cwd;
  settings = s.settings;
  document.body.className = s.theme;
  renderStatus();
  $('folder').textContent = s.folder;
  $('where').textContent = ` in ${s.folder}`;
  if (!s.keepBusy) setBusy(false);
  if (s.fresh) {
    list.replaceChildren($('welcome'));
    $('welcome').hidden = false;
    tools.clear();
    history = [];
    both((a) => play(a, 'assemble'));
  }
});

// ---------- composer ----------

const input = $('input');
const composer = $('composer');
const note = (text) => ($('note').textContent = text);
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
};

function renderAttachments() {
  const row = $('attachments');
  row.replaceChildren(
    ...attachments.map((a, i) => {
      const chip = el('div', 'attachment');
      const img = el('img');
      img.src = a.url;
      img.alt = 'pasted image';
      const x = el('button', 'remove', '×');
      x.type = 'button';
      x.title = 'Remove image';
      x.addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachments();
      });
      chip.append(img, x);
      return chip;
    }),
  );
}

async function addImage(file) {
  const url = await new Promise((done) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result);
    reader.readAsDataURL(file);
  });
  const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(url) ?? [];
  if (!data) return;
  attachments.push({ url, mediaType, data });
  renderAttachments();
}

function clearBox() {
  input.value = '';
  autosize();
  attachments = [];
  renderAttachments();
  cookedFrom = null;
  picked = { skills: [], model: '' };
  renderChips();
  composer.classList.remove('cooked');
  note('');
}

function sendNow(text) {
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  addUser(text, attachments);
  remember({ role: 'user', text, images });
  spark.sendMessage({ text: withModes(text, modes), images });
  clearBox();
  turnTools = 0;
  setBusy(true);
}

// Gemini answers in the window: quick, no tools, no files.
async function askGemini(text) {
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  addUser(text, attachments);
  remember({ role: 'user', text, images });
  clearBox();
  setBusy(true);
  const answer = await spark.quick(history);
  setBusy(false);
  if (answer.error) return append(el('div', 'result failed', `✗ Gemini: ${answer.error}`));
  const bubble = el('div', 'msg assistant gemini');
  bubble.innerHTML = markdown(answer.text);
  bubble.prepend(el('div', 'badge', `⚡ ${answer.model}`));
  append(bubble);
  remember({ role: 'assistant', text: answer.text });
  append(el('div', 'result', `✦ quick answer by ${answer.model} · on your Gemini key's Google project (free tier or its billing), not your Claude plan`));
}

// Bumped by each Auto question and by ■, so only the latest question's answer lands.
let autoRun = 0;
let autoActive = false;

// Auto answers in the window: several models at once, one merged answer, and each model's own
// answer folded away underneath.
async function askAuto(text) {
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  addUser(text, attachments);
  remember({ role: 'user', text, images });
  clearBox();
  setBusy(true);
  const started = performance.now();
  const run = ++autoRun;
  autoActive = true;
  const out = await spark.auto(history);
  // ■ was pressed, or another Auto started since: this answer is no longer wanted.
  if (run !== autoRun) return;
  autoActive = false;
  setBusy(false);
  if (out.error) return append(el('div', 'result failed', `✗ Auto: ${out.error}`));
  const bubble = el('div', 'msg assistant auto');
  bubble.innerHTML = markdown(out.text);
  const by = out.judge ? `${out.judge} merged ${out.picked.join(', ') || 'the answers'}` : `${out.picked[0]} answered alone`;
  bubble.prepend(el('div', 'badge', `✦ Auto · ${by}`));
  const each = el('div', 'auto-answers');
  for (const a of out.answers) {
    const fold = el('details');
    fold.append(el('summary', a.error ? 'failed' : '', a.error ? `${a.model} · no answer (${a.error})` : `${a.model}'s own answer`));
    if (a.text) {
      const body = el('div');
      body.innerHTML = markdown(a.text);
      fold.append(body);
    }
    each.append(fold);
  }
  bubble.append(each);
  append(bubble);
  remember({ role: 'assistant', text: out.text });
  const answered = out.answers.filter((a) => a.text).length;
  const merge = out.judgeError ? ` · the merge failed (${out.judgeError}), so this is ${out.picked[0]}'s answer` : '';
  append(el('div', 'result', `✦ Auto answered in ${elapsed(performance.now() - started)} · ${answered} of ${out.answers.length} models · Claude models count toward your plan, Gemini runs on your key${merge}`));
}

async function setSetting(changes) {
  const before = settings;
  settings = await spark.setSettings(changes);
  renderStatus();
  if (before.model !== settings.model || before.effort !== settings.effort) powerUp();
}

// /marathon <task> [--time 1.5h] [--tokens 2m] starts one, bare shows what is left, stop ends it.
function marathonCommand(args) {
  const parsed = parseMarathon(args);
  if (parsed.error) return note(parsed.error);
  if (parsed.status || parsed.stop) {
    input.value = '';
    autosize();
    if (parsed.stop) return spark.marathon({ action: 'stop' });
    return note(marathonState ? statusLine(marathonState, Date.now()) : 'no marathon running · /marathon <task> [--time 1.5h] [--tokens 2m]');
  }
  if (settings.model === 'gemini' || settings.model === 'auto') return note('a marathon needs Claude Code: pick a Claude model or UltraCode first');
  if (activeMission) return note('a mission is running: finish or cancel it first');
  if (marathonState) return note('a marathon is already running · /marathon stop ends it');
  spark.marathon({ action: 'start', task: parsed.task, limits: parsed.limits });
  sendNow(parsed.task);
}

// Spark's own slash commands act here; any other /command goes to Claude Code as typed.
function runCommand(text) {
  const command = parseCommand(text);
  if (!command || command.kind === 'passthrough') return false;
  if (command.kind === 'marathon') {
    marathonCommand(command.args);
    return true;
  }
  if (command.kind === 'mission') {
    missionCommand(command.args);
    return true;
  }
  if (command.kind === 'council') {
    councilCommand(command.mode, command.question);
    return true;
  }
  if (command.kind === 'council-list') {
    councilList();
    return true;
  }
  if (command.kind === 'mode') {
    modes = modes.includes(command.mode) ? modes.filter((m) => m !== command.mode) : [...modes, command.mode];
    note(`${command.mode} ${modes.includes(command.mode) ? 'on' : 'off'}`);
  }
  if (command.kind === 'model') setSetting({ model: command.model });
  if (command.kind === 'effort') setSetting({ effort: command.effort });
  input.value = '';
  autosize();
  renderChips();
  return true;
}

// Bumped by every send, so a rewrite that lands after Tab Tab sent the typed words is dropped.
let cookRun = 0;

// Enter cooks the prompt with Gemini first (rewrite and skill picks, as set); Enter again
// sends what the box holds. A leading \ sends as typed.
async function submit() {
  if (busy) return note('Sparky is still working: wait, or press ■ to stop.');
  let text = input.value.trim();
  if (!text && !attachments.length) return;
  if (text.startsWith('/')) {
    if (runCommand(text)) return;
    return settings.model === 'gemini' ? note('slash commands go to Claude: pick a Claude model first') : sendNow(text);
  }
  if (text.startsWith('\\')) text = text.slice(1).trimStart();
  else if (settings.model !== 'gemini') {
    const cook = (settings.cook || settings.pickSkills) && settings.hasKey && cookedFrom === null && text.split(/\s+/).length >= 4;
    if (cook) {
      composer.classList.add('cooking');
      both((a) => setBase(a, 'cook'));
      note(settings.cook ? 'cooking with Gemini… · Tab Tab sends yours as typed' : 'picking skills with Gemini…');
      const run = ++cookRun;
      const result = await spark.cook(text);
      if (run !== cookRun) return;
      composer.classList.remove('cooking');
      both((a) => {
        setBase(a, 'idle');
        play(a, result.error ? 'oops' : 'poke');
      });
      cookedFrom = text;
      if (result.error) return note(`not cooked (${result.error}) · Enter sends yours as typed`);
      input.value = result.text;
      autosize();
      picked = { skills: result.skills ?? [], model: result.skillsModel ?? '' };
      renderChips();
      composer.classList.add('cooked');
      const by = [result.model && `rewritten by ${result.model}`, result.rewriteError && `not rewritten (${result.rewriteError})`, !picked.skills.length && result.skillsModel && 'no skills needed'].filter(Boolean);
      return note(`${by.join(' · ')}${by.length ? ' · ' : ''}edit freely · Enter sends · Tab Tab sends yours as typed · Esc restores yours`);
    }
  }
  return settings.model === 'gemini' ? askGemini(text) : settings.model === 'auto' ? askAuto(text) : sendNow(text);
}

// Tab Tab: what was typed goes out as typed, never rewritten, but with the skills Gemini
// picked (or picks now, when skill picks are on and none were picked yet).
async function sendTyped() {
  if (busy) return note('Sparky is still working: wait, or press ■ to stop.');
  // A leading \ means "as typed" already; it isn't part of the prompt.
  const typed = (cookedFrom ?? input.value).trim().replace(/^\\\s*/, '');
  if (!typed) return;
  cookRun++;
  composer.classList.remove('cooking');
  both((a) => setBase(a, 'idle'));
  if (typed.startsWith('/')) {
    input.value = typed;
    cookedFrom = null;
    return submit();
  }
  if (settings.model === 'gemini') return askGemini(typed);
  if (settings.model === 'auto') return askAuto(typed);
  let text = picked.skills.length ? `${typed}\n\nSkills: ${picked.skills.join(', ')}` : typed;
  if (!picked.skills.length && settings.pickSkills && settings.hasKey) {
    note('picking skills with Gemini…');
    const run = cookRun;
    const result = await spark.cook(typed, { rewrite: false });
    if (run !== cookRun) return;
    if (!result.error) text = result.text;
  }
  sendNow(text);
}

const tabTab = doubleTab();
input.addEventListener('keydown', (e) => {
  // With an empty box Tab moves focus as usual; with text in it, Tab waits for its pair.
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || !input.value.trim()) return;
  e.preventDefault();
  if (tabTab(performance.now())) sendTyped();
  else note('Tab again sends what you typed, as typed');
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
  if (e.key === 'Escape' && cookedFrom !== null) {
    input.value = cookedFrom;
    cookedFrom = null;
    picked = { skills: [], model: '' };
    renderChips();
    composer.classList.remove('cooked');
    note('');
    autosize();
  }
});
input.addEventListener('input', autosize);
// Ctrl+V with an image on the clipboard attaches it; text pastes as usual.
input.addEventListener('paste', (e) => {
  const files = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
  if (!files.length) return;
  e.preventDefault();
  files.forEach(addImage);
});
composer.addEventListener('dragover', (e) => e.preventDefault());
composer.addEventListener('drop', (e) => {
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(addImage);
});

$('stop').addEventListener('click', () => {
  // Auto runs beside Claude Code, not in it: stop its models, and leave the session alone.
  if (autoActive) {
    autoRun++;
    autoActive = false;
    spark.cancelAuto();
    setBusy(false);
  } else spark.stop();
  append(el('div', 'result', '■ stopped'));
});
$('new').addEventListener('click', () => spark.newChat());
$('folder').addEventListener('click', () => spark.openFolder());
$('theme').addEventListener('click', async () => {
  look = { ...look, ...(await spark.toggleTheme()) };
  document.body.className = look.theme;
  both((a) => play(a, 'charge'));
});
for (const chip of document.querySelectorAll('.chip'))
  chip.addEventListener('click', () => {
    input.value = chip.textContent;
    autosize();
    input.focus();
  });
list.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  spark.openExternal(a.href);
});

// ---------- power core: model and effort ----------

const MODEL_INFO = {
  default: { name: 'Default', tag: 'your plan’s pick', blurb: 'Claude Code’s default model for your plan.', depth: 0, speed: 0 },
  auto: { name: 'Auto', tag: 'best of several', blurb: 'Asks several models at once, then the strongest merges the best answer. Answers only: no tools, no files.', depth: 5, speed: 1 },
  ultracode: { name: 'UltraCode', tag: 'max effort + review', blurb: 'The strongest model at max effort, and a review pass after each turn you start.', depth: 5, speed: 1 },
  opus: { name: 'Opus', tag: 'deepest thinker', blurb: 'Hard bugs, big refactors, careful plans.', depth: 5, speed: 2 },
  sonnet: { name: 'Sonnet', tag: 'everyday builder', blurb: 'Fast and sharp for most coding work.', depth: 4, speed: 4 },
  haiku: { name: 'Haiku', tag: 'fastest Claude', blurb: 'Quick edits and small questions.', depth: 2, speed: 5 },
  gemini: { name: 'Gemini', tag: 'quick answers', blurb: 'Answers in this window, without tools or files, on your Gemini key.', depth: 2, speed: 5 },
};
const EFFORT_BLURB = {
  default: 'Claude Code decides how hard to think.',
  low: 'Light and quick: few thinking tokens.',
  medium: 'Balanced: thinks when it helps.',
  high: 'Thinks it through before acting.',
  xhigh: 'Thinks longer and checks its work.',
  max: 'Everything it has. Slowest, most tokens.',
};
const levelOf = (effort) => EFFORTS.indexOf(effort) + 1;
const panel = $('engine-panel');
const track = $('effort');
const preview = actor($('preview'), 'power');

function pips(label, n) {
  const row = el('span', 'stat');
  row.append(el('span', 'stat-label', label));
  for (let i = 1; i <= 5; i++) row.append(el('i', i <= n ? 'on' : ''));
  return row;
}

// A card per model, each with its own Sparky wearing that model's hat.
const cards = MODELS.map((model) => {
  const info = MODEL_INFO[model];
  const card = el('button', `card tone-${model}`);
  card.type = 'button';
  card.setAttribute('role', 'radio');
  card.dataset.model = model;
  card.title = info.blurb;
  const pic = el('span', 'sparky');
  const canvas = el('canvas');
  canvas.width = canvas.height = 16;
  pic.append(canvas);
  card.append(pic, el('span', 'card-name', info.name), el('span', 'card-tag', info.tag));
  if (info.depth) card.append(pips('depth', info.depth), pips('speed', info.speed));
  card.actor = actor(canvas, 'idle', { hat: model in HATS ? model : null });
  card.addEventListener('pointerenter', () => play(card.actor, 'alert'));
  // The shine follows the pointer across the card.
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  card.addEventListener('click', () => pick({ model }));
  return card;
});
$('models').append(...cards);

const segs = EFFORTS.map((_, i) => {
  const seg = el('span', 'seg');
  seg.style.setProperty('--i', i);
  return seg;
});
track.append(...segs);
$('effort-ticks').append(...EFFORTS.map((e) => el('span', '', e)));

// The effort shown on the track and on the preview Sparky: committed, dragged or hovered.
function showEffort(level) {
  const effort = EFFORTS[level - 1] ?? 'default';
  segs.forEach((seg, i) => seg.classList.toggle('on', i < level));
  [...$('effort-ticks').children].forEach((tick, i) => tick.classList.toggle('on', i === level - 1));
  track.classList.toggle('max', level === 5);
  track.setAttribute('aria-valuenow', level);
  track.setAttribute('aria-valuetext', effort);
  $('effort-name').textContent = level ? effort : 'auto';
  $('effort-blurb').textContent = EFFORT_BLURB[effort];
  preview.opts.level = level;
}

function drawHat() {
  const canvas = $('engine-hat');
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, 6, 4);
  for (const [x, y, c] of HATS[settings.model] ?? []) {
    g.fillStyle = `rgb(${c.join(',')})`;
    g.fillRect(x - 5, y, 1, 1);
  }
  canvas.hidden = !(settings.model in HATS);
}

function renderEngine() {
  const { model, effort } = settings;
  if (!model) return;
  const info = MODEL_INFO[model];
  const gemini = model === 'gemini';
  const auto = model === 'auto';
  const ultra = model === 'ultracode';
  // Gemini and Auto answer in the window; UltraCode always runs at max: none of them take the effort bar.
  const fixed = gemini || auto || ultra;
  const level = ultra ? 5 : levelOf(effort);
  $('engine').className = `engine tone-${model}`;
  $('engine-name').textContent = info.name;
  $('engine-effort').textContent = gemini ? 'quick' : auto ? 'compare' : ultra ? 'max' : level ? effort : 'auto';
  $('engine-meter').hidden = gemini || auto;
  $('engine-meter').classList.toggle('max', level === 5);
  [...$('engine-meter').children].forEach((pip, i) => pip.classList.toggle('on', i < level));
  drawHat();
  $('core-line').textContent =
    gemini || auto ? info.blurb : ultra ? `UltraCode on ${settings.ultraModel} at max effort. ${info.blurb}` : `${info.name} at ${level ? effort : 'auto'} effort. ${info.blurb}`;
  for (const card of cards) {
    const on = card.dataset.model === model;
    card.classList.toggle('on', on);
    card.setAttribute('aria-checked', on);
    card.tabIndex = on ? 0 : -1;
  }
  panel.className = `tone-${model}${busy ? ' locked' : ''}`;
  $('core-lock').hidden = !busy;
  $('effort-box').classList.toggle('off', fixed);
  $('gemini-note').hidden = !gemini;
  $('auto-note').hidden = !auto;
  $('ultra-note').hidden = !ultra;
  $('effort-auto').classList.toggle('on', !level);
  track.tabIndex = fixed ? -1 : 0;
  showEffort(level);
}

// Every switch charges Sparky up; the chosen card's Sparky jumps for joy.
function powerUp() {
  const level = levelOf(settings.effort);
  for (const a of [mini, hero, preview]) play(a, 'charge', { level });
  const card = cards.find((c) => c.dataset.model === settings.model);
  if (card) play(card.actor, 'cheer');
}

function pick(changes) {
  if (busy) return note('wait for Sparky to finish before switching');
  return setSetting(changes);
}

panel.addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  renderEngine();
  play(preview, 'alert');
  (cards.find((c) => c.classList.contains('on')) ?? cards[0]).focus();
});

$('models').addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!step) return;
  e.preventDefault();
  cards[(cards.indexOf(document.activeElement) + step + cards.length) % cards.length].focus();
});

// Drag or click along the track; hovering previews a level, letting go picks it.
const levelAt = (e) => {
  const r = track.getBoundingClientRect();
  return Math.min(5, Math.max(1, Math.ceil(((e.clientX - r.left) / r.width) * 5)));
};
let dragging = false;
track.addEventListener('pointerdown', (e) => {
  if (busy) return;
  dragging = true;
  track.setPointerCapture(e.pointerId);
  showEffort(levelAt(e));
});
track.addEventListener('pointermove', (e) => showEffort(levelAt(e)));
track.addEventListener('pointerleave', () => !dragging && showEffort(levelOf(settings.effort)));
track.addEventListener('pointerup', async (e) => {
  if (!dragging) return;
  await pick({ effort: EFFORTS[levelAt(e) - 1] });
  dragging = false;
});
// Arrow keys step the level; it's picked once the keys go quiet, so one restart, not five.
let settle;
track.addEventListener('keydown', (e) => {
  const now = Number(track.getAttribute('aria-valuenow'));
  const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
  const level = e.key === 'Home' ? 1 : e.key === 'End' ? 5 : step ? Math.min(5, Math.max(1, now + step)) : 0;
  if (!level || busy) return;
  e.preventDefault();
  showEffort(level);
  clearTimeout(settle);
  settle = setTimeout(() => pick({ effort: EFFORTS[level - 1] }), 450);
});
$('effort-auto').addEventListener('click', () => pick({ effort: 'default' }));

// ---------- settings ----------

$('gear').addEventListener('click', () => {
  $('cook').checked = settings.cook;
  $('pick-skills').checked = settings.pickSkills;
  $('auto-edits').checked = settings.autoEdits;
  $('auto-models').replaceChildren(
    ...settings.autoChoices.map((m) => {
      const box = el('input');
      box.type = 'checkbox';
      box.value = m;
      box.checked = settings.autoModels.includes(m);
      const label = el('label', 'check');
      label.append(box, ` ${m}`);
      return label;
    }),
  );
  $('ultra-model').replaceChildren(
    ...settings.ultraChoices.map((m) => {
      const option = el('option', '', m);
      option.value = m;
      option.selected = m === settings.ultraModel;
      return option;
    }),
  );
  $('key').value = '';
  $('key-state').textContent = settings.hasKey ? 'A key is saved (encrypted for your Windows account). Paste a new one to replace it.' : 'No key yet: without one, prompts are sent as typed.';
  $('or-key').value = '';
  $('or-key-state').textContent = settings.hasOpenRouterKey
    ? 'A key is saved (encrypted for your Windows account). Paste a new one to replace it.'
    : 'No key yet: Council then uses only Claude, Gemini and any local Ollama models.';
  $('council-cap').value = String(settings.councilBudgetUsd ?? 1);
  $('settings').showModal();
});
$('save-settings').addEventListener('click', async () => {
  const key = $('key').value.trim();
  const openrouterKey = $('or-key').value.trim();
  const cap = Number($('council-cap').value);
  const autoModels = [...$('auto-models').querySelectorAll('input:checked')].map((box) => box.value);
  if (!autoModels.length) return note('pick at least one model for Auto');
  if (!Number.isFinite(cap) || cap < 0) return note('the Council cap is a dollar amount, 0 or more');
  await setSetting({
    cook: $('cook').checked,
    pickSkills: $('pick-skills').checked,
    autoEdits: $('auto-edits').checked,
    autoModels,
    ultraModel: $('ultra-model').value,
    councilBudgetUsd: cap,
    ...(key ? { key } : {}),
    ...(openrouterKey ? { openrouterKey } : {}),
  });
  $('settings').close();
});

input.focus();
spark.ready();
