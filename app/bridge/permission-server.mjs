// Run by Claude Code as an MCP server over stdio. Each permission question goes
// to the Spark window over a local HTTP call carrying a per-session token.
import { createInterface } from 'node:readline';
import { handleMcp } from './mcp.js';

const { SPARK_BRIDGE_URL: url, SPARK_BRIDGE_TOKEN: token } = process.env;

async function approve(tool, input) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-spark-token': token },
      body: JSON.stringify({ tool, input }),
    });
    return res.ok ? await res.json() : { allow: false, message: `Spark answered HTTP ${res.status}` };
  } catch (err) {
    return { allow: false, message: `Spark could not be asked (${err.message})` };
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = await handleMcp(msg, approve);
  if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
