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
import { cookPrompt } from './lib/cook.js';

const here = dirname(fileURLToPath(import.meta.url));
// Installed, the plugin, assets and permission bridge sit beside the app as plain files.
const resources = app.isPackaged ? process.resourcesPath : join(here, 'staged');
const bridgeDir = app.isPackaged ? join(process.resourcesPath, 'bridge') : join(here, 'bridge');
const pluginDir = join(resources, 'plugin');
const REWRITE_MODELS = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig.rewrite_models.default.split(',');
// Tools that only change files: "auto-accept edits" lets these run without asking.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

let win;
let cwd;
let claude;
let sessionId;
let bridge;
let geminiKey;
let alwaysAllow = new Set();
// Permission questions waiting on the window, by id.
const pending = new Map();

const send = (channel, data) => win?.webContents.send(channel, data);
const rgb = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const isFolder = (path) => existsSync(path) && statSync(path).isDirectory();
const look = (theme) => ({ theme, sprite: grid(theme), glow: THEMES[theme].glow });

function settings() {
  const c = loadConfig();
  return { theme: configuredTheme(c), cook: c.cook !== false, autoEdits: c.autoEdits === true, hasKey: Boolean(geminiKey) };
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
      if (alwaysAllow.has(tool) || (EDIT_TOOLS.has(tool) && settings().autoEdits)) return answer({ allow: true });
      const id = randomBytes(6).toString('hex');
      pending.set(id, answer);
      send('permission', { id, tool, input });
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
    ...(resume ? ['--resume', resume] : []),
  ];
  const child = spawn('claude', args, { cwd, env: base.env, windowsHide: true });
  claude = child;
  let errors = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (claude !== child) return;
    for (const event of parseLine(line)) {
      if (event.kind === 'init') sessionId = event.sessionId;
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
  send('session', { ...look(base.theme), fresh: !resume, folder: basename(cwd), cwd, state: base.state, settings: settings() });
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
  if (!cwd) return app.quit();
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
  if (!folder) return;
  cwd = folder;
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
  try {
    return await cookPrompt(text, { key: geminiKey, models: REWRITE_MODELS });
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

ipcMain.handle('set-settings', (_e, { cook, autoEdits, key }) => {
  const config = loadConfig();
  saveConfig({ ...config, ...(cook === undefined ? {} : { cook }), ...(autoEdits === undefined ? {} : { autoEdits }) });
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
