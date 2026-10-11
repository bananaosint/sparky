// Missions on disk, under the folder's .spark/: missions/<id>/{mission.json,events.jsonl,report.json}
// and the plugin's gate.jsonl. A repo can ship its own .spark/, so whatever is read back is
// checked before it is used.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asMission, asRecord, isMissionId, parseGateLines } from '../staged/plugin/hooks/mission.ts';

const json = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

const records = (path) =>
  (existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []).flatMap((line) => {
    try {
      const r = asRecord(JSON.parse(line));
      return r ? [r] : [];
    } catch {
      return [];
    }
  });

export function createStore(root) {
  const missions = join(root, '.spark', 'missions');
  const gateFile = join(root, '.spark', 'gate.jsonl');
  const dir = (id) => {
    if (!isMissionId(id)) throw new Error(`not a mission id: ${id}`);
    return join(missions, id);
  };
  // A crash mid-write leaves the old file, never half of the new one.
  const replace = (path, text) => {
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  };
  const load = (id) => {
    const mission = asMission(json(join(missions, id, 'mission.json')));
    return mission?.id === id ? mission : undefined;
  };

  return {
    save(mission) {
      mkdirSync(dir(mission.id), { recursive: true });
      replace(join(dir(mission.id), 'mission.json'), `${JSON.stringify(mission, null, 2)}\n`);
    },
    append(id, record) {
      mkdirSync(dir(id), { recursive: true });
      appendFileSync(join(dir(id), 'events.jsonl'), `${JSON.stringify(record)}\n`);
    },
    saveReport(id, report) {
      replace(join(dir(id), 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    },
    // Newest first, since ids start with the date. A folder whose mission.json doesn't check out
    // is listed as unreadable rather than hidden.
    list() {
      const ids = existsSync(missions) ? readdirSync(missions).filter(isMissionId) : [];
      return ids.sort((a, b) => b.localeCompare(a)).map((id) => load(id) ?? { id, unreadable: true });
    },
    read(id) {
      if (!isMissionId(id)) return undefined;
      const mission = load(id);
      if (!mission) return undefined;
      const report = json(join(missions, id, 'report.json'));
      return { mission, records: records(join(missions, id, 'events.jsonl')), report: report && typeof report === 'object' ? report : undefined };
    },
    gateSize: () => (existsSync(gateFile) ? statSync(gateFile).size : 0),
    // Lines the plugin added since `offset`. A half-written last line waits for the next look; a
    // file that shrank was started over, so it is read from the top.
    gateSince(offset) {
      if (!existsSync(gateFile)) return { records: [], offset };
      const size = statSync(gateFile).size;
      const from = size < offset ? 0 : offset;
      if (size === from) return { records: [], offset: from };
      const buffer = Buffer.alloc(size - from);
      const fd = openSync(gateFile, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, from);
      } finally {
        closeSync(fd);
      }
      const text = buffer.toString('utf8');
      const whole = text.slice(0, text.lastIndexOf('\n') + 1);
      return { records: parseGateLines(whole), offset: from + Buffer.byteLength(whole) };
    },
  };
}

// .spark/ stays out of git, as the plugin does for .spark/out.
export function excludeSpark(excludeFile) {
  const now = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (now.split(/\r?\n/).includes('.spark/')) return;
  mkdirSync(dirname(excludeFile), { recursive: true });
  writeFileSync(excludeFile, `${now}${now && !now.endsWith('\n') ? '\n' : ''}.spark/\n`);
}
