"""Node env workers (the real game race loop) behind binary pipes.

Workers step in parallel: actions go out to every worker first, then results are read back.
"""
import json
import os
import subprocess
import sys
import threading

import numpy as np

BELOW_NORMAL = 0x00004000


class VecEnv:
    def __init__(self, root, config_path, workers, log=None):
        self.procs, self.hs, self.sizes, self.bufs = [], [], [], []
        self.stats, self.lock = [], threading.Lock()
        flags = BELOW_NORMAL if sys.platform == 'win32' else 0
        for i in range(workers):
            p = subprocess.Popen(['node', '--import', './scripts/json-loader.mjs', 'subjects/slipstream/env/worker.mjs', config_path, str(i)],
                                 cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, creationflags=flags)
            self.procs.append(p)
            threading.Thread(target=self._drain, args=(p, log), daemon=True).start()
        for p in self.procs:
            hs = json.loads(p.stdout.readline())
            self.hs.append(hs)
            self.sizes.append(hs['agents'])
            self.bufs.append(bytearray(hs['agents'] * hs['row'] * 4))
        h = self.hs[0]
        self.obs_dim, self.row = h['obs'], h['row']
        self.layout = dict(ego=h['ego'], roadK=h['roadK'], roadF=h['roadF'], rivalN=h['rivalN'], rivalF=h['rivalF'],
                           **({'egoX': h['egoX'], 'rivalX': h['rivalX']} if h.get('egoX') or h.get('rivalX') else {}))
        self.n = sum(self.sizes)
        self.offsets = np.cumsum([0] + self.sizes)

    def _drain(self, p, log):
        for line in p.stderr:
            line = line.decode(errors='replace').strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                rec = {'raw': line}
                if log:
                    log(rec)
            with self.lock:
                self.stats.append(rec)

    def take_stats(self):
        with self.lock:
            s, self.stats = self.stats, []
        return s

    def _read(self, i):
        p, buf = self.procs[i], self.bufs[i]
        mv, got = memoryview(buf), 0
        while got < len(buf):
            k = p.stdout.readinto(mv[got:])
            if not k:
                raise RuntimeError(f'worker {i} exited')
            got += k
        return np.frombuffer(buf, np.float32).reshape(self.sizes[i], self.row)

    def reset(self):
        return np.concatenate([self._read(i) for i in range(len(self.procs))])

    def step(self, actions):
        a = np.ascontiguousarray(actions, dtype=np.float32)
        for i, p in enumerate(self.procs):
            p.stdin.write(a[self.offsets[i]:self.offsets[i + 1]].tobytes())
        return np.concatenate([self._read(i) for i in range(len(self.procs))])

    def close(self):
        for p in self.procs:
            try:
                p.stdin.close()
            except OSError:
                pass
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
