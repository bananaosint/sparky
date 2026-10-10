// F9: spark scan. Known-vulnerable dependencies (osv-scanner), and text in the uncommitted
// changes that reads like instructions to an AI. Flagged for a person to read, never blocked:
// no detector for that is reliable.

const INSTRUCTION = [
  /\b(ignore|disregard|forget)\b.{0,20}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions|rules|prompts?)\b/i,
  /\byou are now\b/i,
  /\b(system|developer) (prompt|message|mode)\b/i,
  /<\/?(system|assistant|user|spark-[\w-]+)>/i,
  /\bdo not (tell|inform|mention)\b.{0,20}\buser\b/i,
  /\b(send|post|upload|exfiltrate)\b.{0,40}\b(tokens?|keys?|secrets?|credentials?|passwords?)\b/i,
];

const flagged = (line) => INSTRUCTION.some((p) => p.test(line));

// Added lines of a unified diff that read like instructions, with the file each is in.
export function flagInstructions(diff) {
  const found = [];
  let file = '';
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('+') && flagged(line.slice(1))) found.push({ file, line: line.slice(1) });
  }
  return found;
}

// `run(argv)` answers as spawnSync does; `read(path)` gives an untracked file's text.
export function scan({ run, read }) {
  const out = [];
  let found = false;
  const osv = run(['osv-scanner', '--recursive', '.']);
  if (osv.error) out.push("osv-scanner isn't installed: get it from https://github.com/google/osv-scanner/releases, then run spark scan again.");
  else {
    out.push(`${osv.stdout}${osv.stderr}`.trim());
    // 1 is osv-scanner's "vulnerabilities found"; other codes are its own errors, shown above.
    if (osv.status === 1) found = true;
  }
  const diff = run(['git', 'diff', 'HEAD']);
  const flags = diff.status === 0 ? flagInstructions(diff.stdout) : [];
  const untracked = run(['git', 'ls-files', '--others', '--exclude-standard', '-z']);
  for (const file of untracked.status === 0 ? untracked.stdout.split('\0').filter(Boolean) : []) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const line of text.split('\n')) if (flagged(line)) flags.push({ file, line: line.replace(/\r$/, '') });
  }
  if (flags.length) {
    found = true;
    out.push('Text in the changes that reads like instructions to an AI (check it before Claude reads it):');
    for (const f of flags) out.push(`⚑ ${f.file}: ${f.line.trim().slice(0, 160)}`);
  } else out.push('no instruction-like text in the changes');
  out.push('For a code review of the changes, run /security-review in a Spark session.');
  return { text: out.join('\n'), code: found ? 1 : 0 };
}
