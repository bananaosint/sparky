const SPINNER_VERBS = [
  'Sparking',
  'Igniting',
  'Kindling',
  'Arcing',
  'Flaring',
  'Fusing',
  'Striking',
  'Tempering',
  'Smelting',
  'Crackling',
];

import { THEMES } from './palettes.js';

export function sessionSettings({ plain = false, theme = 'ultraviolet' } = {}) {
  const settings = {
    env: {
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
    },
  };
  if (!plain) {
    settings.theme = `custom:spark:${THEMES[theme].ccTheme}`;
    settings.spinnerVerbs = { mode: 'replace', verbs: SPINNER_VERBS };
  }
  return settings;
}

export function claudeArgs({ pluginDir, settings, passthrough }) {
  return ['--plugin-dir', pluginDir, '--settings', JSON.stringify(settings), ...passthrough];
}
