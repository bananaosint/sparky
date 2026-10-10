import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SCHEME = {
  name: 'Spark',
  background: '#0B0A1F',
  foreground: '#E2E8F0',
  cursorColor: '#A78BFA',
  selectionBackground: '#312E81',
  black: '#0B0A1F',
  red: '#FB7185',
  green: '#4ADE80',
  yellow: '#FACC15',
  blue: '#60A5FA',
  purple: '#A78BFA',
  cyan: '#38BDF8',
  white: '#CBD5E1',
  brightBlack: '#475569',
  brightRed: '#FDA4AF',
  brightGreen: '#86EFAC',
  brightYellow: '#FDE68A',
  brightBlue: '#93C5FD',
  brightPurple: '#C4B5FD',
  brightCyan: '#7DF9FF',
  brightWhite: '#F8FAFC',
};

// A Windows Terminal fragment: a "Spark" profile with Sparky as its icon, and the Spark colors.
export function wtFragment(iconPath) {
  return {
    profiles: [
      {
        name: 'Spark',
        commandline: 'powershell.exe -NoLogo -NoExit -Command spark',
        icon: iconPath,
        tabTitle: 'Spark',
        suppressApplicationTitle: true,
        colorScheme: 'Spark',
        font: { face: 'Cascadia Code', size: 11 },
        padding: '14, 10',
        cursorShape: 'bar',
        tabColor: '#6366F1',
        startingDirectory: '%USERPROFILE%',
      },
    ],
    schemes: [SCHEME],
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

export function install({ pngPath, icoPath, paths = installPaths() }) {
  mkdirSync(paths.fragmentDir, { recursive: true });
  writeFileSync(join(paths.fragmentDir, 'spark.json'), JSON.stringify(wtFragment(pngPath), null, 2));
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
