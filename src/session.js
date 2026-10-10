import { sessionSettings, claudeArgs } from './settings.js';
import { loadKey } from './key.js';
import { loadConfig } from './config.js';
import { THEME_NAMES } from './palettes.js';

export const configuredTheme = (config = loadConfig()) => (THEME_NAMES.includes(config.theme) ? config.theme : 'ultraviolet');

// What a Spark session of Claude Code needs, for the spark command and the app alike:
// claude's arguments and environment, the theme, and a line saying whether Gemini is on.
export function prepareSession({
  pluginDir,
  plain = false,
  gemini = true,
  tests = true,
  passthrough = [],
  env = process.env,
  key = gemini ? loadKey() : undefined,
  theme = configuredTheme(),
}) {
  const childEnv = { ...env, SPARK_THEME: theme };
  if (key) childEnv.SPARK_GEMINI_KEY = key;
  if (plain) childEnv.SPARK_PLAIN = '1';
  if (!tests) childEnv.SPARK_NO_TESTS = '1';
  return {
    args: claudeArgs({ pluginDir, settings: sessionSettings({ plain, theme }), passthrough }),
    env: childEnv,
    theme,
    state: !gemini ? 'gemini off' : key ? 'gemini on' : 'gemini off: run spark key set',
  };
}
