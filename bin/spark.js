#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { renderBanner } from '../src/banner.js';
import { sessionSettings, claudeArgs } from '../src/settings.js';
import { loadKey, saveKey, clearKey, defaultKeyPath } from '../src/key.js';
import { findModels } from '../src/doctor.js';
import { tryCommand, shellLine } from '../src/failure.js';
import { install, uninstall } from '../src/install.js';
import { createSkin } from '../src/skin.js';


const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDir = join(root, 'plugin');

const HELP = `spark: Claude Code with Gemini-cooked prompts

  spark [flags] [claude args]   start Claude Code in this folder
    --plain                     no banner, theme or spinner verbs
    --no-gemini                 send prompts as typed this session
    --direct                    run claude without Spark's terminal layer (Sparky in place of the crab)
    --                          pass everything after it to claude
  spark install                 add a Spark profile to Windows Terminal and Sparky shortcuts
  spark uninstall               remove them
  spark try <command>           run a command; if it fails, the Spark band offers to send it to Claude
  spark key set                 store your Gemini API key, encrypted for your Windows account
  spark key clear               delete the stored key
  spark doctor                  check claude, git, the key and the Gemini models

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

// Runs claude in a pseudo-terminal so its crab can be redrawn as Sparky on the way to the screen.
function runSkinned(pty, args, env) {
  const child = pty.spawn('claude.exe', args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: process.cwd(),
    env,
  });
  child.onData(createSkin((text) => process.stdout.write(text)));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => child.write(data));
  process.stdout.on('resize', () => child.resize(process.stdout.columns, process.stdout.rows));
  child.onExit(({ exitCode }) => {
    process.stdin.setRawMode(false);
    process.exit(exitCode);
  });
}

function run({ plain, gemini, direct, passthrough }) {
  const key = gemini ? loadKey() : undefined;
  if (!plain) {
    const state = !gemini ? 'gemini off' : key ? 'gemini on' : 'gemini off: run spark key set';
    console.log(`\n${renderBanner({ subline: `${basename(process.cwd())} · ${state}` })}\n`);
  }
  const env = { ...process.env };
  if (key) env.SPARK_GEMINI_KEY = key;
  if (plain) env.SPARK_PLAIN = '1';
  const args = claudeArgs({ pluginDir, settings: sessionSettings({ plain }), passthrough });
  const pty = plain || direct || !process.stdin.isTTY || !process.stdout.isTTY ? undefined : loadPty();
  if (pty) return runSkinned(pty, args, env);
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
  case 'install': {
    const { fragmentDir, shortcuts } = install({ pngPath: join(root, 'assets', 'sparky.png'), icoPath: join(root, 'assets', 'sparky.ico') });
    console.log(`Windows Terminal profile "Spark": ${fragmentDir}`);
    for (const lnk of shortcuts) console.log(`shortcut: ${lnk}`);
    console.log('Restart Windows Terminal to see the Spark profile.');
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
