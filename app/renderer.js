/* global marked, DOMPurify, spark */
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

// ---------- Sparky ----------

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const UNLIT = [30, 27, 58];

// Eyes at brightness g: unlit, through the theme's glow color, to a white-hot core.
function drawSparky(canvas, { g = 1, blink = false, lookLeft = false, pixels = look.sprite } = {}) {
  const paint = canvas.getContext('2d');
  paint.clearRect(0, 0, 16, 16);
  const white = g > 0.8 ? mix(look.glow, [255, 255, 255], (g - 0.8) * 5) : mix(UNLIT, look.glow, g / 0.8);
  pixels.forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      let c = color;
      const eye = (y === 7 || y === 8) && [4, 5, 10, 11].includes(x);
      if (eye && blink) c = look.sprite[6]?.[x] ?? color;
      else if (eye) {
        const pupil = y === 8 && (lookLeft ? x === 4 || x === 10 : x === 5 || x === 11);
        c = pupil ? [11, 10, 31] : white;
      }
      paint.fillStyle = `rgb(${c.join(',')})`;
      paint.fillRect(x, y, 1, 1);
    }),
  );
}

// Pixels fly in from fixed scattered spots, then the eyes catch like a neon tube.
function assemble(canvas) {
  const targets = [];
  look.sprite.forEach((row, y) => row.forEach((c, x) => c && targets.push([x, y, c])));
  const start = targets.map((_, i) => {
    const n = Math.sin(i * 12.9898) * 43758.5453;
    const m = Math.sin(i * 78.233) * 12345.6789;
    return [Math.floor((n - Math.floor(n)) * 16), Math.floor((m - Math.floor(m)) * 16)];
  });
  const t0 = performance.now();
  const flicker = [0.15, 0.6, 0.1, 0.85, 0.35, 1];
  function frame(now) {
    const t = Math.min(1, (now - t0) / 650);
    const pixels = Array.from({ length: 16 }, () => Array(16).fill(null));
    targets.forEach(([x, y, c], i) => {
      const p = 1 - (1 - Math.min(1, Math.max(0, (t - (i % 7) / 20) / 0.7))) ** 3;
      const [sx, sy] = start[i];
      pixels[Math.round(sy + (y - sy) * p)][Math.round(sx + (x - sx) * p)] = c;
    });
    if (t < 1) {
      drawSparky(canvas, { g: 0, pixels });
      requestAnimationFrame(frame);
      return;
    }
    flicker.forEach((g, i) => setTimeout(() => drawSparky(canvas, { g }), i * 70));
  }
  requestAnimationFrame(frame);
}

// Now and then Sparky blinks, and sometimes glances left.
setInterval(() => {
  for (const canvas of [$('mini'), $('hero')]) {
    drawSparky(canvas, { blink: true });
    setTimeout(() => drawSparky(canvas), 140);
  }
  if (Math.random() < 0.35) {
    setTimeout(() => [$('mini'), $('hero')].forEach((c) => drawSparky(c, { lookLeft: true })), 900);
    setTimeout(() => [$('mini'), $('hero')].forEach((c) => drawSparky(c)), 1700);
  }
}, 5200);

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
  const dot = el('span', 'spark-dot', 'ϟ');
  const label = el('span', 'label');
  node.append(dot, label);
  const started = performance.now();
  let verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  const tick = () => {
    const s = Math.round((performance.now() - started) / 1000);
    if (s && s % 6 === 0) verb = VERBS[(VERBS.indexOf(verb) + 1) % VERBS.length];
    label.textContent = `${verb}… ${s}s`;
  };
  tick();
  thinking = { el: node, timer: setInterval(tick, 1000) };
  append(document.createDocumentFragment());
}

function setBusy(on) {
  busy = on;
  $('send').hidden = on;
  $('stop').hidden = !on;
  setThinking(on);
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

let renderQueued = false;
spark.on('event', (event) => {
  if (event.kind === 'init') $('model').textContent = event.model ?? '';
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
  }
  if (event.kind === 'tool') {
    streaming = null;
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
    const seconds = (event.durationMs / 1000).toFixed(1);
    append(el('div', event.ok ? 'result' : 'result failed', event.ok ? `✦ done in ${seconds}s · $${event.costUsd.toFixed(4)}` : `✗ ${event.text || 'the turn ended with an error'}`));
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
  append(card);
  yes.focus();
});

spark.on('exit', ({ code, error }) => {
  setBusy(false);
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
  $('status').innerHTML = '';
  $('status').append(el('span', '', s.folder), el('span', 'sep', ' · '), el('span', '', s.state), el('span', 'sep', ' · '), el('span', '', ''));
  $('status').lastChild.id = 'model';
  $('folder').textContent = s.folder;
  $('where').textContent = ` in ${s.folder}`;
  $('cook-toggle').classList.toggle('on', settings.cook && settings.hasKey);
  setBusy(false);
  if (s.fresh) {
    list.replaceChildren($('welcome'));
    $('welcome').hidden = false;
    tools.clear();
    assemble($('hero'));
    assemble($('mini'));
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

function sendNow(text) {
  addUser(text, attachments);
  spark.sendMessage({ text, images: attachments.map(({ mediaType, data }) => ({ mediaType, data })) });
  input.value = '';
  autosize();
  attachments = [];
  renderAttachments();
  cookedFrom = null;
  composer.classList.remove('cooked');
  note('');
  setBusy(true);
}

// Enter cooks the prompt with Gemini first (when on); Enter again sends what the box holds.
async function submit() {
  if (busy) return note('Sparky is still working: wait, or press ■ to stop.');
  let text = input.value.trim();
  if (!text && !attachments.length) return;
  if (text.startsWith('\\')) return sendNow(text.slice(1).trimStart());
  const cook = settings.cook && settings.hasKey && cookedFrom === null && text.split(/\s+/).length >= 4;
  if (!cook) return sendNow(text);
  composer.classList.add('cooking');
  note('cooking with Gemini…');
  const result = await spark.cook(text);
  composer.classList.remove('cooking');
  cookedFrom = text;
  if (result.error) return note(`not cooked (${result.error}) · Enter sends yours as typed`);
  input.value = result.text;
  autosize();
  composer.classList.add('cooked');
  note(`cooked by ${result.model} · edit freely · Enter sends · Esc restores yours`);
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
  drawSparky($('mini'));
  drawSparky($('hero'));
});
$('cook-toggle').addEventListener('click', async () => {
  if (!settings.hasKey) return $('gear').click();
  settings = await spark.setSettings({ cook: !settings.cook });
  $('cook-toggle').classList.toggle('on', settings.cook);
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

// ---------- settings ----------

$('gear').addEventListener('click', () => {
  $('cook').checked = settings.cook;
  $('auto-edits').checked = settings.autoEdits;
  $('key').value = '';
  $('key-state').textContent = settings.hasKey ? 'A key is saved (encrypted for your Windows account). Paste a new one to replace it.' : 'No key yet: without one, prompts are sent as typed.';
  $('settings').showModal();
});
$('save-settings').addEventListener('click', async () => {
  const key = $('key').value.trim();
  settings = await spark.setSettings({ cook: $('cook').checked, autoEdits: $('auto-edits').checked, ...(key ? { key } : {}) });
  $('cook-toggle').classList.toggle('on', settings.cook && settings.hasKey);
  $('settings').close();
});

input.focus();
spark.ready();
