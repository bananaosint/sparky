import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsed } from '../lib/elapsed.js';

test('the thread timer reads mm:ss under an hour and hh:mm:ss from an hour on', () => {
  assert.equal(elapsed(0), '00:00');
  assert.equal(elapsed(7_400), '00:07');
  assert.equal(elapsed(754_000), '12:34');
  assert.equal(elapsed(3_599_000), '59:59');
  assert.equal(elapsed(3_600_000), '01:00:00');
  assert.equal(elapsed(37_230_000), '10:20:30');
  assert.equal(elapsed(-5), '00:00');
});
