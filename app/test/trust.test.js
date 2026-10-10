import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrusted, trust, sessionGuard, sessionEnv } from '../lib/trust.js';

test('a folder is trusted only once the person said so, whatever its spelling', () => {
  const config = trust({}, 'C:\\Code\\App\\');
  assert.equal(isTrusted(config, 'c:/code/app'), true);
  assert.equal(isTrusted(config, 'C:\\Code\\Other'), false);
  assert.equal(isTrusted({}, 'C:\\Code\\App'), false);
  assert.deepEqual(trust(config, 'C:/code/app').trustedFolders.length, 1);
});

test('an untrusted folder runs without its project settings, hooks or MCP servers', () => {
  assert.deepEqual(sessionGuard('trusted'), []);
  assert.deepEqual(sessionGuard('safe'), ['--setting-sources', 'user', '--strict-mcp-config']);
});

test("an untrusted folder's session tells Spark's mod so, which then runs none of the folder's scripts", () => {
  assert.deepEqual(sessionEnv('safe', { PATH: 'p' }), { PATH: 'p', SPARK_UNTRUSTED: '1' });
  assert.deepEqual(sessionEnv('trusted', { PATH: 'p' }), { PATH: 'p' });
});
