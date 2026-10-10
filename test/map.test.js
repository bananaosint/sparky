import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callGraph, codeMap } from '../src/map.js';
import { takeSnapshot } from '../plugin/hooks/snapshot.ts';
import { parseArgs } from '../src/args.js';

const CART = `import { price } from './price.ts'

export function total(items) {
  return items.reduce((sum, i) => sum + price(i), 0)
}

export const checkout = async (cart) => {
  if (!cart.items.length) throw new Error('empty')
  const t = total(cart.items)
  return { t, tax: tax(t) }
}

const tax = (amount) => amount * 0.2
`;

const PRICE = `export function price(item) {
  return round(item.cents * item.qty)
}

function round(n) {
  return Math.round(n) / 100
}

class Coupon {
  apply(cart) {
    return price(cart.items[0]) - this.value
  }
}
`;

test('calls between functions in the changed files become edges, across files too', () => {
  assert.deepEqual(callGraph({ 'src/cart.js': CART, 'src/price.ts': PRICE }), [
    { from: 'src/cart.js:total', to: 'src/price.ts:price' },
    { from: 'src/cart.js:checkout', to: 'src/cart.js:total' },
    { from: 'src/cart.js:checkout', to: 'src/cart.js:tax' },
    { from: 'src/price.ts:price', to: 'src/price.ts:round' },
    { from: 'src/price.ts:apply', to: 'src/price.ts:price' },
  ]);
});

test("another file's function is a callee only when the caller imports that file", () => {
  const files = { 'a.js': 'export function run() {\n  return fetch(url)\n}\n', 'test/mock.js': 'export function fetch() {}\n' };
  assert.deepEqual(callGraph(files, ['a.js']), []);
});

test('keywords, unknown functions and strings are not calls', () => {
  const src = 'function a() {\n  if (x) return console.log("b() is not a call")\n  for (const y of z) b()\n}\nfunction b() {}\n';
  assert.deepEqual(callGraph({ 'm.js': src }), [{ from: 'm.js:a', to: 'm.js:b' }]);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'spark-map-'));
  const run = async (argv, init = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd ?? dir, env: { ...process.env, ...init.env }, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false };
  };
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'price.ts'), PRICE);
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, run, read: (p) => readFileSync(p, 'utf8') };
}

test('spark map draws the graph of JS/TS files changed since the last snapshot', async () => {
  const { dir, run, read } = repo();
  await takeSnapshot(run, 'before');
  writeFileSync(join(dir, 'src', 'cart.js'), CART);
  writeFileSync(join(dir, 'README.md'), '# shop, now with carts\n');
  const text = await codeMap({ run, read });
  assert.equal(
    text,
    [
      'Calls in the 1 JS/TS file changed since snapshot turn-1:',
      'src/cart.js',
      '  checkout → total, tax',
      '  total → price (src/price.ts)',
    ].join('\n'),
  );
});

test('without a snapshot there is nothing to compare with, and the map says so', async () => {
  const { run, read } = repo();
  assert.equal(await codeMap({ run, read }), 'No snapshot yet: Spark takes one before each prompt in a session. Run spark map after a turn.');
});

test('spark map is a command', () => {
  assert.deepEqual(parseArgs(['map']), { command: 'map' });
});
