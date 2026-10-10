import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveKey, loadKey, clearKey } from '../src/key.js';

const isWindows = process.platform === 'win32';

test('a saved key loads back and is not stored as plain text', { skip: !isWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-key-'));
  const file = join(dir, 'gemini.key');
  try {
    saveKey('AIza-test-key-123', file);
    assert.ok(!readFileSync(file).toString('latin1').includes('AIza-test-key-123'));
    assert.equal(loadKey(file), 'AIza-test-key-123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loading a missing key gives undefined', () => {
  assert.equal(loadKey(join(tmpdir(), 'spark-no-such-key')), undefined);
});

test('clearing removes the file and tolerates a missing one', { skip: !isWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-key-'));
  const file = join(dir, 'gemini.key');
  try {
    saveKey('k', file);
    clearKey(file);
    assert.equal(existsSync(file), false);
    clearKey(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
