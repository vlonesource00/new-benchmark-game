"""Progress file for the lab Jobs page (lab/jobs-api.mjs reads artifacts/gpu-jobs/<name>.json)."""
import json, os, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'artifacts' / 'gpu-jobs'


class JobProgress:
    def __init__(self, kind, name, total):
        ROOT.mkdir(parents=True, exist_ok=True)
        self.path = ROOT / f'{name}.json'
        self.state = {'kind': kind, 'name': name, 'pid': os.getpid(), 'startedAt': time.time() * 1e3, 'total': total, 'done': 0,
                      'status': 'running', 'detail': None, 'history': []}
        self._write()

    def update(self, done, detail=None, history=None, status='running', total=None):
        self.state.update({'done': done, 'detail': detail, 'status': status})
        if total is not None:
            self.state['total'] = total
        if history is not None:
            self.state['history'].append(history)
        self._write()

    def _write(self):
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.state))
        os.replace(tmp, self.path)
