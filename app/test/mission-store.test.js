import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, excludeSpark } from '../lib/mission-store.js';
import { newMission } from '../staged/plugin/hooks/mission.ts';

const folder = () => mkdtempSync(join(tmpdir(), 'spark-store-'));
const made = (at = new Date(2026, 9, 10, 12).getTime(), hex = 'beef') => newMission('rate-limit login', at, hex, 0);

test('a mission and its records round-trip, and no temp file is left behind', () => {
  const root = folder();
  const store = createStore(root);
  const { mission, record } = made();
  store.save(mission);
  store.append(mission.id, record);
  store.append(mission.id, { at: 5, kind: 'you', text: 'per account, please' });
  const back = store.read(mission.id);
  assert.deepEqual(back.mission, mission);
  assert.deepEqual(back.records, [record, { at: 5, kind: 'you', text: 'per account, please' }]);
  assert.deepEqual(readdirSync(join(root, '.spark', 'missions', mission.id)).sort(), ['events.jsonl', 'mission.json']);
});

test('list is newest first, and broken or mismatched folders are listed as unreadable', () => {
  const root = folder();
  const store = createStore(root);
  const older = made(new Date(2026, 9, 9, 12).getTime(), 'aaaa').mission;
  const newer = made(new Date(2026, 9, 10, 12).getTime(), 'bbbb').mission;
  store.save(older);
  store.save(newer);
  const broken = 'm-20261008-120000-cccc';
  mkdirSync(join(root, '.spark', 'missions', broken), { recursive: true });
  writeFileSync(join(root, '.spark', 'missions', broken, 'mission.json'), '{ nope');
  const moved = 'm-20261007-120000-dddd';
  mkdirSync(join(root, '.spark', 'missions', moved), { recursive: true });
  writeFileSync(join(root, '.spark', 'missions', moved, 'mission.json'), JSON.stringify(newer));
  mkdirSync(join(root, '.spark', 'missions', 'not-a-mission'), { recursive: true });
  assert.deepEqual(
    store.list().map((m) => [m.id, Boolean(m.unreadable)]),
    [
      [newer.id, false],
      [older.id, false],
      [broken, true],
      [moved, true],
    ],
  );
});

test('ids that are not mission ids never reach the disk', () => {
  const store = createStore(folder());
  assert.equal(store.read('..\\..\\x'), undefined);
  assert.throws(() => store.append('../x', { at: 1, kind: 'you', text: 'x' }), /not a mission id/);
});

test('a shipped mission.json is cleaned: a hostile sha or session id is dropped', () => {
  const root = folder();
  const { mission } = made();
  mkdirSync(join(root, '.spark', 'missions', mission.id), { recursive: true });
  writeFileSync(
    join(root, '.spark', 'missions', mission.id, 'mission.json'),
    JSON.stringify({ ...mission, title: '<img src=x onerror=alert(1)>', startSha: '--output=C:/x', sessionId: 'x; rm -rf /' }),
  );
  const back = createStore(root).read(mission.id).mission;
  assert.equal(back.title, '<img src=x onerror=alert(1)>');
  assert.equal(back.startSha, undefined);
  assert.equal(back.sessionId, undefined);
});

test('a check record with an unknown status or no name is dropped, so it can never count toward a verdict', () => {
  const root = folder();
  const store = createStore(root);
  const { mission } = made();
  store.save(mission);
  const good = { at: 2, kind: 'check', name: 'tests', command: 'npm test', status: 'pass', exit: 0 };
  for (const r of [{ at: 1, kind: 'verify', again: false }, good, { at: 3, kind: 'check', name: 'lint', status: 'great' }, { at: 4, kind: 'check', status: 'pass' }]) store.append(mission.id, r);
  assert.deepEqual(store.read(mission.id).records, [{ at: 1, kind: 'verify', again: false }, good]);
});

test('gateSince reads only whole lines after the offset, and starts over if the file shrank', () => {
  const root = folder();
  const store = createStore(root);
  assert.equal(store.gateSize(), 0);
  mkdirSync(join(root, '.spark'), { recursive: true });
  const file = join(root, '.spark', 'gate.jsonl');
  writeFileSync(file, `${JSON.stringify({ at: 1, check: 'tests', ok: true })}\n`);
  const offset = store.gateSize();
  appendFileSync(file, `${JSON.stringify({ at: 2, check: 'tests', ok: false, exit: 1 })}\n{"at":3,"check":"te`);
  const first = store.gateSince(offset);
  assert.deepEqual(first.records, [{ at: 2, kind: 'gate', check: 'tests', ok: false, exit: 1 }]);
  appendFileSync(file, 'sts","ok":true}\n');
  assert.deepEqual(store.gateSince(first.offset).records, [{ at: 3, kind: 'gate', check: 'tests', ok: true }]);
  writeFileSync(file, `${JSON.stringify({ at: 9, check: 'halt', ok: false })}\n`);
  assert.deepEqual(store.gateSince(first.offset + 500).records, [{ at: 9, kind: 'gate', check: 'halt', ok: false }]);
});

test('excludeSpark adds .spark/ once', () => {
  const file = join(folder(), 'info', 'exclude');
  excludeSpark(file);
  excludeSpark(file);
  assert.equal(readFileSync(file, 'utf8'), '.spark/\n');
});
