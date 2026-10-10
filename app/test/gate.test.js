import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateNote } from '../lib/gate.js';

const ctx = { repo: 'C:/code/app', home: 'C:/Users/me' };

test("the window learns when Spark's gate wants the person asked, and why", () => {
  assert.equal(gateNote('Bash', { command: 'rm -rf dist' }, ctx), 'deletes dist');
  assert.equal(gateNote('PowerShell', { command: 'git reset --hard' }, ctx), 'git reset --hard discards uncommitted changes');
  assert.equal(gateNote('Bash', { command: 'npm test' }, ctx), undefined);
  assert.equal(gateNote('Edit', { file_path: 'C:/code/app/a.js' }, ctx), undefined);
});
