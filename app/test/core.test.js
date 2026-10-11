import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, userMessage, setModel, setPermissionMode } from '../lib/stream.js';
import { handleMcp } from '../bridge/mcp.js';
import { cookPrompt } from '../lib/cook.js';

test('stream-json lines become window events', () => {
  assert.deepEqual(parseLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}'), [{ kind: 'init', sessionId: 's1', model: 'm', skills: [], apiKeySource: undefined }]);
  assert.deepEqual(
    parseLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}'),
    [{ kind: 'delta', text: 'hi' }],
  );
  assert.deepEqual(
    parseLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } })),
    [{ kind: 'text', text: 'Done.' }, { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
  );
  assert.deepEqual(
    parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: true }] } })),
    [{ kind: 'tool-result', id: 't1', output: 'ok', isError: true }],
  );
  assert.deepEqual(parseLine('{"type":"result","subtype":"success","result":"hi","total_cost_usd":0.01,"duration_ms":900}'), [
    { kind: 'result', ok: true, text: 'hi', costUsd: 0.01, durationMs: 900, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ]);
  assert.deepEqual(parseLine('{"type":"rate_limit_event"}'), []);
  assert.deepEqual(parseLine('not json'), []);
});

test('a user message puts pasted images before the text', () => {
  const msg = JSON.parse(userMessage({ text: 'match this', images: [{ mediaType: 'image/png', data: 'AAAA' }] }));
  assert.deepEqual(msg.message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'match this' },
  ]);
});

test('control responses become events, and set_model asks for a model by alias', () => {
  assert.deepEqual(parseLine('{"type":"control_response","response":{"subtype":"success","request_id":"sw1"}}'), [{ kind: 'control', id: 'sw1', ok: true, error: undefined }]);
  assert.deepEqual(
    parseLine('{"type":"control_response","response":{"subtype":"error","request_id":"sw2","error":"Model \'x\' not found"}}'),
    [{ kind: 'control', id: 'sw2', ok: false, error: "Model 'x' not found" }],
  );
  assert.deepEqual(JSON.parse(setModel('sw1', 'opus')), { type: 'control_request', request_id: 'sw1', request: { subtype: 'set_model', model: 'opus' } });
  assert.deepEqual(JSON.parse(setModel('sw2')), { type: 'control_request', request_id: 'sw2', request: { subtype: 'set_model' } });
});

test('the permission bridge speaks MCP and relays the decision', async () => {
  const init = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, null);
  assert.equal(init.result.serverInfo.name, 'spark');
  assert.equal((await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, null)).result.tools[0].name, 'approve');
  assert.equal(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, null), undefined);
  const call = (allow) =>
    handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } } }, async (tool, input) => {
      assert.equal(tool, 'Bash');
      assert.deepEqual(input, { command: 'ls' });
      return { allow };
    });
  assert.deepEqual(JSON.parse((await call(true)).result.content[0].text), { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.equal(JSON.parse((await call(false)).result.content[0].text).behavior, 'deny');
  assert.equal((await handleMcp({ jsonrpc: '2.0', id: 4, method: 'nope' }, null)).error.code, -32601);
});

const answer = (json) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });

test('cooking rewrites through the model chain, retrying a failing model before moving on', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    const model = url.match(/models\/([^:]+):/)[1];
    asked.push(model);
    return model === 'slow' ? { ok: false, status: 503 } : answer({ prompt: 'Add a dark mode toggle.', unclear: [], role: 'a lighting wizard' });
  };
  const out = await cookPrompt('add dark mode', { key: 'k', rewriteModels: ['slow', 'fast'], pickSkills: false, fetchImpl });
  assert.deepEqual(asked, ['slow', 'slow', 'slow', 'fast']);
  assert.equal(
    out.text,
    'Act as a lighting wizard.\n\n(Gemini (fast) rewrote this prompt from what I typed. If part of it seems to contradict what I meant, ask me.)\n\nAdd a dark mode toggle.',
  );
  assert.equal(out.model, 'fast');
});

test('a refused key stops cooking at once', async () => {
  await assert.rejects(cookPrompt('add dark mode', { key: 'bad', rewriteModels: ['a', 'b'], pickSkills: false, fetchImpl: async () => ({ ok: false, status: 403 }) }), /refused the key/);
});

test('setPermissionMode is a control request Claude Code answers by id', () => {
  assert.deepEqual(JSON.parse(setPermissionMode('mission-plan', 'plan')), { type: 'control_request', request_id: 'mission-plan', request: { subtype: 'set_permission_mode', mode: 'plan' } });
});
