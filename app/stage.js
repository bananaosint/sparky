// Copies what the app shares with the spark command into staged/: the launcher's
// modules, the Claude Code plugin and the assets. The plugin ships unpacked,
// since claude reads it from disk.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = dirname(fileURLToPath(import.meta.url));
const root = dirname(app);
const staged = join(app, 'staged');
const skip = [join('.claude-plugin', 'types'), 'test'];

rmSync(staged, { recursive: true, force: true });
cpSync(join(root, 'src'), join(staged, 'src'), { recursive: true });
cpSync(join(root, 'assets'), join(staged, 'assets'), { recursive: true });
cpSync(join(root, 'plugin'), join(staged, 'plugin'), {
  recursive: true,
  filter: (path) => !skip.some((s) => (relative(join(root, 'plugin'), path) + sep).startsWith(s + sep)),
});
console.log('staged src, assets and plugin');
