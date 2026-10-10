import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const add = (...args) => spawnSync(process.execPath, ['add.js', ...args], { encoding: 'utf8' });

test('prints the sum of two numbers', () => {
  assert.equal(add('2', '3').stdout, '5\n');
  assert.equal(add('-1.5', '0.25').stdout, '-1.25\n');
});

test('rejects anything but two numbers', () => {
  for (const args of [['2'], ['2', 'x'], ['2', '3', '4']]) {
    const r = add(...args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: node add.js <a> <b>/);
  }
});
