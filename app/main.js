import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { createInterface } from 'node:readline';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSession, configuredTheme } from './staged/src/session.js';
import { grid } from './staged/src/sparky-pixels.js';
import { loadConfig, saveConfig } from './staged/src/config.js';
import { loadKey, saveKey, clearKey } from './staged/src/key.js';
import { THEMES, THEME_NAMES } from './staged/src/palettes.js';
import { parseLine, userMessage } from './lib/stream.js';
import { EDIT_TOOLS } from './lib/marathon.js';
import { createMarathon } from './lib/marathon-runner.js';
import { openMissions } from './lib/mission-open.js';
import { missionRequest } from './lib/mission-ipc.js';
import { createCouncilIo } from './lib/council-io.js';
import { createCouncils } from './lib/council-session.js';
import { cookPrompt, quickAnswer } from './lib/cook.js';
import { DEFAULT_AUTO_MODELS, CLAUDE_AUTO_MODELS, isClaude, autoAnswer, runClaude } from './lib/auto.js';
import { sessionModelArgs, reviewDue, REVIEW_PASS } from './lib/ultracode.js';
import { describeSkills, listSkills } from './lib/skills.js';
import { payer } from './lib/account.js';
import { homedir, tmpdir } from 'node:os';
import { isTrusted, trust, sessionGuard, sessionEnv } from './lib/trust.js';
import { gateNote } from './lib/gate.js';

const here = dirname(fileURLToPath(import.meta.url));
// Installed, the plugin, assets and permission bridge sit beside the app as plain files.
const resources = app.isPackaged ? process.resourcesPath : join(here, 'staged');
const bridgeDir = app.isPackaged ? join(process.resourcesPath, 'bridge') : join(here, 'bridge');
const pluginDir = join(resources, 'plugin');
const { userConfig } = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const REWRITE_MODELS = userConfig.rewrite_models.default.split(',');
const ROUTE_MODELS = userConfig.route_models.default.split(',');
// What ⚙ settings offers for Auto (Claude aliases, then the Gemini models Spark knows) and UltraCode.
const AUTO_CHOICES = [...CLAUDE_AUTO_MODELS, ...new Set([...REWRITE_MODELS, ...ROUTE_MODELS])];
const ULTRA_CHOICES = ['fable', 'opus', 'sonnet'];
// One model in Auto gets this long before its answer is left out.
const AUTO_TIMEOUT_MS = 180_000;

let win;
let cwd;
// 'trusted' or 'safe' for the open folder: see lib/trust.js.
let folderMode;
let claude;
let sessionId;
let bridge;
let geminiKey;
let alwaysAllow = new Set();
// The session's skills with what each is for, for Gemini's skill picks.
let skillInfo = [];
// Permission questions waiting on the window, by id.
const pending = new Map();
// Keeps Claude working for a time or token budget (lib/marathon.js); idle until /marathon starts one.
const marathon = createMarathon({
  write: (line) => claude?.stdin.write(`${line}\n`),
  notify: (message) => send('marathon', message),
  now: Date.now,
  top: () => (loadConfig().marathonTop === 'fable' ? 'fable' : 'opus'),
});
// The --model and --effort the running Claude Code process started with.
let runningArgs = [];
// Whether the turn running answers the person (UltraCode reviews those once, never its own review
// or a marathon's), and whether it changed files.
let fromUser = false;
let turnEdited = false;
// Auto's one-shot Claude processes, so ■ can stop them.
const autoChildren = new Set();
// Missions for the open folder (lib/mission-runner.js), made again when the folder changes.
let missions;
// Councils for the open folder (lib/council-session.js), and the OpenRouter key they may use.
let councils;
let openrouterKey;
const SPARK_DATA = join(process.env.APPDATA ?? homedir(), 'spark');
const OPENROUTER_KEY = join(SPARK_DATA, 'openrouter.key');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
// Unbiased order for the blind letters.
const shuffle = (n) => {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

const send = (channel, data) => win?.webContents.send(channel, data);
const rgb = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const isFolder = (path) => existsSync(path) && statSync(path).isDirectory();
const look = (theme) => ({ theme, sprite: grid(theme), glow: THEMES[theme].glow });

function settings() {
  const c = loadConfig();
  return {
    theme: configuredTheme(c),
    cook: c.cook !== false,
    pickSkills: c.pickSkills !== false,
    autoEdits: c.autoEdits === true,
    model: c.model ?? 'default',
    effort: c.effort ?? 'default',
    autoModels: Array.isArray(c.autoModels) ? c.autoModels.filter((m) => AUTO_CHOICES.includes(m)) : DEFAULT_AUTO_MODELS,
    ultraModel: ULTRA_CHOICES.includes(c.ultraModel) ? c.ultraModel : 'fable',
    autoChoices: AUTO_CHOICES,
    ultraChoices: ULTRA_CHOICES,
    hasKey: Boolean(geminiKey),
    hasOpenRouterKey: Boolean(openrouterKey),
    councilBudgetUsd: Number.isFinite(c.councilBudgetUsd) && c.councilBudgetUsd >= 0 ? c.councilBudgetUsd : 1,
  };
}

// Only the sign-in fields that say which plan pays; nothing personal leaves this function.
function account() {
  try {
    const a = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).oauthAccount ?? {};
    return { organizationType: a.organizationType, organizationRateLimitTier: a.organizationRateLimitTier, hasExtraUsageEnabled: a.hasExtraUsageEnabled };
  } catch {
    return {};
  }
}

// A folder Spark can't write to still opens for chat; missions are off there, and the window says why.
async function openFolderMissions() {
  const opened = await openMissions({
    cwd,
    write: (line) => claude?.stdin.write(`${line}\n`),
    notify: (message) => send('mission', message),
    now: Date.now,
    hex4: () => randomBytes(2).toString('hex'),
  });
  missions = opened.missions;
  if (opened.error) send('mission', { kind: 'error', error: `missions are off in this folder: ${opened.error}` });
  // Claude one-shots in a council never inherit the Gemini key from the environment.
  const env = { ...process.env };
  delete env.SPARK_GEMINI_KEY;
  councils = createCouncils({
    root: opened.root,
    makeIo: (dataCollection) =>
      createCouncilIo({ spawn, keys: { openrouter: openrouterKey, gemini: geminiKey }, cwd, scratch: tmpdir(), env, cachePath: join(SPARK_DATA, 'council-catalog.json'), dataCollection }),
    notify: (message) => send('council', message),
    now: Date.now,
    hex4: () => randomBytes(2).toString('hex'),
    shuffle,
    sleep: wait,
    deadline: wait,
    consents: () => loadConfig().councilConsent ?? {},
    saveConsent: (provider, dataCollection) => {
      const c = loadConfig();
      saveConfig({ ...c, councilConsent: { ...(c.councilConsent ?? {}), [provider]: { at: Date.now(), dataCollection } } });
    },
    budgetUsd: () => settings().councilBudgetUsd,
  });
}

// Claude Code asks before a tool runs; the bridge server relays the question here.
function startBridge() {
  const token = randomBytes(16).toString('hex');
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.headers['x-spark-token'] !== token) return res.writeHead(403).end();
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { tool, input } = JSON.parse(body || '{}');
      const answer = (decision) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision));
      const held = missions?.draftDenial(tool, input);
      if (held) return answer({ allow: false, message: held });
      // A command Spark's gate holds is asked about every time: "always" can't cover it.
      const note = gateNote(tool, input, { repo: cwd, home: homedir() });
      if (!note && (alwaysAllow.has(tool) || (EDIT_TOOLS.has(tool) && settings().autoEdits))) {
        missions?.permission(tool, input, 'auto-allowed');
        return answer({ allow: true });
      }
      const id = randomBytes(6).toString('hex');
      pending.set(id, { answer, tool, input, note });
      send('permission', { id, tool, input, note });
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/approve`, token })));
}

function stopClaude() {
  const child = claude;
  claude = undefined;
  marathon.restarted();
  missions?.interrupted('Claude Code restarted');
  child?.kill();
  for (const { answer } of pending.values()) answer({ allow: false, message: 'Stopped from Spark.' });
  pending.clear();
}

// Claude Code runs headless: messages go in and events come out as JSON lines.
// `keepBusy`: a message is on its way, so the window must not drop its working state.
function startClaude({ resume, keepBusy = false } = {}) {
  stopClaude();
  saveConfig({ ...loadConfig(), lastFolder: cwd });
  // Claude Code names its skills only once the first message is in; until then, read them from disk.
  if (!resume) skillInfo = describeSkills(listSkills(homedir()), homedir());
  const base = prepareSession({ pluginDir, key: geminiKey ?? null });
  const mcp = {
    mcpServers: {
      spark: {
        command: process.execPath,
        args: [join(bridgeDir, 'permission-server.mjs')],
        env: { ELECTRON_RUN_AS_NODE: '1', SPARK_BRIDGE_URL: bridge.url, SPARK_BRIDGE_TOKEN: bridge.token },
      },
    },
  };
  const args = [
    ...base.args,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'mcp__spark__approve',
    '--mcp-config',
    JSON.stringify(mcp),
    ...sessionGuard(folderMode),
    ...(runningArgs = sessionModelArgs(settings()) ?? runningArgs),
    ...(resume ? ['--resume', resume] : []),
  ];
  const child = spawn('claude', args, { cwd, env: sessionEnv(folderMode, base.env), windowsHide: true });
  claude = child;
  let errors = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (claude !== child) return;
    for (const event of parseLine(line)) {
      if (event.kind === 'init') {
        sessionId = event.sessionId;
        skillInfo = describeSkills(event.skills, homedir());
        send('payer', payer({ apiKeySource: event.apiKeySource, account: account() }));
      }
      send('event', event);
      if (event.kind === 'tool' && EDIT_TOOLS.has(event.name)) turnEdited = true;
      const inMarathon = marathon.running();
      marathon.onEvent(event);
      missions?.onEvent(event);
      if (event.kind === 'result' && reviewDue({ model: settings().model, fromUser, marathon: inMarathon, edited: turnEdited }, event)) {
        turnEdited = false;
        fromUser = false;
        child.stdin.write(`${userMessage({ text: REVIEW_PASS })}\n`);
        send('ultra', { kind: 'review' });
      }
    }
  });
  child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-4000)));
  child.on('error', (err) => {
    if (claude !== child) return;
    claude = undefined;
    missions?.exited(undefined, err.message);
    send('exit', { error: `Could not start Claude Code (${err.message}). Install it with: irm https://claude.ai/install.ps1 | iex` });
  });
  child.on('exit', (code) => {
    if (claude !== child) return;
    claude = undefined;
    marathon.end('Claude Code stopped', { restore: false });
    missions?.exited(code, errors.trim() || undefined);
    send('exit', { code, error: errors.trim() || undefined });
  });
  win.setTitle(`Spark · ${basename(cwd)}`);
  const state = folderMode === 'safe' ? `${base.state} · project settings off` : base.state;
  send('session', { ...look(base.theme), fresh: !resume, keepBusy, folder: basename(cwd), cwd, state, settings: settings() });
}

// Asks before a new folder's own Claude Code settings, hooks and MCP servers may run.
async function decideTrust(folder) {
  if (isTrusted(loadConfig(), folder)) return 'trusted';
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Trust this folder?',
    message: `Do you trust the files in ${basename(folder)}?`,
    detail:
      "If you trust it, Claude Code loads the folder's own settings, hooks and MCP servers, which can run commands on this computer. Opened safely, Spark ignores them.",
    buttons: ['Trust this folder', 'Open safely', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
  });
  if (response === 0) saveConfig(trust(loadConfig(), folder));
  return [ 'trusted', 'safe', undefined ][response];
}

async function chooseFolder() {
  const picked = await dialog.showOpenDialog(win, { title: 'Open a project folder for Spark', properties: ['openDirectory'] });
  return picked.canceled ? undefined : picked.filePaths[0];
}

ipcMain.on('ready', async () => {
  const fromArgs = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && isFolder(a));
  const last = loadConfig().lastFolder;
  geminiKey = loadKey() ?? undefined;
  openrouterKey = loadKey(OPENROUTER_KEY) ?? undefined;
  bridge ??= await startBridge();
  cwd = fromArgs ? resolve(fromArgs) : last && isFolder(last) ? last : await chooseFolder();
  folderMode = cwd && (await decideTrust(cwd));
  if (!folderMode) return app.quit();
  await openFolderMissions();
  startClaude();
});

ipcMain.on('send-message', (_e, message) => {
  if (!claude) startClaude({ resume: sessionId, keepBusy: true });
  fromUser = !marathon.running();
  turnEdited = false;
  missions?.you(message.text ?? '');
  claude.stdin.write(`${userMessage(marathon.outgoing(message))}\n`);
});

ipcMain.on('marathon', (_e, request) => {
  if (request.action === 'stop') return marathon.end('you stopped it', { restore: true });
  if (missions?.busy()) return send('marathon', { kind: 'end', reason: 'a mission is running', summary: '' });
  // A restart would end the marathon being set up.
  if (!claude) startClaude({ resume: sessionId, keepBusy: true });
  marathon.start({ task: request.task, limits: request.limits, picker: settings().model });
});

ipcMain.handle('missions', () => missions?.list() ?? []);
ipcMain.handle('mission-view', (_e, id) => missions?.view(id));
ipcMain.handle('mission', (_e, request = {}) =>
  missionRequest(request, {
    missions,
    model: settings().model,
    marathonRunning: marathon.running(),
    sessionId,
    ensureClaude: () => {
      if (!claude) startClaude({ resume: sessionId, keepBusy: true });
    },
    stopTurn: () => startClaude({ resume: sessionId }),
    restart: (resume) => startClaude({ resume, keepBusy: true }),
    // Mission messages aren't the person's chat: UltraCode doesn't review them.
    notUser: () => {
      fromUser = false;
      turnEdited = false;
    },
  }),
);

// Stopping ends the running turn; the conversation carries on in a fresh process.
ipcMain.on('stop', () => {
  missions?.stopped();
  marathon.end('you pressed stop', { restore: false });
  startClaude({ resume: sessionId });
});

ipcMain.on('new-chat', () => {
  sessionId = undefined;
  alwaysAllow = new Set();
  missions?.interrupted('you started a new chat', { detach: true });
  startClaude();
});

ipcMain.on('open-folder', async () => {
  const folder = await chooseFolder();
  const mode = folder && (await decideTrust(folder));
  if (!mode) return;
  missions?.interrupted('you opened another folder', { detach: true });
  cwd = folder;
  folderMode = mode;
  sessionId = undefined;
  alwaysAllow = new Set();
  await openFolderMissions();
  startClaude();
});

// Main uses the tool it asked about, never one the window names.
ipcMain.on('permission-answer', (_e, { id, allow, always }) => {
  const ask = pending.get(id);
  if (!ask) return;
  pending.delete(id);
  if (allow && always) alwaysAllow.add(ask.tool);
  missions?.permission(ask.tool, ask.input, allow ? (always ? 'always' : 'allowed') : 'denied', ask.note);
  ask.answer({ allow });
});

// `rewrite: false` picks skills only: Tab Tab sends the typed prompt with them.
ipcMain.handle('cook', async (_e, text, { rewrite } = {}) => {
  if (!geminiKey) return { error: 'no Gemini key; add one in settings' };
  const s = settings();
  try {
    return await cookPrompt(text, {
      key: geminiKey,
      rewrite: rewrite ?? s.cook,
      pickSkills: s.pickSkills,
      skills: skillInfo,
      rewriteModels: REWRITE_MODELS,
      routeModels: ROUTE_MODELS,
    });
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('quick', async (_e, history) => {
  if (!geminiKey) return { error: 'no Gemini key; add one in settings' };
  try {
    return await quickAnswer(history, { key: geminiKey, rewriteModels: REWRITE_MODELS });
  } catch (err) {
    return { error: err.message };
  }
});

// Auto: every chosen model answers the chat, then a judge merges the best answer (lib/auto.js).
// Claude members run one-shot from a scratch folder, so no project files or settings reach them.
ipcMain.handle('auto', async (_e, history) => {
  const env = { ...process.env };
  delete env.SPARK_GEMINI_KEY;
  const ask = (model, system, conversation) => {
    const tracked = (...args) => {
      const child = spawn(...args);
      autoChildren.add(child);
      child.on('close', () => autoChildren.delete(child));
      return child;
    };
    if (isClaude(model)) return runClaude(model, system, conversation, { spawn: tracked, cwd: tmpdir(), env, timeoutMs: AUTO_TIMEOUT_MS });
    if (!geminiKey) return Promise.reject(new Error('no Gemini key'));
    return quickAnswer(conversation, { key: geminiKey, rewriteModels: [model], system, tries: 1, timeoutMs: AUTO_TIMEOUT_MS }).then((a) => a.text);
  };
  try {
    return await autoAnswer(history, { models: settings().autoModels, ask, timeoutMs: AUTO_TIMEOUT_MS });
  } catch (err) {
    return { error: err.message };
  }
});

// ■ during Auto: its Claude processes stop; the window drops whatever still comes back.
ipcMain.on('auto-cancel', () => {
  for (const child of autoChildren) child.kill();
});

ipcMain.handle('toggle-theme', () => {
  const next = THEME_NAMES[(THEME_NAMES.indexOf(configuredTheme()) + 1) % THEME_NAMES.length];
  saveConfig({ ...loadConfig(), theme: next });
  win.setTitleBarOverlay({ color: rgb(THEMES[next].background.from), symbolColor: '#E8EDF7', height: 56 });
  return look(next);
});

ipcMain.handle('set-settings', (_e, { key, openrouterKey: orKey, ...changes }) => {
  const known = ['cook', 'pickSkills', 'autoEdits', 'model', 'effort', 'autoModels', 'ultraModel', 'councilBudgetUsd'];
  if (changes.councilBudgetUsd !== undefined && !(Number.isFinite(changes.councilBudgetUsd) && changes.councilBudgetUsd >= 0)) delete changes.councilBudgetUsd;
  saveConfig({ ...loadConfig(), ...Object.fromEntries(Object.entries(changes).filter(([name, v]) => known.includes(name) && v !== undefined)) });
  if (orKey !== undefined) {
    if (orKey) saveKey(orKey, OPENROUTER_KEY);
    else clearKey(OPENROUTER_KEY);
    openrouterKey = orKey || undefined;
  }
  // A different Claude model or effort takes a restart; the conversation carries on.
  const wanted = sessionModelArgs(settings());
  if (wanted && JSON.stringify(wanted) !== JSON.stringify(runningArgs) && cwd) startClaude({ resume: sessionId });
  if (key !== undefined) {
    if (key) saveKey(key);
    else clearKey();
    geminiKey = key || undefined;
  }
  return settings();
});

// Councils: the pre-flight returns the brief and panel to approve; Run starts it in the background
// and its progress arrives on the 'council' channel.
ipcMain.handle('council-preflight', async (_e, { question, mode } = {}) => {
  if (!councils) return { error: 'no folder is open' };
  if (mode !== 'light' && mode !== 'full') return { error: 'a council is light or full' };
  if (!String(question ?? '').trim()) return { error: 'a council needs a question: /council <question>' };
  try {
    return await councils.preflight(String(question).trim(), mode);
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('council-run', (_e, { id, ...options } = {}) => councils?.run(id, options) ?? { error: 'no folder is open' });
ipcMain.handle('council-cancel', (_e, id) => councils?.cancel(id) ?? { error: 'no folder is open' });
ipcMain.handle('councils', () => councils?.list() ?? []);
ipcMain.handle('council-mission', (_e, id) => {
  const plan = councils?.toMission(id);
  if (!plan) return { error: 'no folder is open' };
  if (plan.error) return plan;
  if (!missions) return { error: 'missions are off in this folder' };
  return missions.fromPlan(plan.objective, plan.criteria, plan.plan, { sessionId });
});

ipcMain.on('open-external', (_e, url) => /^https?:\/\//.test(url) && shell.openExternal(url));

app.setAppUserModelId('dev.bananaosint.spark');
app.whenReady().then(() => {
  const theme = configuredTheme();
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'Spark',
    icon: join(resources, 'assets', 'sparky.ico'),
    backgroundColor: rgb(THEMES[theme].background.from),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: rgb(THEMES[theme].background.from), symbolColor: '#E8EDF7', height: 56 },
    webPreferences: { preload: join(here, 'preload.cjs') },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // In development the page's console goes to the terminal that started the app.
  if (!app.isPackaged) win.webContents.on('console-message', (e) => console.log(`[page] ${e.level}: ${e.message}`));
  win.loadFile(join(here, 'index.html'));
  win.on('closed', stopClaude);
});
app.on('window-all-closed', () => app.quit());
