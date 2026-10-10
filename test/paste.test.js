import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePaste, ALT_V } from '../src/paste.js';

const yes = async () => true;
const no = async () => false;

test('Ctrl+V with an image on the clipboard becomes the image-paste key', async () => {
  assert.equal(await translatePaste('\x16', yes), ALT_V);
  assert.equal(await translatePaste('\x1b[200~\x1b[201~', yes), ALT_V);
});

test('without an image, or for any other input, keys pass through untouched', async () => {
  assert.equal(await translatePaste('\x16', no), '\x16');
  assert.equal(await translatePaste('\x1b[200~text\x1b[201~', yes), '\x1b[200~text\x1b[201~');
  assert.equal(await translatePaste('v', yes), 'v');
});

test('other keys never wait on the clipboard check', async () => {
  let asked = false;
  await translatePaste('a', async () => (asked = true));
  assert.equal(asked, false);
});
