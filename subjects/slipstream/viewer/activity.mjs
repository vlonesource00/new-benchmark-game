// What is running on this machine right now, whatever launched it (a pipeline script, the queue, a one-off command):
// a scan of the process table, classified into pipelines, trainings, lap tests, race benchmarks, drills and other
// SLIPSTREAM jobs. Worker processes (env/worker.mjs, race children) fold into the job that owns them.
import { execFile } from 'node:child_process';

const PS = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='python.exe' or Name='bash.exe'\" | "
  + "Select-Object ProcessId,ParentProcessId,@{n='t';e={$_.CreationDate.ToString('o')}},CommandLine | ConvertTo-Json -Compress";

// [{ pid, ppid, start (ms), cmd }] from the OS process table.
function processes() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', PS], { windowsHide: true, timeout: 20000, maxBuffer: 1 << 24 }, (err, out) => {
        if (err) return resolve(null);
        let rows; try { rows = JSON.parse(out || '[]'); } catch { return resolve(null); }
        resolve([].concat(rows).filter((r) => r?.CommandLine).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, start: Date.parse(r.t), cmd: r.CommandLine })));
      });
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { timeout: 20000, maxBuffer: 1 << 24 }, (err, out) => {
        if (err) return resolve(null);
        resolve(out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
          .map((m) => ({ pid: +m[1], ppid: +m[2], start: Date.now() - 1000 * m[3], cmd: m[4] })));
      });
    }
  });
}

const words = (cmd) => (cmd.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, '').replace(/\\/g, '/'));
const flag = (w, k) => { const i = w.indexOf(`--${k}`); return i >= 0 ? w[i + 1] : undefined; };
const after = (w, re) => { const i = w.findIndex((x) => re.test(x)); return i >= 0 ? w.slice(i + 1) : []; };

// One process -> a job record, or null for processes that are not SLIPSTREAM work (or are another job's workers).
function classify(p) {
  const w = words(p.cmd), c = w.join(' ');
  if (/env\/worker\.mjs|viewer\/serve\.mjs/.test(c)) return null;
  if (/learner\/ppo\.py/.test(c)) return { kind: 'train', name: flag(w, 'name'), config: flag(w, 'config') };
  if (/learner\/complete\.py/.test(c)) return { kind: 'lap', name: flag(w, 'name') ?? 'completion', seed: flag(w, 'seed'), laps: flag(w, 'laps') ?? '1', tracks: flag(w, 'tracks') };
  if (/env\/racebench\.mjs/.test(c)) {
    const run = after(w, /^--run$/);
    if (run.length) return { kind: 'race', track: run[0], mode: run[1], seed: run[2] };
    return { kind: 'bench', label: flag(w, 'label'), mode: flag(w, 'mode') ?? 'short', tracks: (flag(w, 'tracks') ?? 'harbor-ring,solenne,alpine,desert').split(','),
      seeds: (flag(w, 'seeds') ?? '1,2,3,4,5').split(','), field: flag(w, 'field'), startType: flag(w, 'start'), policy: flag(w, 'policy') };
  }
  if (/env\/drill\.mjs/.test(c)) { const a = after(w, /env\/drill\.mjs$/); return { kind: 'drill', name: a[0], seed: a[2] }; }
  if (/env\/followeval\.mjs/.test(c)) { const a = after(w, /env\/followeval\.mjs$/); return { kind: 'follow', name: a[0], seed: a[2] }; }
  const sh = /\/(day\d+\w*)\.sh$/.exec(w.find((x) => /\.sh$/.test(x)) ?? '');
  if (sh && /bash/.test(w[0])) return { kind: 'pipeline', name: sh[1] };
  const script = w.find((x) => /subjects\/slipstream\/.*\.(mjs|py)$|^(env|learner|browser)\/.*\.(mjs|py)$/.test(x));
  return script ? { kind: 'other', name: script.replace(/^.*subjects\/slipstream\//, '') } : null;
}

// Jobs keyed by kind + name: a venv launcher and its interpreter, or a pipeline's subshells, show once (the oldest).
function jobs(ps) {
  const out = new Map(), races = [];
  for (const p of ps) {
    const j = classify(p); if (!j) continue;
    j.pid = p.pid; j.ppid = p.ppid; j.start = p.start;
    if (j.kind === 'race') { races.push(j); continue; }
    const key = [j.kind, j.name, j.label, j.seed].join('|'), have = out.get(key);
    if (!have || j.start < have.start) out.set(key, j);
  }
  // Race children belong to the suite that spawned them; an orphan race shows on its own.
  for (const r of races) {
    const suite = [...out.values()].find((j) => j.kind === 'bench' && j.pid === r.ppid);
    if (suite) (suite.racing ??= []).push(`${r.track} s${r.seed}`); else out.set(`race|${r.track}|${r.seed}`, { ...r, kind: 'bench', label: '(single race)', racing: [`${r.track} s${r.seed}`], tracks: [r.track], seeds: [r.seed], mode: r.mode });
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

// Scan every `everyMs`; the latest result is always available synchronously.
export function watchActivity(everyMs = 10000) {
  const state = { at: 0, jobs: [], ok: false };
  const scan = async () => { const ps = await processes(); if (ps) { state.jobs = jobs(ps); state.at = Date.now(); state.ok = true; } setTimeout(scan, everyMs); };
  scan();
  return state;
}
