import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
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
import { cookPrompt, quickAnswer } from './lib/cook.js';
import { describeSkills, listSkills } from './lib/skills.js';
import { payer } from './lib/account.js';
import { homedir } from 'node:os';
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
// The Claude models the picker offers, as Claude Code's --model aliases; 'gemini' answers in the window.
const CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku']);
// Tools that only change files: "auto-accept edits" lets these run without asking.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

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
    hasKey: Boolean(geminiKey),
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
      // A command Spark's gate holds is asked about every time: "always" can't cover it.
      const note = gateNote(tool, input, { repo: cwd, home: homedir() });
      if (!note && (alwaysAllow.has(tool) || (EDIT_TOOLS.has(tool) && settings().autoEdits))) return answer({ allow: true });
      const id = randomBytes(6).toString('hex');
      pending.set(id, answer);
      send('permission', { id, tool, input, note });
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}/approve`, token })));
}

function stopClaude() {
  const child = claude;
  claude = undefined;
  child?.kill();
  for (const answer of pending.values()) answer({ allow: false, message: 'Stopped from Spark.' });
  pending.clear();
}

// Claude Code runs headless: messages go in and events come out as JSON lines.
function startClaude({ resume } = {}) {
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
    ...(CLAUDE_MODELS.has(settings().model) ? ['--model', settings().model] : []),
    ...(settings().effort !== 'default' ? ['--effort', settings().effort] : []),
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
    }
  });
  child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-4000)));
  child.on('error', (err) => {
    if (claude !== child) return;
    claude = undefined;
    send('exit', { error: `Could not start Claude Code (${err.message}). Install it with: irm https://claude.ai/install.ps1 | iex` });
  });
  child.on('exit', (code) => {
    if (claude !== child) return;
    claude = undefined;
    send('exit', { code, error: errors.trim() || undefined });
  });
  win.setTitle(`Spark · ${basename(cwd)}`);
  const state = folderMode === 'safe' ? `${base.state} · project settings off` : base.state;
  send('session', { ...look(base.theme), fresh: !resume, folder: basename(cwd), cwd, state, settings: settings() });
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
  bridge ??= await startBridge();
  cwd = fromArgs ? resolve(fromArgs) : last && isFolder(last) ? last : await chooseFolder();
  folderMode = cwd && (await decideTrust(cwd));
  if (!folderMode) return app.quit();
  startClaude();
});

ipcMain.on('send-message', (_e, message) => {
  if (!claude) startClaude({ resume: sessionId });
  claude.stdin.write(`${userMessage(message)}\n`);
});

// Stopping ends the running turn; the conversation carries on in a fresh process.
ipcMain.on('stop', () => startClaude({ resume: sessionId }));

ipcMain.on('new-chat', () => {
  sessionId = undefined;
  alwaysAllow = new Set();
  startClaude();
});

ipcMain.on('open-folder', async () => {
  const folder = await chooseFolder();
  const mode = folder && (await decideTrust(folder));
  if (!mode) return;
  cwd = folder;
  folderMode = mode;
  sessionId = undefined;
  alwaysAllow = new Set();
  startClaude();
});

ipcMain.on('permission-answer', (_e, { id, tool, allow, always }) => {
  if (allow && always) alwaysAllow.add(tool);
  pending.get(id)?.({ allow });
  pending.delete(id);
});

ipcMain.handle('cook', async (_e, text) => {
  if (!geminiKey) return { error: 'no Gemini key; add one in settings' };
  const s = settings();
  try {
    return await cookPrompt(text, {
      key: geminiKey,
      rewrite: s.cook,
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

ipcMain.handle('toggle-theme', () => {
  const next = THEME_NAMES[(THEME_NAMES.indexOf(configuredTheme()) + 1) % THEME_NAMES.length];
  saveConfig({ ...loadConfig(), theme: next });
  win.setTitleBarOverlay({ color: rgb(THEMES[next].background.from), symbolColor: '#E8EDF7', height: 56 });
  return look(next);
});

ipcMain.handle('set-settings', (_e, { key, ...changes }) => {
  const before = settings();
  const known = ['cook', 'pickSkills', 'autoEdits', 'model', 'effort'];
  saveConfig({ ...loadConfig(), ...Object.fromEntries(Object.entries(changes).filter(([name, v]) => known.includes(name) && v !== undefined)) });
  const after = settings();
  // A different Claude model or effort takes a restart; the conversation carries on.
  const claudeChanged = (before.model !== after.model && CLAUDE_MODELS.has(after.model)) || before.effort !== after.effort;
  if (claudeChanged && cwd) startClaude({ resume: sessionId });
  if (key !== undefined) {
    if (key) saveKey(key);
    else clearKey();
    geminiKey = key || undefined;
  }
  return settings();
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
