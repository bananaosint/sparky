import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('no arguments means run', () => {
  assert.deepEqual(parseArgs([]), { command: 'run', plain: false, gemini: true, tests: true, direct: false, animate: true, passthrough: [] });
});

test('spark run strips the word run', () => {
  assert.equal(parseArgs(['run']).command, 'run');
});

test('spark flags are consumed, everything else passes through to claude', () => {
  assert.deepEqual(parseArgs(['--plain', '-c', '--no-gemini', '--no-tests', '--direct', '--model', 'opus']), {
    command: 'run',
    plain: true,
    gemini: false,
    tests: false,
    direct: true,
    animate: true,
    passthrough: ['-c', '--model', 'opus'],
  });
});

test('everything after -- passes through untouched, spark flags included', () => {
  assert.deepEqual(parseArgs(['--', '--plain']).passthrough, ['--plain']);
});

test('key subcommands', () => {
  assert.deepEqual(parseArgs(['key', 'set']), { command: 'key-set' });
  assert.deepEqual(parseArgs(['key', 'clear']), { command: 'key-clear' });
});

test('key without a valid action is help', () => {
  assert.deepEqual(parseArgs(['key']), { command: 'help', error: 'spark key needs set or clear' });
});

test('doctor and help', () => {
  assert.deepEqual(parseArgs(['doctor']), { command: 'doctor' });
  assert.deepEqual(parseArgs(['help']), { command: 'help' });
  assert.deepEqual(parseArgs(['--help']), { command: 'help' });
});

test('spark try takes the command to run, with or without --', () => {
  assert.deepEqual(parseArgs(['try', 'npm', 'test']), { command: 'try', argv: ['npm', 'test'] });
  assert.deepEqual(parseArgs(['try', '--', 'npm', 'test', '--', '-t', 'login']), { command: 'try', argv: ['npm', 'test', '--', '-t', 'login'] });
  assert.equal(parseArgs(['try']).error, 'spark try needs a command, e.g. spark try npm test');
});

test('theme subcommand and --no-anim', () => {
  assert.deepEqual(parseArgs(['theme']), { command: 'theme', name: undefined });
  assert.deepEqual(parseArgs(['theme', 'teal']), { command: 'theme', name: 'teal' });
  assert.equal(parseArgs(['--no-anim']).animate, false);
  assert.equal(parseArgs([]).animate, true);
});

test('install and uninstall subcommands', () => {
  assert.deepEqual(parseArgs(['install']), { command: 'install' });
  assert.deepEqual(parseArgs(['uninstall']), { command: 'uninstall' });
});
