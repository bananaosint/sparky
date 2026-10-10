import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSession, configuredTheme } from '../src/session.js';

test('a session hands claude the plugin, the theme and the key, and says gemini is on', () => {
  const s = prepareSession({ pluginDir: 'C:\\spark\\plugin', key: 'k', theme: 'teal', env: { PATH: 'p' } });
  assert.deepEqual(s.args.slice(0, 2), ['--plugin-dir', 'C:\\spark\\plugin']);
  assert.equal(JSON.parse(s.args[3]).theme, 'custom:spark:spark-teal');
  assert.deepEqual(s.env, { PATH: 'p', SPARK_THEME: 'teal', SPARK_GEMINI_KEY: 'k' });
  assert.equal(s.state, 'gemini on');
});

test('without a key, or with gemini off, the session says so; plain marks the env', () => {
  assert.equal(prepareSession({ pluginDir: 'p', key: null, theme: 'ultraviolet', env: {} }).state, 'gemini off: run spark key set');
  assert.equal(prepareSession({ pluginDir: 'p', gemini: false, key: null, theme: 'ultraviolet', env: {} }).state, 'gemini off');
  assert.equal(prepareSession({ pluginDir: 'p', plain: true, key: null, theme: 'ultraviolet', env: {} }).env.SPARK_PLAIN, '1');
  assert.equal(prepareSession({ pluginDir: 'p', tests: false, key: null, theme: 'ultraviolet', env: {} }).env.SPARK_NO_TESTS, '1');
  assert.equal(prepareSession({ pluginDir: 'p', key: null, theme: 'ultraviolet', env: {} }).env.SPARK_NO_TESTS, undefined);
});

test('an unknown configured theme falls back to ultraviolet', () => {
  assert.equal(configuredTheme({ theme: 'teal' }), 'teal');
  assert.equal(configuredTheme({ theme: 'neon' }), 'ultraviolet');
  assert.equal(configuredTheme({}), 'ultraviolet');
});
