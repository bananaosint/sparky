import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES } from './palettes.js';

const SCHEMES = [
  {
    name: 'Spark',
    background: '#0B0D14',
    foreground: '#E8EDF7',
    cursorColor: '#A78BFA',
    selectionBackground: '#312E81',
    black: '#0B0D14',
    red: '#FF647C',
    green: '#55E6A5',
    yellow: '#FFC66D',
    blue: '#4385FF',
    purple: '#A66BFF',
    cyan: '#38E8FF',
    white: '#CBD5E1',
    brightBlack: '#475569',
    brightRed: '#FDA4AF',
    brightGreen: '#86EFAC',
    brightYellow: '#FDE68A',
    brightBlue: '#93C5FD',
    brightPurple: '#C4B5FD',
    brightCyan: '#7DF9FF',
    brightWhite: '#F8FAFC',
  },
  {
    name: 'Spark Teal',
    background: '#03120F',
    foreground: '#E2F5F0',
    cursorColor: '#39FF14',
    selectionBackground: '#0F4C3F',
    black: '#03120F',
    red: '#FF647C',
    green: '#39FF14',
    yellow: '#FFC66D',
    blue: '#38BDF8',
    purple: '#A78BFA',
    cyan: '#5EEAD4',
    white: '#CBD5E1',
    brightBlack: '#2F4F4A',
    brightRed: '#FDA4AF',
    brightGreen: '#86EFAC',
    brightYellow: '#FDE68A',
    brightBlue: '#93C5FD',
    brightPurple: '#C4B5FD',
    brightCyan: '#99F6E4',
    brightWhite: '#F8FAFC',
  },
];

// A Windows Terminal fragment: a "Spark" profile with Sparky as its icon, the
// theme's gradient as its background, and both Spark color schemes.
export function wtFragment(iconPath, theme, background) {
  return {
    profiles: [
      {
        name: 'Spark',
        commandline: 'powershell.exe -NoLogo -NoExit -Command spark',
        icon: iconPath,
        tabTitle: 'Spark',
        suppressApplicationTitle: true,
        colorScheme: THEMES[theme].scheme,
        backgroundImage: background,
        backgroundImageStretchMode: 'uniformToFill',
        backgroundImageOpacity: 1,
        font: { face: 'Cascadia Code', size: 11 },
        padding: '14, 10',
        cursorShape: 'bar',
        tabColor: '#6366F1',
        startingDirectory: '%USERPROFILE%',
      },
    ],
    schemes: SCHEMES,
  };
}

export function installPaths(env = process.env) {
  const startMenu = join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return {
    fragmentDir: join(env.LOCALAPPDATA, 'Microsoft', 'Windows Terminal', 'Fragments', 'Spark'),
    shortcuts: [join(startMenu, 'Spark.lnk'), join(env.USERPROFILE, 'Desktop', 'Spark.lnk')],
    wt: join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe'),
  };
}

// Paths go in as environment variables so no quoting reaches PowerShell.
const SHORTCUT_PS =
  '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SPARK_LNK);' +
  '$s.TargetPath = $env:SPARK_WT; $s.Arguments = \'-p "Spark"\';' +
  '$s.IconLocation = "$env:SPARK_ICO,0"; $s.Description = "Spark: Claude Code with Sparky"; $s.Save()';

export function writeFragment({ pngPath, theme, background, paths = installPaths() }) {
  mkdirSync(paths.fragmentDir, { recursive: true });
  writeFileSync(join(paths.fragmentDir, 'spark.json'), JSON.stringify(wtFragment(pngPath, theme, background), null, 2));
}

export function install({ pngPath, icoPath, theme, background, paths = installPaths() }) {
  writeFragment({ pngPath, theme, background, paths });
  for (const lnk of paths.shortcuts) {
    mkdirSync(join(lnk, '..'), { recursive: true });
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHORTCUT_PS], {
      env: { ...process.env, SPARK_LNK: lnk, SPARK_WT: paths.wt, SPARK_ICO: icoPath },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  return paths;
}

export function uninstall(paths = installPaths()) {
  rmSync(paths.fragmentDir, { recursive: true, force: true });
  for (const lnk of paths.shortcuts) rmSync(lnk, { force: true });
  return paths;
}
