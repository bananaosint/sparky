import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSettings, claudeArgs } from '../src/settings.js';

test('session settings select the plugin theme and spark spinner verbs', () => {
  const s = sessionSettings();
  assert.equal(s.theme, 'custom:spark:spark');
  assert.equal(s.spinnerVerbs.mode, 'replace');
  assert.ok(s.spinnerVerbs.verbs.includes('Sparking'));
});

test('session settings cap subagent depth and concurrency', () => {
  const { env } = sessionSettings();
  assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
  assert.equal(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '2');
});

test('plain mode drops the theme and spinner verbs', () => {
  const s = sessionSettings({ plain: true });
  assert.equal(s.theme, undefined);
  assert.equal(s.spinnerVerbs, undefined);
});

test('claude args load the plugin, pass settings inline, then the passthrough', () => {
  const args = claudeArgs({ pluginDir: 'C:\\spark\\plugin', settings: { a: 1 }, passthrough: ['-c'] });
  assert.deepEqual(args, ['--plugin-dir', 'C:\\spark\\plugin', '--settings', '{"a":1}', '-c']);
});
