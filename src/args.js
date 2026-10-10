export function parseArgs(argv) {
  const [first, second] = argv;
  if (first === 'help' || first === '--help' || first === '-h') return { command: 'help' };
  if (first === 'doctor') return { command: 'doctor' };
  if (first === 'key') {
    if (second === 'set') return { command: 'key-set' };
    if (second === 'clear') return { command: 'key-clear' };
    return { command: 'help', error: 'spark key needs set or clear' };
  }

  const rest = first === 'run' ? argv.slice(1) : argv;
  const run = { command: 'run', plain: false, gemini: true, passthrough: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') {
      run.passthrough.push(...rest.slice(i + 1));
      break;
    }
    if (arg === '--plain') run.plain = true;
    else if (arg === '--no-gemini') run.gemini = false;
    else run.passthrough.push(arg);
  }
  return run;
}
