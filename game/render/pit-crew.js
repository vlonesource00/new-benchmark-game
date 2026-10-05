import * as THREE from 'three';
import { clamp } from '../engine/sim/math.js';

// Procedural pit crews. Each mechanic is a low-poly SkinnedMesh on an 11-bone
// rig (hips, spine, head, arms, legs) built at load time, so nothing is
// downloaded. Every team has six: four wheel men, a front jack man and a
// fueller. They stand at the garage line, step out to their marks when their
// car is in the lane, kneel and work the wheel guns through the stop (or stand
// by when the stop has no tyres) and walk back once the car is released.
// Crews out of camera range freeze and hide, so a full grid costs little.

// Bone: [name, parent, rest offset from parent (model space, figure faces +Z)].
const BONES = [
  ['hips', -1, [0, .95, 0]], ['spine', 0, [0, .08, 0]], ['head', 1, [0, .47, 0]],
  ['armL', 1, [.21, .41, 0]], ['foreL', 3, [0, -.29, 0]], ['armR', 1, [-.21, .41, 0]], ['foreR', 5, [0, -.29, 0]],
  ['legL', 0, [.1, -.04, 0]], ['shinL', 7, [0, -.43, 0]], ['legR', 0, [-.1, -.04, 0]], ['shinR', 9, [0, -.43, 0]]
];
const B = Object.fromEntries(BONES.map(([n], i) => [n, i]));

// Model-space rest positions of the bones.
const REST = [];
BONES.forEach(([, p, o], i) => { REST[i] = new THREE.Vector3(...o); if (p >= 0) REST[i].add(REST[p]); });

// One shared geometry: boxes and spheres skinned rigidly to a single bone, with
// a vertex colour group (0 overalls, 1 helmet, 2 dark kit) baked into `color`.
function crewGeometry() {
  const parts = [];
  const piece = (geo, bone, x, y, z, shade) => {
    geo = geo.toNonIndexed(); geo.translate(x, y, z);
    const n = geo.attributes.position.count;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0).map((_, k) => (k % 4 ? 0 : bone)), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, k) => (k % 4 ? 0 : 1)), 4));
    const c = [[1, 1, 1], [.92, .92, .9], [.09, .09, .1]][shade];
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(c).flat(), 3));
    delete geo.attributes.uv; parts.push(geo);
  };
  const r = (i) => REST[i];
  piece(new THREE.BoxGeometry(.34, .2, .2), B.hips, 0, r(B.hips).y - .02, 0, 0);
  piece(new THREE.BoxGeometry(.4, .46, .23), B.spine, 0, r(B.spine).y + .25, 0, 0);
  piece(new THREE.BoxGeometry(.3, .2, .05), B.spine, 0, r(B.spine).y + .32, .13, 2);           // chest panel
  piece(new THREE.SphereGeometry(.135, 10, 8), B.head, 0, r(B.head).y + .13, 0, 1);            // helmet
  piece(new THREE.BoxGeometry(.2, .07, .04), B.head, 0, r(B.head).y + .13, .125, 2);           // visor
  for (const [arm, fore] of [[B.armL, B.foreL], [B.armR, B.foreR]]) {
    const a = r(arm), f = r(fore);
    piece(new THREE.BoxGeometry(.11, .3, .11), arm, a.x, a.y - .14, 0, 0);
    piece(new THREE.BoxGeometry(.09, .27, .09), fore, f.x, f.y - .13, 0, 0);
    piece(new THREE.BoxGeometry(.1, .1, .1), fore, f.x, f.y - .3, 0, 2);                      // glove
  }
  for (const [leg, shin] of [[B.legL, B.shinL], [B.legR, B.shinR]]) {
    const l = r(leg), s = r(shin);
    piece(new THREE.BoxGeometry(.15, .44, .16), leg, l.x, l.y - .21, 0, 0);
    piece(new THREE.BoxGeometry(.13, .38, .13), shin, s.x, s.y - .2, 0, 0);
    piece(new THREE.BoxGeometry(.13, .08, .27), shin, s.x, s.y - .41, .05, 2);                 // boot
  }
  const merged = mergeParts(parts); merged.computeVertexNormals(); return merged;
}
function mergeParts(parts) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'skinIndex', 'skinWeight']) {
    const size = parts[0].attributes[name].itemSize, Arr = name === 'skinIndex' ? Uint16Array : Float32Array;
    const arr = new Arr(parts.reduce((n, g) => n + g.attributes[name].array.length, 0)); let o = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

// Poses: bone x-rotations (+ a few z) and hip height. Negative x swings a limb forward.
const POSES = {
  stand: { h: .95, spine: .02, armL: .05, foreL: -.15, armR: .05, foreR: -.15, legL: 0, shinL: 0, legR: 0, shinR: 0, armLz: .12, armRz: -.12 },
  ready: { h: .78, spine: .35, armL: -.7, foreL: -.6, armR: -.7, foreR: -.6, legL: -.55, shinL: .85, legR: -.25, shinR: .55, armLz: .05, armRz: -.05 },
  // Wheel gun: kneeling on the right knee, both hands forward at hub height.
  kneel: { h: .52, spine: .25, armL: -1.25, foreL: -.35, armR: -1.15, foreR: -.45, legL: -1.5, shinL: 1.5, legR: -.05, shinR: 1.62, armLz: .05, armRz: -.05 },
  // Jack: low crouch, arms pushing down and forward on the handle.
  jack: { h: .66, spine: .6, armL: -1.1, foreL: -.1, armR: -1.1, foreR: -.1, legL: -1.1, shinL: 1.7, legR: -.6, shinR: 1.1, armLz: .02, armRz: -.02 },
  // Fueller: standing braced, both arms up holding the rig into the car.
  fuel: { h: .93, spine: .12, armL: -1.35, foreL: -.5, armR: -1.05, foreR: -.85, legL: -.25, shinL: .2, legR: .2, shinR: .1, armLz: .05, armRz: -.1 }
};
const KEYS = Object.keys(POSES.stand);

const ROLES = ['wheel', 'wheel', 'wheel', 'wheel', 'jack', 'fuel'];

class Mechanic {
  constructor(geometry, material, role, wheel) {
    const bones = BONES.map(([name], i) => { const b = new THREE.Bone(); b.name = name; b.position.copy(REST[i]); if (BONES[i][1] >= 0) b.position.sub(REST[BONES[i][1]]); return b; });
    BONES.forEach(([, p], i) => { if (p >= 0) bones[p].add(bones[i]); });
    this.mesh = new THREE.SkinnedMesh(geometry, material);
    this.mesh.add(bones[0]); this.mesh.bind(new THREE.Skeleton(bones));
    // A fixed sphere that holds every pose stands in for the skinned bounds,
    // so crews off screen (or outside the sun's shadow box) are not drawn.
    this.mesh.castShadow = true; this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, .9, 0), 1.6);
    this.bones = bones; this.role = role; this.wheel = wheel;
    this.pose = { ...POSES.stand }; this.walk = 0; this.phase = Math.random() * 6; this.placed = false;
    this.pos = new THREE.Vector3(); this.yaw = 0;
  }
  /** Walk to (x, z), face `yaw`, settle into `pose`; `work` adds the gun/jack motion. */
  update(dt, x, z, yaw, pose, work) {
    if (!this.placed) { this.pos.set(x, 0, z); this.yaw = yaw; this.placed = true; }
    const dx = x - this.pos.x, dz = z - this.pos.z, d = Math.hypot(dx, dz), step = Math.min(d, 4.2 * dt);
    const moving = d > .08;
    if (moving) { this.pos.x += dx / d * step; this.pos.z += dz / d * step; }
    const face = moving && d > .6 ? Math.atan2(dx, dz) : yaw;
    this.yaw += Math.atan2(Math.sin(face - this.yaw), Math.cos(face - this.yaw)) * Math.min(1, dt * 9);
    this.walk = moving ? this.walk + dt * 9.5 : 0;
    const target = POSES[moving ? 'stand' : pose], k = Math.min(1, dt * (moving ? 10 : 7));
    for (const key of KEYS) this.pose[key] += (target[key] - this.pose[key]) * k;
    this.phase += dt;
    const p = this.pose, b = this.bones, swing = moving ? Math.sin(this.walk) * .6 : 0;
    const bob = moving ? Math.abs(Math.cos(this.walk)) * .05 : Math.sin(this.phase * 1.7) * .006;
    // Wheel gun: a buzz in the forearms; jack: a slow pump; fuel: a steady lean.
    const buzz = work && this.role === 'wheel' ? Math.sin(this.phase * 55) * .05 : 0;
    const pump = work && this.role === 'jack' ? Math.sin(this.phase * 7) * .18 : 0;
    this.mesh.position.set(this.pos.x, p.h - .95 + bob, this.pos.z);
    this.mesh.rotation.y = this.yaw;
    b[B.spine].rotation.x = p.spine + pump * .3;
    b[B.head].rotation.x = -p.spine * .6;
    b[B.armL].rotation.set(p.armL - swing * .8 + pump, 0, p.armLz);
    b[B.armR].rotation.set(p.armR + swing * .8 + pump, 0, p.armRz);
    b[B.foreL].rotation.x = p.foreL + buzz;
    b[B.foreR].rotation.x = p.foreR - buzz;
    b[B.legL].rotation.x = p.legL + swing;
    b[B.legR].rotation.x = p.legR - swing;
    b[B.shinL].rotation.x = p.shinL + Math.max(0, -Math.sin(this.walk)) * (moving ? .9 : 0);
    b[B.shinR].rotation.x = p.shinR + Math.max(0, Math.sin(this.walk)) * (moving ? .9 : 0);
  }
}

export class PitCrews {
  constructor(parent, track, lane, teams) {
    this.track = track; this.lane = lane; this.group = new THREE.Group(); this.group.name = 'Pit crews'; parent.add(this.group);
    this.geometry = crewGeometry();
    this.crews = new Map();
    teams.forEach((team, i) => {
      const s = lane.boxes[i]; if (s == null) return;
      const material = new THREE.MeshStandardMaterial({ color: team.color, vertexColors: true, roughness: .7 });
      const box = track.at(s, lane.boxLat), g = track.at(s, lane.boxLat + lane.side);
      // Unit vector from the box towards the garages, and the idle line along their front.
      const gx = g.x - box.x, gz = g.z - box.z;
      const idle = ROLES.map((_, k) => track.at(s + (k - 2.5) * 1.15, lane.boxLat + lane.side * (4.3 + (k % 2) * .9)));
      const members = ROLES.map((role, k) => { const m = new Mechanic(this.geometry, material, role, k); this.group.add(m.mesh); return m; });
      this.crews.set(team.id, { members, box, gx, gz, idle, material });
    });
  }
  /**
   * `snap` is the race snapshot, `cars` the sim cars (for their exact stopped
   * pose) and `eye` the camera position for range culling.
   */
  update(snap, cars, dt, eye) {
    if (!snap) return;
    dt = clamp(dt, 0, .1);
    for (const c of snap.cars) {
      const crew = this.crews.get(c.team); if (!crew) continue;
      const near = Math.hypot(eye.x - crew.box.x, eye.z - crew.box.z) < 260;
      crew.members.forEach((m) => { m.mesh.visible = near; });
      if (!near) continue;
      const car = cars[c.id], h = crew.box.heading, gx = crew.gx, gz = crew.gz, toLane = Math.atan2(-gx, -gz);
      // The car's own frame once it is stopped, else the box marking's.
      const servicing = c.pit === 'service';
      const ox = servicing ? c.x : crew.box.x, oz = servicing ? c.z : crew.box.z, yaw = servicing ? c.yaw : h;
      const cfx = Math.sin(yaw), cfz = Math.cos(yaw), crx = Math.cos(yaw), crz = -Math.sin(yaw);
      const spec = car?.spec ?? { wheelbase: 2.7, track: 1.7, frontWeight: .5 };
      const out = c.pit === 'service' ? 'work' : c.pit === 'lane' || c.pit === 'approach' && c.boxCalled ? 'ready' : 'idle';
      const plan = c.plan ?? {}, tyres = Boolean(plan.tyres), fuel = (plan.litres ?? 0) > .5;
      crew.members.forEach((m, k) => {
        let lx, lz, pose = 'stand', facing = toLane, work = false;
        if (out === 'idle') { const p = crew.idle[k]; m.update(dt, p.x, p.z, toLane, 'stand', false); return; }
        if (m.role === 'wheel') {
          const front = k < 2, wside = k % 2 ? 1 : -1;
          const wz = front ? (1 - spec.frontWeight) * spec.wheelbase : -spec.frontWeight * spec.wheelbase;
          lx = wside * (spec.track / 2 + (out === 'work' && tyres ? .62 : 1.5)); lz = wz;
          facing = yaw - wside * Math.PI / 2; pose = out === 'work' ? (tyres ? 'kneel' : 'stand') : 'ready'; work = out === 'work' && tyres;
        } else if (m.role === 'jack') {
          lx = 0; lz = (1 - spec.frontWeight) * spec.wheelbase + (out === 'work' ? 1.75 : 3.2); facing = yaw + Math.PI;
          pose = out === 'work' ? 'jack' : 'ready'; work = out === 'work';
        } else {
          // Fueller: on the garage side of the car, behind the cockpit.
          const d = spec.track / 2 + (out === 'work' && fuel ? .75 : 1.6);
          m.update(dt, ox + gx * d - cfx * .6, oz + gz * d - cfz * .6, toLane, out === 'work' && fuel ? 'fuel' : 'stand', false); return;
        }
        m.update(dt, ox + crx * lx + cfx * lz, oz + crz * lx + cfz * lz, facing, pose, work);
      });
    }
  }
  dispose() {
    this.group.parent?.remove(this.group);
    this.geometry.dispose(); for (const c of this.crews.values()) c.material.dispose();
  }
}
