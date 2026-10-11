// Claude Code runs headless in stream-json mode. These turn its output lines into
// what the window shows, and the window's messages into its input lines.

const resultText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '')).join('\n')
      : '';

// One output line becomes zero or more events for the window.
export function parseLine(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (j.type === 'system' && j.subtype === 'init')
    return [{ kind: 'init', sessionId: j.session_id, model: j.model, skills: j.skills ?? [], apiKeySource: j.apiKeySource }];
  if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta')
    return [{ kind: 'delta', text: j.event.delta.text }];
  if (j.type === 'assistant')
    return (j.message?.content ?? []).flatMap((b) =>
      b.type === 'text' ? [{ kind: 'text', text: b.text }] : b.type === 'tool_use' ? [{ kind: 'tool', id: b.id, name: b.name, input: b.input ?? {} }] : [],
    );
  if (j.type === 'user' && Array.isArray(j.message?.content))
    return j.message.content
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ kind: 'tool-result', id: b.tool_use_id, output: resultText(b.content), isError: Boolean(b.is_error) }));
  if (j.type === 'result')
    return [
      {
        kind: 'result',
        ok: j.subtype === 'success' && !j.is_error,
        text: j.result ?? '',
        costUsd: j.total_cost_usd ?? 0,
        durationMs: j.duration_ms ?? 0,
        usage: {
          input: j.usage?.input_tokens ?? 0,
          output: j.usage?.output_tokens ?? 0,
          cacheRead: j.usage?.cache_read_input_tokens ?? 0,
          cacheWrite: j.usage?.cache_creation_input_tokens ?? 0,
        },
      },
    ];
  if (j.type === 'control_response')
    return [{ kind: 'control', id: j.response?.request_id, ok: j.response?.subtype === 'success', error: j.response?.error }];
  return [];
}

// Switches the running session's model; without one it goes back to the account default.
export const setModel = (id, model) =>
  JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_model', ...(model ? { model } : {}) } });

// Switches the running session's permission mode: missions draft in 'plan' and go back to 'default'.
export const setPermissionMode = (id, mode) => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode } });

// A user message: pasted images first, then the text.
export const userMessage = ({ text = '', images = [] }) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        ...(text ? [{ type: 'text', text }] : []),
      ],
    },
  });
