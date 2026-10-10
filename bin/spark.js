#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { prepareSession, configuredTheme } from '../src/session.js';
import { loadKey, saveKey, clearKey, defaultKeyPath } from '../src/key.js';
import { findModels } from '../src/doctor.js';
import { tryCommand, shellLine } from '../src/failure.js';
import { install, uninstall, writeFragment, installPaths } from '../src/install.js';
import { frames, playIntro } from '../src/intro.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { THEME_NAMES } from '../src/palettes.js';
import { createSkin } from '../src/skin.js';
import { translatePaste } from '../src/paste.js';
import { scan } from '../src/scan.js';
import { codeMap } from '../src/map.js';


const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDir = join(root, 'plugin');

const HELP = `spark: Claude Code with Gemini-cooked prompts

  spark [flags] [claude args]   start Claude Code in this folder
    --plain                     no banner, theme or spinner verbs
    --no-gemini                 send prompts as typed this session
    --no-tests                  don't run the tests when Claude ends a turn that changed files
    --direct                    skip Spark's terminal layer (Claude Code's own mascot shows again)
    --no-anim                   show Sparky without the startup animation
    --                          pass everything after it to claude
  spark theme [name]            show or set the look: ultraviolet (default) or teal
  spark install                 add a Spark profile to Windows Terminal and Sparky shortcuts
  spark uninstall               remove them
  spark try <command>           run a command; if it fails, the Spark band offers to send it to Claude
  spark key set                 store your Gemini API key, encrypted for your Windows account
  spark key clear               delete the stored key
  spark doctor                  check claude, git, the key and the Gemini models
  spark map                     the calls between functions in JS/TS files changed since the last snapshot
  spark scan                    vulnerable dependencies (osv-scanner) and AI-instruction-like text in your changes

In a session: Enter cooks the prompt, Enter again sends it.
Start a prompt with \\ to send it as typed.`;

function modelDefaults() {
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  return [manifest.userConfig.rewrite_models.default, manifest.userConfig.route_models.default].flatMap((list) => list.split(','));
}

// The native pseudo-terminal module; without it Spark runs claude directly.
function loadPty() {
  try {
    return createRequire(import.meta.url)('@lydell/node-pty');
  } catch {
    return undefined;
  }
}


const assetPath = (name) => join(root, 'assets', name);

// Runs claude in a pseudo-terminal so its mascot can be redrawn as Sparky on the way
// to the screen. Its output waits while the intro plays; claude starts meanwhile.
async function runSkinned(pty, args, env, theme, intro) {
  const child = pty.spawn('claude.exe', args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: process.cwd(),
    env,
  });
  let held = [];
  child.onData(createSkin((text) => (held ? held.push(text) : process.stdout.write(text)), { theme }));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  // Keys go through in order; a Ctrl+V waits for the clipboard check before anything after it.
  let keys = Promise.resolve();
  process.stdin.on('data', (data) => {
    keys = keys.then(async () => child.write(await translatePaste(data)));
  });
  process.stdout.on('resize', () => child.resize(process.stdout.columns, process.stdout.rows));
  child.onExit(({ exitCode }) => {
    process.stdin.setRawMode(false);
    process.exit(exitCode);
  });
  await intro();
  for (const text of held) process.stdout.write(text);
  held = undefined;
}

function run({ plain, gemini, tests, direct, animate, passthrough }) {
  const { args, env, theme, state } = prepareSession({ pluginDir, plain, gemini, tests, passthrough });
  const intro = plain ? undefined : frames({ theme, subline: `${basename(process.cwd())} · ${state}` });
  const showIntro = async () => {
    if (!intro) return;
    if (animate && process.stdout.isTTY && !process.env.NO_COLOR) await playIntro(intro);
    else console.log(intro.at(-1));
  };
  const pty = plain || direct || !process.stdin.isTTY || !process.stdout.isTTY ? undefined : loadPty();
  if (pty) return runSkinned(pty, args, env, theme, showIntro);
  if (intro) console.log(intro.at(-1));
  const child = spawn('claude', args, {
    stdio: 'inherit',
    env,
  });
  // Ctrl+C reaches every process on the console; Claude Code handles it, the launcher must not die.
  process.on('SIGINT', () => {});
  child.on('error', (err) => {
    console.error(`spark: could not start claude (${err.message}). Is Claude Code installed and on PATH?`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

function readHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') process.exit(130);
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function keySet() {
  if (!process.stdin.isTTY) {
    console.error('spark key set needs an interactive terminal.');
    process.exit(1);
  }
  const key = await readHidden('Gemini API key (input hidden): ');
  if (!key) {
    console.error('No key entered; nothing changed.');
    process.exit(1);
  }
  saveKey(key);
  console.log(`Saved to ${defaultKeyPath()} (encrypted for your Windows account).`);
  console.log('Use a key from a billing-enabled Google project: on the free tier Google may use prompts to improve its products and human reviewers may read them.');
}

function version(cmd) {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

async function doctor() {
  const report = (ok, text) => console.log(`${ok ? '✔' : '✖'} ${text}`);
  const claude = version('claude');
  report(Boolean(claude), claude ? `claude ${claude}` : 'claude not found on PATH');
  const git = version('git');
  report(Boolean(git), git ?? 'git not found on PATH');
  const key = loadKey();
  report(Boolean(key), key ? 'Gemini key stored' : 'no Gemini key: run spark key set');
  if (!key) return;
  try {
    const started = Date.now();
    const found = await findModels({ key, wanted: modelDefaults() });
    for (const [id, ok] of Object.entries(found)) report(ok, `${id} ${ok ? 'available' : 'not available to this key'}`);
    console.log(`  model list answered in ${Date.now() - started} ms`);
  } catch (err) {
    report(false, err.message);
  }
}

const args = parseArgs(process.argv.slice(2));
switch (args.command) {
  case 'run':
    run(args);
    break;
  case 'key-set':
    await keySet();
    break;
  case 'key-clear':
    clearKey();
    console.log('Gemini key removed.');
    break;
  case 'doctor':
    await doctor();
    break;
  case 'map': {
    const runGit = async (argv, init = {}) => {
      const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    try {
      console.log(await codeMap({ run: runGit, read: (path) => readFileSync(path, 'utf8') }));
    } catch (err) {
      console.error(`spark map needs a git repo: ${err.message}`);
      process.exitCode = 1;
    }
    break;
  }
  case 'scan': {
    const { text, code } = scan({
      run: (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
      read: (path) => readFileSync(path, 'utf8'),
    });
    console.log(text);
    process.exitCode = code;
    break;
  }
  case 'install': {
    const theme = configuredTheme();
    const { fragmentDir, shortcuts } = install({
      pngPath: assetPath('sparky.png'),
      icoPath: assetPath('sparky.ico'),
      theme,
      background: assetPath(`bg-${theme}.png`),
    });
    console.log(`Windows Terminal profile "Spark": ${fragmentDir}`);
    for (const lnk of shortcuts) console.log(`shortcut: ${lnk}`);
    console.log('Restart Windows Terminal to see the Spark profile.');
    break;
  }
  case 'theme': {
    if (!args.name) {
      console.log(`theme: ${configuredTheme()} (choices: ${THEME_NAMES.join(', ')})`);
      break;
    }
    if (!THEME_NAMES.includes(args.name)) {
      console.error(`spark: no theme "${args.name}"; choices: ${THEME_NAMES.join(', ')}`);
      process.exit(1);
    }
    saveConfig({ ...loadConfig(), theme: args.name });
    if (existsSync(join(installPaths().fragmentDir, 'spark.json')))
      writeFragment({ pngPath: assetPath('sparky.png'), theme: args.name, background: assetPath(`bg-${args.name}.png`) });
    console.log(`theme: ${args.name}. New spark sessions use it; restart Windows Terminal to change its background.`);
    break;
  }
  case 'uninstall':
    uninstall();
    console.log('Spark profile and shortcuts removed.');
    break;
  case 'try': {
    const { exitCode, recorded } = await tryCommand({ command: shellLine(args.argv) });
    if (exitCode !== 0 && !recorded) console.error('spark: not in a git repo, so the Spark band will not see this failure.');
    process.exit(exitCode);
  }
  default:
    if (args.error) console.error(args.error);
    console.log(HELP);
    process.exit(args.error ? 1 : 0);
}
