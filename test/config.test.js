import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, configPath } from '../src/config.js';

test('config round-trips, and a missing file reads as empty', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'spark-config-')), 'spark', 'config.json');
  assert.deepEqual(loadConfig(path), {});
  saveConfig({ theme: 'teal' }, path);
  assert.deepEqual(loadConfig(path), { theme: 'teal' });
});

test('config lives under APPDATA', () => {
  assert.equal(configPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), join('C:\\Users\\x\\AppData\\Roaming', 'spark', 'config.json'));
});
