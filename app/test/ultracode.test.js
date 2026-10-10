import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionModelArgs, reviewDue, REVIEW_PASS } from '../lib/ultracode.js';

const done = (over = {}) => ({ kind: 'result', ok: true, text: 'Added the export.', ...over });

test('UltraCode runs its model at max effort, whatever the effort bar says', () => {
  assert.deepEqual(sessionModelArgs({ model: 'ultracode', ultraModel: 'fable', effort: 'low' }), ['--model', 'fable', '--effort', 'max']);
  assert.deepEqual(sessionModelArgs({ model: 'opus', ultraModel: 'fable', effort: 'high' }), ['--model', 'opus', '--effort', 'high']);
  assert.deepEqual(sessionModelArgs({ model: 'default', ultraModel: 'fable', effort: 'default' }), []);
});

test('Gemini and Auto answer in the window, so the Claude session keeps its arguments', () => {
  assert.equal(sessionModelArgs({ model: 'gemini', ultraModel: 'fable', effort: 'high' }), undefined);
  assert.equal(sessionModelArgs({ model: 'auto', ultraModel: 'fable', effort: 'high' }), undefined);
});

test('a turn that edited nothing (a question, a slash command) gets no review pass', () => {
  assert.equal(reviewDue({ model: 'ultracode', fromUser: true, marathon: false, edited: false }, done()), false);
});

test('one review pass follows a turn the person started, in UltraCode only', () => {
  const reviewDueEdited = (s, e) => reviewDue({ edited: true, ...s }, e);
  assert.equal(reviewDueEdited({ model: 'ultracode', fromUser: true, marathon: false }, done()), true);
  assert.equal(reviewDueEdited({ model: 'ultracode', fromUser: false, marathon: false }, done()), false, 'never a review of a review');
  assert.equal(reviewDueEdited({ model: 'opus', fromUser: true, marathon: false }, done()), false);
  assert.equal(reviewDueEdited({ model: 'ultracode', fromUser: true, marathon: true }, done()), false, 'a marathon has its own passes');
  assert.equal(reviewDueEdited({ model: 'ultracode', fromUser: true, marathon: false }, done({ ok: false })), false);
  assert.equal(reviewDueEdited({ model: 'ultracode', fromUser: true, marathon: false }, done({ text: 'Which file?' })), false, 'a question waits for the person');
  assert.equal(reviewDueEdited({ model: 'ultracode', fromUser: true, marathon: false }, { kind: 'text', text: 'x' }), false);
  assert.match(REVIEW_PASS, /reply "Nothing found\."/);
});
