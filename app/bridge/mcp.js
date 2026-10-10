// The permission bridge: a tiny MCP server Claude Code asks before using a tool
// (--permission-prompt-tool mcp__spark__approve). It asks the Spark window.

export const APPROVE_TOOL = {
  name: 'approve',
  description: 'Asks the person using Spark whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

// One JSON-RPC message in, its reply out (undefined for notifications).
export async function handleMcp(msg, approve) {
  if (msg.id === undefined) return undefined;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'spark', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [APPROVE_TOOL] });
    case 'tools/call': {
      if (msg.params?.name !== APPROVE_TOOL.name) return fail(-32602, `no tool ${msg.params?.name}`);
      const { tool_name: tool, input = {} } = msg.params.arguments ?? {};
      const decision = await approve(tool, input);
      const answer = decision.allow
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: decision.message ?? 'The person using Spark said no.' };
      return reply({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
    default:
      return fail(-32601, `no method ${msg.method}`);
  }
}
