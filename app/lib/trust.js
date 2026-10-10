// Headless Claude Code skips its "do you trust this folder?" question, so Spark asks
// it: a folder's own Claude Code settings, hooks and MCP servers run only once trusted.

const normal = (folder) => folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export const isTrusted = (config, folder) => (config.trustedFolders ?? []).some((f) => normal(f) === normal(folder));

export const trust = (config, folder) =>
  isTrusted(config, folder) ? config : { ...config, trustedFolders: [...(config.trustedFolders ?? []), folder] };

// Untrusted: only the person's own settings, and no MCP servers but Spark's permission bridge.
export const sessionGuard = (mode) => (mode === 'trusted' ? [] : ['--setting-sources', 'user', '--strict-mcp-config']);
