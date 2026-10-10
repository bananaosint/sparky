import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doubleTab } from '../lib/keys.js';

test('a second Tab within 600 ms is a double Tab; a slow one starts over', () => {
  const tab = doubleTab();
  assert.equal(tab(1000), false);
  assert.equal(tab(1500), true);
  assert.equal(tab(1600), false, 'the press after a double starts a new pair');
  assert.equal(tab(2300), false, '700 ms later is too slow');
  assert.equal(tab(2800), true);
});
