import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// A SKILL.md's description, from its front matter: one line, quoted or not.
export function skillDescription(markdown) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? '';
  const line = /^description:\s*(.*)$/m.exec(front)?.[1]?.trim() ?? '';
  return line.replace(/^(['"])(.*)\1$/, '$2');
}

const read = (path) => (existsSync(path) ? skillDescription(readFileSync(path, 'utf8')) : '');
// Installed skills are often links to a shared folder, so links count as folders.
const dirs = (path) =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
    : [];
const newest = (versions) => versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);

// The skills Claude Code will offer, read from disk: the person's own and those of enabled plugins.
export function listSkills(home) {
  const own = join(home, '.claude', 'skills');
  let enabled = {};
  try {
    enabled = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins ?? {};
  } catch {}
  const fromPlugins = Object.entries(enabled)
    .filter(([, on]) => on)
    .flatMap(([id]) => {
      const [plugin, market] = id.split('@');
      const base = join(home, '.claude', 'plugins', 'cache', market, plugin);
      const version = newest(dirs(base));
      const skills = version ? join(base, version, 'skills') : '';
      return version ? dirs(skills).filter((s) => existsSync(join(skills, s, 'SKILL.md'))).map((s) => `${plugin}:${s}`) : [];
    });
  return [...dirs(own).filter((s) => existsSync(join(own, s, 'SKILL.md'))), ...fromPlugins];
}

// Claude Code names its skills (`name` or `plugin:name`); Gemini needs what each is for.
export function describeSkills(names, home) {
  const plugins = join(home, '.claude', 'plugins', 'cache');
  return names.map((name) => {
    const [plugin, skill] = name.includes(':') ? name.split(':') : [undefined, name];
    if (!plugin) return { name, description: read(join(home, '.claude', 'skills', skill, 'SKILL.md')) };
    for (const market of dirs(plugins))
      for (const version of dirs(join(plugins, market, plugin)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        const description = read(join(plugins, market, plugin, version, 'skills', skill, 'SKILL.md'));
        if (description) return { name, description };
      }
    return { name, description: '' };
  });
}
