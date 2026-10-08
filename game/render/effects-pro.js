import * as THREE from 'three';
import { clamp } from '../engine/sim/math.js';
import { smokeTexture } from './textures.js';

// Contact-patch tyre marks plus two particle pools: soft lit smoke/dust/spray
// (alpha-blended, textured, rotating) and hot sparks/embers (additive).
const SMOKE = 1400, SPARK = 500;

function pool(count, attributes) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of attributes) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * size), size).setUsage(THREE.DynamicDrawUsage));
  return g;
}

export class CarEffects {
  constructor(scene, capacity = 60000) {
    this.capacity = capacity; this.cursor = 0; this.count = 0; this.previous = new Map(); this.timer = 0;
    const geometry = pool(capacity * 6, [['position', 3], ['color', 4]]); geometry.setDrawRange(0, 0);
    this.marks = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.marks.frustumCulled = false; this.marks.renderOrder = 2; scene.add(this.marks);

    this.smoke = Array.from({ length: SMOKE }, () => ({ life: 0 })); this.nextSmoke = 0;
    this.smokeCloud = new THREE.Points(pool(SMOKE, [['position', 3], ['tint', 4], ['size', 1], ['spin', 1]]), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: smokeTexture() }, pixelScale: { value: 400 }, sunDir: { value: new THREE.Vector3(.6, .5, .6) } },
      vertexShader: `attribute vec4 tint;attribute float size;attribute float spin;varying vec4 vTint;varying float vSpin;uniform float pixelScale;
        void main(){vTint=tint;vSpin=spin;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(size*pixelScale/max(1.,-p.z),0.,260.);}`,
      fragmentShader: `uniform sampler2D map;varying vec4 vTint;varying float vSpin;
        void main(){vec2 c=gl_PointCoord-.5;float s=sin(vSpin),k=cos(vSpin);vec2 uv=vec2(k*c.x-s*c.y,s*c.x+k*c.y)+.5;
          vec4 t=texture2D(map,uv);float a=t.a*vTint.a*(1.-smoothstep(.35,.5,length(c)));if(a<.004)discard;
          float shade=mix(.72,1.08,1.-gl_PointCoord.y);gl_FragColor=vec4(vTint.rgb*shade,a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    }));
    this.smokeCloud.frustumCulled = false; this.smokeCloud.renderOrder = 3; scene.add(this.smokeCloud);

    this.sparks = Array.from({ length: SPARK }, () => ({ life: 0 })); this.nextSpark = 0;
    this.sparkCloud = new THREE.Points(pool(SPARK, [['position', 3], ['tint', 4], ['size', 1]]), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { pixelScale: { value: 400 } },
      vertexShader: `attribute vec4 tint;attribute float size;varying vec4 vTint;uniform float pixelScale;
        void main(){vTint=tint;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(size*pixelScale/max(1.,-p.z),1.,40.);}`,
      fragmentShader: `varying vec4 vTint;void main(){float r=length(gl_PointCoord-.5)*2.;float a=pow(max(0.,1.-r),2.)*vTint.a;if(a<.01)discard;gl_FragColor=vec4(vTint.rgb*a,a);}`
    }));
    this.sparkCloud.frustumCulled = false; scene.add(this.sparkCloud);
    // Backfire light: always in the scene (intensity 0 when idle) so the light
    // count never changes and no material ever recompiles mid-race.
    this.flash = new THREE.PointLight('#ff8a3a', 0, 9, 2); this.flash.position.set(0, -50, 0); scene.add(this.flash);
    this.flashLevel = 0;
  }

  /** Exhaust backfire from render/exhaust.js: flame spit, sparks, smoke, light. */
  backfire(car, strength, kind) {
    const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
    for (const side of [-1, 1]) {
      // Side-exit pipes, as on the car model (body-local x = ±1.3, z = -.72).
      const lx = side * 1.3, lz = -.72;
      const x = car.x + c * lx + s * lz, z = car.z - s * lx + c * lz;
      const ox = c * side, oz = -s * side; // outward from the pipe
      const n = Math.round(3 + strength * (kind === 'bang' ? 16 : 8));
      for (let k = 0; k < n; k++) {
        const v = 3 + Math.random() * 7 * strength;
        this.spark(x, .3, z, ox * v - s * Math.random() * 3 + car.vx * .92, .3 + Math.random() * 1.4, oz * v - c * Math.random() * 3 + car.vz * .92,
          .1 + Math.random() * .16 * (.5 + strength), Math.random() < .3 ? [1, .85, .5] : [1, .45, .12], .1 + Math.random() * .12);
      }
      // Fireball core: a short, fat, bright point.
      this.spark(x + ox * .4, .3, z + oz * .4, ox * 2 + car.vx, 0, oz * 2 + car.vz, .05 + strength * .05, [1, .7, .35], .45 + strength * .7);
      if (strength > .5 || Math.random() < .3) this.emit(x + ox * .5, .35, z + oz * .5, [.28, .27, .26], .35 + strength * .4, .6 + strength * .6, car.vx * .6 + ox * 1.5, car.vz * .6 + oz * 1.5, .5, .12 + strength * .12);
    }
    if (strength * 3 >= this.flashLevel) {
      this.flash.position.set(car.x - s * 1.2, .7, car.z - c * 1.2);
      this.flashLevel = Math.max(this.flashLevel, 2 + strength * 10);
    }
  }

  reset() {
    this.previous.clear(); this.count = this.cursor = 0; this.marks.geometry.setDrawRange(0, 0);
    for (const p of this.smoke) p.life = 0; for (const p of this.sparks) p.life = 0;
  }
  emit(x, y, z, color, size, life, vx = 0, vz = 0, vy = .35, opacity = .3) {
    Object.assign(this.smoke[this.nextSmoke++ % SMOKE], { x, y, z, color, size, life, maxLife: life, vx, vz, vy, opacity, spin: Math.random() * 6.28, spinRate: (Math.random() - .5) * 1.4 });
  }
  spark(x, y, z, vx, vy, vz, life = .45, color = [1, .62, .22], size = .09) {
    Object.assign(this.sparks[this.nextSpark++ % SPARK], { x, y, z, vx, vy, vz, life, maxLife: life, color, size });
  }
  segment(a, b, width, opacity, tint) {
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < .035 || length > 5) return false;
    const nx = dz / length * width / 2, nz = -dx / length * width / 2;
    const corners = [[a.x - nx, a.z - nz], [a.x + nx, a.z + nz], [b.x - nx, b.z - nz], [b.x + nx, b.z + nz]];
    const g = this.marks.geometry, base = this.cursor * 6;
    [0, 2, 1, 1, 2, 3].forEach((index, j) => {
      g.attributes.position.setXYZ(base + j, corners[index][0], .044, corners[index][1]);
      g.attributes.color.setXYZW(base + j, tint[0], tint[1], tint[2], opacity);
    });
    g.attributes.position.addUpdateRange(base * 3, 18); g.attributes.color.addUpdateRange(base * 4, 24);
    this.cursor = (this.cursor + 1) % this.capacity; this.count = Math.min(this.capacity, this.count + 1); return true;
  }

  update(cars, dt, track, pixelHeight = 800) {
    this.smokeCloud.material.uniforms.pixelScale.value = pixelHeight * .65;
    this.flashLevel *= Math.exp(-dt * 38); if (this.flashLevel < .05) this.flashLevel = 0;
    this.flash.intensity = this.flashLevel;
    this.sparkCloud.material.uniforms.pixelScale.value = pixelHeight * .65;
    const wet = track.wetness || 0;
    this.timer += dt; const sample = this.timer >= .04;
    if (sample && dt > 0) {
      this.timer %= .04;
      const g = this.marks.geometry; let changed = false;
      for (const car of cars) {
        const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
        let previous = this.previous.get(car.id);
        if (!previous) { previous = { wheels: [], impact: car.impact || 0 }; this.previous.set(car.id, previous); }
        car.wheels.forEach((w, i) => {
          const point = { x: car.x + c * w.x + s * w.z, z: car.z - s * w.x + c * w.z };
          const surface = track.surface(point.x, point.z), slip = Math.abs(w.tyre.alpha) + Math.abs(w.tyre.kappa) * .6;
          const prev = previous.wheels[i];
          if (prev && w.load > 100 && car.speed > 2) {
            if ((surface.zone === 'asphalt' || surface.zone === 'kerb') && slip > .035) changed = this.segment(prev, point, .27, clamp(.03 + slip * .7, .03, .5), [.022, .02, .018]) || changed;
            else if (surface.zone === 'gravel' || surface.zone === 'grass') changed = this.segment(prev, point, .3, .22, surface.zone === 'grass' ? [.16, .14, .06] : [.28, .24, .18]) || changed;
          }
          if (car.speed > 6 && w.load > 100) {
            const back = i >= 2 ? 1 : .5;
            if (surface.zone === 'gravel') { this.emit(point.x, .2, point.z, [.62, .54, .42], .9, 2.4, car.vx * .08, car.vz * .08, .7, .34); if (Math.random() < .5) this.spark(point.x, .1, point.z, car.vx * .3 + (Math.random() - .5) * 3, 2 + Math.random() * 3, car.vz * .3 + (Math.random() - .5) * 3, .5, [.25, .2, .15], .06); }
            else if (surface.zone === 'grass') this.emit(point.x, .15, point.z, [.45, .42, .28], .6, 1.4, car.vx * .05, car.vz * .05, .3, .2);
            else if ((surface.wet ?? wet) > .12 && car.speed > 12) {
              // Spray from the water actually under the tyre: rears throw the tall rooster tail that hangs behind a
              // car (and blinds the one following), fronts a low fan; standing water adds a heavier splash.
              const lw = surface.wet ?? wet, mm = surface.water ?? lw, v = Math.min(1, car.speed / 70), rear = back === 1;
              if (rear || Math.random() < .5) this.emit(point.x, .2 + (rear ? .25 : 0), point.z, [.82, .87, .92], (.45 + lw * 1.1 + Math.min(1.5, mm) * .3) * (rear ? 1.5 : .9), .6 + lw * .9 * v + (rear ? .5 : 0),
                car.vx * (rear ? .12 : .05), car.vz * (rear ? .12 : .05), .5 + v * (rear ? 1.6 : .5), (.12 + lw * .22) * (.4 + v * .6));
              if (mm > .9 && Math.random() < .35) this.emit(point.x + (Math.random() - .5) * .6, .12, point.z + (Math.random() - .5) * .6, [.88, .92, .96], .3 + mm * .15, .35, car.vx * .3, car.vz * .3, 2.4, .35);
            }
            else if (slip > .2 && w.tyre.slipPower > 2500) this.emit(point.x, .22, point.z, [.86, .87, .88], .45 + slip * .8, 2.2, car.vx * .05, car.vz * .05, .55, clamp(slip * .55, .1, .45));
            // Kerb strikes throw a few sparks off the floor.
            if (surface.zone === 'kerb' && car.speed > 25 && Math.random() < .12) for (let k = 0; k < 3; k++) this.spark(point.x, .06, point.z, car.vx * .75 + (Math.random() - .5) * 4, .6 + Math.random() * 1.8, car.vz * .75 + (Math.random() - .5) * 4);
          }
          previous.wheels[i] = point;
        });
        const impact = car.impact || 0;
        if (impact > previous.impact + .015) for (let k = 0; k < 30; k++) this.spark(car.x + (Math.random() - .5) * 2, .4, car.z + (Math.random() - .5) * 2, car.vx * .4 + (Math.random() - .5) * 10, 1 + Math.random() * 4, car.vz * .4 + (Math.random() - .5) * 10, .6 + Math.random() * .4);
        previous.impact = impact;
      }
      if (changed) { g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.setDrawRange(0, this.count * 6); }
    }
    const sg = this.smokeCloud.geometry;
    for (let i = 0; i < SMOKE; i++) {
      const p = this.smoke[i]; p.life = Math.max(0, p.life - dt);
      if (p.life > 0) {
        const drag = Math.exp(-dt * 1.6); p.vx *= drag; p.vz *= drag; p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt; p.spin += p.spinRate * dt;
        const age = 1 - p.life / p.maxLife;
        sg.attributes.position.setXYZ(i, p.x, p.y, p.z); sg.attributes.tint.setXYZW(i, ...p.color, Math.min(1, age * 8) * (1 - age) * p.opacity);
        sg.attributes.size.setX(i, p.size * (1 + age * 4)); sg.attributes.spin.setX(i, p.spin);
      } else { sg.attributes.size.setX(i, 0); sg.attributes.tint.setW(i, 0); }
    }
    for (const a of Object.values(sg.attributes)) a.needsUpdate = true;
    const kg = this.sparkCloud.geometry;
    for (let i = 0; i < SPARK; i++) {
      const p = this.sparks[i]; p.life = Math.max(0, p.life - dt);
      if (p.life > 0) {
        p.vy -= 9.8 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; if (p.y < .02) { p.y = .02; p.vy *= -.35; p.vx *= .6; p.vz *= .6; }
        const k = p.life / p.maxLife;
        kg.attributes.position.setXYZ(i, p.x, p.y, p.z); kg.attributes.tint.setXYZW(i, p.color[0] * 3, p.color[1] * (1.2 + k * 1.5), p.color[2] * k * 2, k); kg.attributes.size.setX(i, p.size);
      } else { kg.attributes.size.setX(i, 0); kg.attributes.tint.setW(i, 0); }
    }
    for (const a of Object.values(kg.attributes)) a.needsUpdate = true;
  }
}
