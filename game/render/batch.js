import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Static batching. The world is built from hundreds of small meshes, many with
// identical materials created separately; each one costs the CPU a draw call
// (twice when it casts shadows) while the GPU idles. This pass dedupes plain
// materials, then merges every static mesh that shares a material, shadow flags
// and a ~240 m map cell into one mesh, so culling still works per cell.
//
// Left alone: instanced meshes, meshes or materials the world keeps references
// to (it may animate them), materials with custom shaders or user data, and
// anything not frustum culled.

const CELL = 240;
const plain = (m) => m && !Array.isArray(m) && m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && !m.isShaderMaterial && Object.keys(m.userData).length === 0;
const id = (t) => t?.uuid ?? '';
const hex = (c) => c?.getHexString?.() ?? '';
function materialKey(m) {
  return [m.type, hex(m.color), hex(m.emissive), m.emissiveIntensity, m.roughness, m.metalness, id(m.map), id(m.normalMap), id(m.roughnessMap), id(m.metalnessMap), id(m.alphaMap), id(m.emissiveMap), id(m.aoMap), id(m.envMap),
    m.transparent, m.opacity, m.side, m.alphaTest, m.vertexColors, m.flatShading, m.depthWrite, m.depthTest, m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.blending, m.envMapIntensity, m.toneMapped, m.fog, m.wireframe,
    m.clearcoat, m.clearcoatRoughness, m.sheen, m.transmission, m.normalScale?.x, m.normalScale?.y].join('|');
}
const attrKey = (g) => Object.entries(g.attributes).map(([k, a]) => `${k}${a.itemSize}${a.normalized ? 'n' : ''}${a.array.constructor.name}`).sort().join(',') + (g.index ? ':i' : ':n') + (Object.keys(g.morphAttributes).length ? ':m' : '');

/** Collects the meshes and materials the world keeps handles to, so they stay untouched. */
export function protectedRefs(owner) {
  const meshes = new Set(), materials = new Set(), objects = new Set();
  const visit = (v, depth = 0) => {
    if (!v || depth > 2) return;
    if (v.isObject3D) objects.add(v);
    if (v.isMesh) { meshes.add(v); if (!Array.isArray(v.material)) materials.add(v.material); return; }
    if (v.isMaterial) { materials.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === 'object' && v.constructor === Object) for (const x of Object.values(v)) visit(x, depth + 1);
  };
  for (const v of Object.values(owner)) visit(v);
  return { meshes, materials, objects };
}

export function batchStatic(root, { meshes: keepMeshes, materials: keepMaterials, objects = new Set() }) {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert(), m4 = new THREE.Matrix4(), centre = new THREE.Vector3();
  const canon = new Map(), groups = new Map();
  const layerOf = (o) => { for (let p = o; p && p !== root; p = p.parent) if (p.userData.layer) return p.userData.layer; return ''; };
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.visible || !o.frustumCulled || keepMeshes.has(o)) return;
    const mat = o.material;
    if (!plain(mat) || keepMaterials.has(mat) || !o.geometry?.attributes.position) return;
    for (let p = o.parent; p && p !== root; p = p.parent) if (!p.visible) return;
    const mk = materialKey(mat); if (!canon.has(mk)) canon.set(mk, mat);
    o.geometry.computeBoundingBox(); o.geometry.boundingBox.getCenter(centre).applyMatrix4(o.matrixWorld);
    const key = [mk, o.castShadow, o.receiveShadow, o.renderOrder, attrKey(o.geometry), layerOf(o), Math.floor(centre.x / CELL), Math.floor(centre.z / CELL)].join('#');
    let g = groups.get(key); if (!g) groups.set(key, g = { material: canon.get(mk), items: [], layer: layerOf(o) }); g.items.push(o);
  });
  const merged = []; let removed = 0;
  for (const g of groups.values()) {
    if (g.items.length < 2) continue;
    const geos = g.items.map((o) => { const geo = o.geometry.clone(); geo.applyMatrix4(m4.multiplyMatrices(toRoot, o.matrixWorld)); for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color', 'uv1', 'uv2'].includes(k)) geo.deleteAttribute(k); return geo; });
    let geo;
    try { geo = mergeGeometries(geos, false); } catch { geo = null; }
    for (const x of geos) if (x !== geo) x.dispose();
    if (!geo) continue;
    const first = g.items[0], mesh = new THREE.Mesh(geo, g.material);
    mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow; mesh.renderOrder = first.renderOrder; mesh.userData.layer = g.layer;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    for (const o of g.items) { o.parent.remove(o); removed++; }
    root.add(mesh); merged.push(mesh);
  }
  // Groups emptied by the merge go too, so the scene graph walk gets shorter.
  const empty = []; root.traverse((o) => { if (o !== root && o.type === 'Group' && o.children.length === 0 && !objects.has(o)) empty.push(o); });
  for (const o of empty) o.parent?.remove(o);
  return { merged, removed };
}
