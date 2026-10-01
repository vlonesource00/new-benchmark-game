import json

with open('artifacts/stage05a-harbor.json') as f:
    d = json.load(f)
c = d['sections']['candidate']
v = c['v']
dL = c['dL']
n = len(v)

with open('artifacts/track-geometry.json') as f:
    tg = json.load(f)
s = tg['s']

complexes = [
  {'id': 'MAIN_STRAIGHT', 'name': 'Main Straight', 'sStart': 0, 'sEnd': 850},
  {'id': 'EAST_HAIRPIN', 'name': 'East Hairpin', 'sStart': 850, 'sEnd': 1150},
  {'id': 'EAST_EXIT', 'name': 'East Exit', 'sStart': 1150, 'sEnd': 1350},
  {'id': 'CONTAINER_ESSES', 'name': 'Container Esses', 'sStart': 1350, 'sEnd': 1600},
  {'id': 'MID_COMPLEX', 'name': 'Mid Complex', 'sStart': 1600, 'sEnd': 1950},
  {'id': 'WEST_LOOP', 'name': 'West Loop', 'sStart': 1950, 'sEnd': 2350},
  {'id': 'FINAL_CHICANE', 'name': 'Final Chicane', 'sStart': 2350, 'sEnd': 2650},
  {'id': 'FINAL_EXIT', 'name': 'Final Exit', 'sStart': 2650, 'sEnd': 2704.62}
]

print(f"Total candidate time: {c['time']:.3f} s")
print(f"{'Complex':18} | {'Time (s)':>8} | {'Min Spd':>8} | {'Max Spd':>8}")
print('-' * 52)
L_total = 2704.6192
ds_cand = L_total / n

for comp in complexes:
    t = 0.0
    vs = []
    for i in range(n):
        st = i * ds_cand
        if comp['sStart'] <= st < comp['sEnd']:
            t += dL[i] / v[i]
            vs.append(v[i])
    min_spd = min(vs)*3.6 if vs else 0
    max_spd = max(vs)*3.6 if vs else 0
    print(f"{comp['name']:18} | {t:8.2f} | {min_spd:8.1f} | {max_spd:8.1f}")
