import * as THREE from 'three';
import { CarModel } from './car-pro.js';
import { radialTexture } from './textures.js';

// The safety car, built to be told apart from the field at a glance:
//
//   livery     gloss black with a fluorescent lime chevron run down each flank,
//              twin bonnet-to-tail stripes, SAFETY CAR door lettering and a roof
//              roundel (its own paint shader, not the race-car livery)
//   light bar  a low aero pod on the roof with eight LED cells per face that
//              run a chase-then-wig-wag pattern in amber, white takedown
//              lamps at the ends and a glow over each cell
//   front      wig-wag headlamps and an amber LED strip in the lower grille
//   rear       a message board that alternates SAFETY CAR / NO OVERTAKING, and
//              reads IN THIS LAP once race control turns the lights off
//   road       an amber light pool that pulses on the tarmac around the car
//
// While it leads the field (car.lights) everything strobes; on its in-lap the
// bar goes dark, the headlamps return to normal and the board says it is in.

const AMBER = new THREE.Color('#ffa514'), LIME = '#c8ff1e', WHITE = new THREE.Color('#f2f6ff');
const CELLS = 8;

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Door lettering: italic SAFETY CAR over a lime underline, transparent around it.
let doorTex = null, roofTex = null;
function doorTexture() {
  return doorTex ??= canvasTexture(1024, 192, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    x.font = 'italic 900 112px "Arial Black", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 10; x.strokeStyle = '#05070a'; x.strokeText('SAFETY CAR', w / 2, 82);
    x.fillStyle = '#f5f7fa'; x.fillText('SAFETY CAR', w / 2, 82);
    x.fillStyle = LIME; x.fillRect(90, 150, w - 180, 16);
    for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(w - 160 + i * 22, 140); x.lineTo(w - 140 + i * 22, 158); x.lineTo(w - 160 + i * 22, 176); x.lineTo(w - 172 + i * 22, 176); x.lineTo(w - 152 + i * 22, 158); x.lineTo(w - 172 + i * 22, 140); x.fill(); }
  });
}
function roofTexture() {
  return roofTex ??= canvasTexture(256, 256, (x, w) => {
    x.clearRect(0, 0, w, w);
    x.fillStyle = LIME; x.beginPath(); x.arc(w / 2, w / 2, 118, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#05070a'; x.beginPath(); x.arc(w / 2, w / 2, 100, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#f5f7fa'; x.font = 'italic 900 118px "Arial Black", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('SC', w / 2, w / 2 + 6);
  });
}

// Rear message board: redrawn only when the message changes.
const MESSAGES = { sc: 'SAFETY CAR', no: 'NO OVERTAKING', in: 'IN THIS LAP' };
function boardCanvas() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 80;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return { c, t, msg: null };
}
function drawBoard(b, msg) {
  if (b.msg === msg) return; b.msg = msg;
  const x = b.c.getContext('2d'), w = b.c.width, h = b.c.height, col = msg === 'in' ? '#3dff6e' : '#ffae1a';
  x.fillStyle = '#07080a'; x.fillRect(0, 0, w, h);
  // LED-matrix look: a dot grid behind the text.
  x.fillStyle = 'rgba(255,255,255,.05)'; for (let i = 4; i < w; i += 8) for (let j = 4; j < h; j += 8) x.fillRect(i, j, 3, 3);
  x.fillStyle = col; x.font = '900 46px "Arial Black", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = col; x.shadowBlur = 14; x.fillText(MESSAGES[msg], w / 2, h / 2 + 2); x.shadowBlur = 0;
  x.fillRect(0, 0, w, 4); x.fillRect(0, h - 4, w, 4);
  b.t.needsUpdate = true;
}

// Livery in body space (x across, y up, z forward; the GT body is ~±1 m wide, 1.25 m tall, ±2.4 m long).
function liveryMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ color: '#0b0d10', metalness: .35, roughness: .22, clearcoat: 1, clearcoatRoughness: .02, envMapIntensity: 1.4 });
  // Same uniform names as the race-car paint so CarModel helpers that touch them keep working.
  m.userData.uniforms = {
    uStripe: { value: new THREE.Color(LIME) }, uAccent: { value: new THREE.Color('#16191c') },
    uNumber: { value: roofTexture() }, uDoor: { value: doorTexture() }
  };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, m.userData.uniforms);
    s.vertexShader = 'varying vec3 vObj;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj=position;');
    s.fragmentShader = 'varying vec3 vObj;uniform vec3 uStripe;uniform vec3 uAccent;uniform sampler2D uNumber;uniform sampler2D uDoor;\n' + s.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ax=abs(vObj.x);
        // Flank chevrons: arrows pointing forward, fading out ahead of the doors.
        float band=smoothstep(.22,.25,vObj.y)*(1.-smoothstep(.50,.53,vObj.y))*step(.62,ax);
        float chev=step(.5,fract((vObj.z-abs(vObj.y-.375)*1.6)*2.2));
        float run=1.-smoothstep(-.2,.35,vObj.z);
        diffuseColor.rgb=mix(diffuseColor.rgb,uStripe,band*chev*run);
        // Twin stripes over the top, bonnet to tail.
        float top=smoothstep(.70,.74,vObj.y);
        float twin=(1.-smoothstep(.045,.052,abs(ax-.26)));
        diffuseColor.rgb=mix(diffuseColor.rgb,uStripe,twin*top);
        // Carbon sills and splitter.
        float lower=1.-smoothstep(.20,.215,vObj.y+vObj.z*.02);
        diffuseColor.rgb=mix(diffuseColor.rgb,uAccent,lower*step(.55,ax));
        // Door lettering, readable from both sides.
        vec2 du=vec2(-sign(vObj.x)*(vObj.z+.05)/1.7+.5,(vObj.y-.66)/.3+.5);
        if(ax>.74&&du.x>0.&&du.x<1.&&du.y>0.&&du.y<1.){vec4 n=texture2D(uDoor,du);diffuseColor.rgb=mix(diffuseColor.rgb,n.rgb,n.a);}
        vec2 ru=vec2(-vObj.x,vObj.z+.42)/.62+.5;
        if(vObj.y>1.12&&ru.x>0.&&ru.x<1.&&ru.y>0.&&ru.y<1.){vec4 n=texture2D(uNumber,ru);diffuseColor.rgb=mix(diffuseColor.rgb,n.rgb,n.a);}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float flake=fract(sin(dot(floor(vObj*1400.),vec3(12.9898,78.233,37.719)))*43758.5453);
        roughnessFactor=clamp(roughnessFactor*(.88+flake*.24),.04,1.);`);
  };
  m.customProgramCacheKey = () => 'safety-car-paint';
  return m;
}

export class SafetyCarModel extends CarModel {
  constructor(car) {
    super(car);
    this.number = 'SC';
    // Own livery: swap the paint before the (async) body picks it up; the helmet already holds the old one.
    this.paint = liveryMaterial();
    this.helmet.material = this.paint;

    const housing = new THREE.MeshPhysicalMaterial({ color: '#101215', roughness: .18, metalness: .2, clearcoat: 1, clearcoatRoughness: .05 });
    const lensOff = new THREE.Color('#2a1a06');
    const glowMap = radialTexture([[0, 'rgba(255,255,255,1)'], [.22, 'rgba(255,200,110,.55)'], [1, 'rgba(255,150,20,0)']]);
    const glowMat = (color) => new THREE.SpriteMaterial({ map: glowMap, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });

    // Roof light bar: a low pill-shaped pod on two feet, LED cells on both faces, takedown lamps at the ends.
    const bar = this.bar = new THREE.Group(); bar.position.set(0, 1.25, -0.2); this.body.add(bar);
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(.06, 1.1, 6, 16), housing); pod.rotation.z = Math.PI / 2; pod.scale.set(1, 1, 2.1); pod.position.y = .07; bar.add(pod);
    const feet = new THREE.MeshStandardMaterial({ color: '#202327', roughness: .5, metalness: .6 });
    for (const x of [-.42, .42]) { const f = new THREE.Mesh(new THREE.BoxGeometry(.06, .05, .2), feet); f.position.set(x, .015, 0); bar.add(f); }
    const cellGeo = new THREE.BoxGeometry(.105, .05, .012);
    this.cells = [];
    for (const face of [1, -1]) for (let i = 0; i < CELLS; i++) {
      const x = (i - (CELLS - 1) / 2) * .128;
      const mat = new THREE.MeshStandardMaterial({ color: lensOff, emissive: AMBER, emissiveIntensity: 0, roughness: .12 });
      const cell = new THREE.Mesh(cellGeo, mat); cell.position.set(x, .07, face * .122); bar.add(cell);
      const glow = new THREE.Sprite(glowMat(AMBER)); glow.position.set(x, .07, face * .16); glow.scale.setScalar(.42); bar.add(glow);
      this.cells.push({ mat, glow, i, face });
    }
    this.takedown = [];
    for (const side of [-1, 1]) {
      const mat = new THREE.MeshStandardMaterial({ color: '#e8eef8', emissive: WHITE, emissiveIntensity: 0, roughness: .1 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(.055, 14, 10), mat); lamp.position.set(side * .62, .07, 0); bar.add(lamp);
      const glow = new THREE.Sprite(glowMat(WHITE)); glow.position.set(side * .66, .07, 0); glow.scale.setScalar(.5); bar.add(glow);
      this.takedown.push({ mat, glow, side });
    }
    // Two thin roof antennas and a TV camera pod behind the bar.
    const black = new THREE.MeshStandardMaterial({ color: '#0a0b0d', roughness: .4 });
    for (const x of [-.25, .25]) { const a = new THREE.Mesh(new THREE.CylinderGeometry(.006, .009, .34, 6), black); a.position.set(x, 1.38, -.75); a.rotation.x = -.35; this.body.add(a); }
    const cam = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .12, 4, 10), black); cam.rotation.x = Math.PI / 2; cam.position.set(0, 1.27, -.6); this.body.add(cam);

    // Lower grille LED strip (front) and the rear message board.
    this.grille = [];
    for (const side of [-1, 1]) {
      const mat = new THREE.MeshStandardMaterial({ color: lensOff, emissive: AMBER, emissiveIntensity: 0, roughness: .15 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(.5, .028, .02), mat); strip.position.set(side * .42, .3, 2.28); this.body.add(strip);
      const glow = new THREE.Sprite(glowMat(AMBER)); glow.position.set(side * .42, .3, 2.36); glow.scale.set(.9, .35, 1); this.body.add(glow);
      this.grille.push({ mat, glow, side });
    }
    // Message signs stand on a slim frame above the pod, back to back, so the LED cells stay visible on both faces.
    this.board = boardCanvas(); drawBoard(this.board, 'sc');
    const sign = new THREE.Group(); sign.position.set(0, .215, 0); bar.add(sign);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(.98, .16, .03), housing); sign.add(frame);
    for (const x of [-.4, .4]) { const post = new THREE.Mesh(new THREE.BoxGeometry(.03, .1, .03), feet); post.position.set(x, -.11, 0); sign.add(post); }
    const rear = new THREE.Mesh(new THREE.PlaneGeometry(.92, .135), new THREE.MeshBasicMaterial({ map: this.board.t, toneMapped: false }));
    rear.position.set(0, 0, -.017); rear.rotation.y = Math.PI; sign.add(rear);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(.92, .135), new THREE.MeshBasicMaterial({ map: canvasTexture(512, 80, (x, w, h) => {
      x.fillStyle = '#07080a'; x.fillRect(0, 0, w, h); x.fillStyle = '#f5f7fa'; x.font = 'italic 900 46px "Arial Black", Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('SAFETY CAR', w / 2, h / 2 + 2);
      x.fillStyle = LIME; x.fillRect(0, 0, w, 4); x.fillRect(0, h - 4, w, 4);
    }), toneMapped: false }));
    front.position.set(0, 0, .017); sign.add(front);

    // Amber light pool on the road: on the root so it stays flat while the body pitches and rolls.
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(9, 13), new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(255,170,40,.55)'], [.45, 'rgba(255,140,20,.18)'], [1, 'rgba(255,120,0,0)']]), color: '#ffffff', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4 }));
    this.pool.rotation.x = -Math.PI / 2; this.pool.position.set(0, .03, -.3); this.pool.renderOrder = 2; this.root.add(this.pool);

    // Wig-wag headlamps: give this car its own copies of the shared headlamp glows once the body has loaded.
    this.ready?.then(() => {
      this.headGlows = this.glowsF.map((g) => { g.material = g.material.clone(); return { g, side: Math.sign(g.position.x) || 1 }; });
    });
    this.flash = 0; this.msgClock = 0;
  }

  update(dt) {
    super.update(dt);
    this.flash += dt; this.msgClock += dt;
    const on = this.car.lights !== false, t = this.flash;
    // Light bar: a 0.8 s chase sweeping out from the centre, then a 1.6 s left/right double-pulse wig-wag.
    const cycle = t % 2.4, chase = cycle < .8, phase = chase ? cycle / .8 : ((cycle - .8) * 1.25) % 1;
    for (const c of this.cells) {
      let k = 0;
      if (on) {
        if (chase) { const d = Math.abs(c.i - (CELLS - 1) / 2) / ((CELLS - 1) / 2); k = Math.max(0, 1 - Math.abs(d - phase) * 4); }
        else { const left = c.i < CELLS / 2, p = left ? phase : (phase + .5) % 1; k = p < .12 || (p > .2 && p < .32) ? 1 : 0; }
      }
      c.mat.emissiveIntensity = on ? .15 + k * 11 : 0;
      c.glow.material.opacity = k * .9;
    }
    // Takedown lamps flash white between the amber pulses; the grille strip mirrors the bar.
    const wig = ((t * 1.25) % 1), wigL = wig < .5;
    for (const l of this.takedown) { const lit = on && !chase && (l.side < 0 ? wigL : !wigL) && wig % .5 < .1; l.mat.emissiveIntensity = lit ? 8 : 0; l.glow.material.opacity = lit ? .9 : 0; }
    for (const g of this.grille) { const lit = on && (g.side < 0 ? wigL : !wigL) && (wig % .5) < .3; g.mat.emissiveIntensity = lit ? 9 : on ? .2 : 0; g.glow.material.opacity = lit ? .7 : 0; }
    if (this.headGlows) for (const h of this.headGlows) h.g.material.opacity = on ? ((h.side < 0) === wigL ? 1 : .15) : .6;
    // The road pool pulses with the strobe.
    const pulse = on ? (chase ? .55 + .25 * Math.sin(t * 20) : (wig % .5 < .3 ? .9 : .35)) : 0;
    this.pool.material.opacity += (pulse - this.pool.material.opacity) * Math.min(1, dt * 18);
    // Rear board: SAFETY CAR / NO OVERTAKING every 1.6 s while leading, IN THIS LAP once the lights are out.
    drawBoard(this.board, !on ? 'in' : Math.floor(this.msgClock / 1.6) % 2 ? 'no' : 'sc');
  }
}
