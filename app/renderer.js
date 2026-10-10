/* global marked, DOMPurify, spark */
import { parseCommand, withModes, MODELS, EFFORTS } from './lib/commands.js';
import { costLine } from './lib/account.js';
import { MOVES, HATS, frameAt, emits } from './lib/sparky.js';

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
    const o = { sprite: look.sprite, glow: look.glow, hat, look: pupils(a.canvas), ...a.opts, ...a.once };
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
    const s = Math.round((performance.now() - started) / 1000);
    if (s && s % 6 === 0) verb = VERBS[(VERBS.indexOf(verb) + 1) % VERBS.length];
    label.textContent = `${verb}… ${s}s`;
  };
  tick();
  thinking = { el: node, timer: setInterval(tick, 1000) };
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
  const answering = settings.model === 'gemini' ? 'Gemini quick answers' : model || 'Claude';
  const effort = settings.model !== 'gemini' && settings.effort !== 'default' ? ` · ${settings.effort} effort` : '';
  $('status').textContent = `${where} · ${answering}${effort} · ${settings.hasKey ? 'gemini on' : 'gemini off'}`;
  $('status').title = cwd;
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
    if (event.output) t.body.append(el('pre', event.isError ? 'output error' : 'output', event.output.slice(0, 20000)));
  }
  if (event.kind === 'result') {
    streaming = null;
    setBusy(false);
    both((a) => play(a, event.ok ? 'cheer' : 'oops'));
    const seconds = (event.durationMs / 1000).toFixed(1);
    const line = el(
      'div',
      event.ok ? 'result' : 'result failed',
      event.ok ? `✦ done in ${seconds}s · ${costLine({ ...event, model, tools: turnTools }, who)}` : `✗ ${event.text || 'the turn ended with an error'}`,
    );
    line.title = `The price Claude Code reports for this turn at API rates: the model, the tokens it read and wrote, and its tool calls. ${who.label}: ${who.note}. Gemini rewrites and skill picks use your Gemini key's Google project.`;
    append(line);
  }
});

spark.on('permission', ({ id, tool, input }) => {
  const card = el('div', 'permission');
  card.append(el('div', 'ask', `Claude wants to use ${tool}`), el('div', 'what', summary(tool, input)), details(tool, input));
  const row = el('div', 'buttons');
  const answer = (allow, always) => {
    spark.answerPermission({ id, tool, allow, always });
    row.replaceWith(el('div', allow ? 'answered allowed' : 'answered denied', allow ? (always ? `Allowed (and ${tool} from now on)` : 'Allowed') : 'Denied'));
  };
  const yes = el('button', 'yes', 'Allow');
  const always = el('button', 'always', `Always allow ${tool}`);
  const no = el('button', 'no', 'Deny');
  yes.type = always.type = no.type = 'button';
  yes.addEventListener('click', () => answer(true, false));
  always.addEventListener('click', () => answer(true, true));
  no.addEventListener('click', () => answer(false, false));
  row.append(yes, always, no);
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
  $('cook-toggle').classList.toggle('on', settings.cook && settings.hasKey);
  setBusy(false);
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

async function setSetting(changes) {
  const before = settings;
  settings = await spark.setSettings(changes);
  renderStatus();
  if (before.model !== settings.model || before.effort !== settings.effort) powerUp();
}

// Spark's own slash commands act here; any other /command goes to Claude Code as typed.
function runCommand(text) {
  const command = parseCommand(text);
  if (!command || command.kind === 'passthrough') return false;
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
      note(settings.cook ? 'cooking with Gemini…' : 'picking skills with Gemini…');
      const result = await spark.cook(text);
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
      return note(`${by.join(' · ')}${by.length ? ' · ' : ''}edit freely · Enter sends · Esc restores yours`);
    }
  }
  return settings.model === 'gemini' ? askGemini(text) : sendNow(text);
}

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
  spark.stop();
  append(el('div', 'result', '■ stopped'));
});
$('new').addEventListener('click', () => spark.newChat());
$('folder').addEventListener('click', () => spark.openFolder());
$('theme').addEventListener('click', async () => {
  look = { ...look, ...(await spark.toggleTheme()) };
  document.body.className = look.theme;
  both((a) => play(a, 'charge'));
});
$('cook-toggle').addEventListener('click', async () => {
  if (!settings.hasKey) return $('gear').click();
  await setSetting({ cook: !settings.cook });
  $('cook-toggle').classList.toggle('on', settings.cook);
  note(settings.cook ? 'Gemini rewrites your prompts' : 'Gemini rewriting off: prompts go as typed');
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
  default: { name: 'Auto', tag: 'your plan’s pick', blurb: 'Claude Code’s default model for your plan.', depth: 0, speed: 0 },
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
  const level = levelOf(effort);
  $('engine').className = `engine tone-${model}`;
  $('engine-name').textContent = info.name;
  $('engine-effort').textContent = gemini ? 'quick' : level ? effort : 'auto';
  $('engine-meter').hidden = gemini;
  $('engine-meter').classList.toggle('max', level === 5);
  [...$('engine-meter').children].forEach((pip, i) => pip.classList.toggle('on', i < level));
  drawHat();
  $('core-line').textContent = gemini ? info.blurb : `${info.name} at ${level ? effort : 'auto'} effort. ${info.blurb}`;
  for (const card of cards) {
    const on = card.dataset.model === model;
    card.classList.toggle('on', on);
    card.setAttribute('aria-checked', on);
    card.tabIndex = on ? 0 : -1;
  }
  panel.className = `tone-${model}${busy ? ' locked' : ''}`;
  $('core-lock').hidden = !busy;
  $('effort-box').classList.toggle('off', gemini);
  $('gemini-note').hidden = !gemini;
  $('effort-auto').classList.toggle('on', !level);
  track.tabIndex = gemini ? -1 : 0;
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
  $('key').value = '';
  $('key-state').textContent = settings.hasKey ? 'A key is saved (encrypted for your Windows account). Paste a new one to replace it.' : 'No key yet: without one, prompts are sent as typed.';
  $('settings').showModal();
});
$('save-settings').addEventListener('click', async () => {
  const key = $('key').value.trim();
  await setSetting({ cook: $('cook').checked, pickSkills: $('pick-skills').checked, autoEdits: $('auto-edits').checked, ...(key ? { key } : {}) });
  $('cook-toggle').classList.toggle('on', settings.cook && settings.hasKey);
  $('settings').close();
});

input.focus();
spark.ready();
