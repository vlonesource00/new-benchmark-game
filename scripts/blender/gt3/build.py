# Build one GT3 body and export it for the game.
#   blender -b --factory-startup --python build.py -- <car> <out.glb> [preview.png] [views]
# <car> is a module in cars/ (mercedes, porsche, ...). Each module exposes SPEC
# (paint, body/cabin tables) and details(b) (openings, lamps, aero, trim).
import bpy, sys, os, math, json, importlib, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cars'))
import core

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
CAR, OUT = argv[0], argv[1]
PREVIEW = argv[2] if len(argv) > 2 else None
VIEWS = argv[3].split(',') if len(argv) > 3 else ['fq', 'rq']

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
t0 = time.time()
mod = importlib.import_module(CAR)
b = core.Builder(mod.SPEC)
mod.details(b)
objs = b.finish()
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
for o in sorted(objs, key=lambda o: -len(o.data.polygons))[:5]:
    print('OBJ', o.name, sum(len(p.vertices) - 2 for p in o.data.polygons))

# Low-poly shadow caster: copies of the body, cabin and wing joined and decimated.
import bmesh
core.material('Shadow', (0, 0, 0))
bm = bmesh.new()
for ob in objs:
    if ob.name in ('Body', 'Cabin') or ob.name in ('Carbon',):
        bm.from_mesh(ob.data)
me = bpy.data.meshes.new('Shadow'); bm.to_mesh(me); bm.free()
sh = bpy.data.objects.new('Shadow', me); scene.collection.objects.link(sh)
me.materials.clear(); me.materials.append(core.MATS['Shadow'])
for p in me.polygons:
    p.material_index = 0
dec = sh.modifiers.new('dec', 'DECIMATE'); dec.ratio = max(0.01, 4000 / max(1, len(me.polygons) * 2))
core.apply_modifiers(sh)
shadow_tris = sum(len(p.vertices) - 2 for p in sh.data.polygons)
print('SHADOW tris', shadow_tris)
print(f'BUILT {CAR} tris={tris} in {time.time() - t0:.1f}s')

meta = dict(getattr(mod, 'META', {}))
meta['tris'] = tris
with open(os.path.splitext(OUT)[0] + '.json', 'w') as f:
    json.dump(meta, f, indent=1)

if PREVIEW:
    sh.hide_render = True
    import preview
    preview.render(scene, PREVIEW, VIEWS, mod.SPEC.get('paint'))

for ob in list(scene.objects):
    ob.select_set(ob.type == 'MESH' and not ob.name.startswith('_'))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                          export_materials='EXPORT', export_normals=True, export_texcoords=False)
print('EXPORTED', OUT)
