"""Original ASTRA wheel. Run with Blender --background --python scripts/build-wheel.py."""
import bpy
import math
from pathlib import Path

root = Path(__file__).resolve().parents[1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def material(name, color, metallic, roughness):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    return m

tire = material('Satin racing slick', (.022, .025, .028), 0, .88)
alloy = material('Forged graphite alloy', (.23, .26, .29), .86, .25)
machined = material('Machined rim edge', (.57, .6, .63), .92, .21)

def finish(obj, mat):
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj

def ring(radius, thickness, axial, mat, stretch=1):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=thickness,
        major_segments=64, minor_segments=10, location=(axial, 0, 0), rotation=(0, math.pi / 2, 0))
    obj = bpy.context.object
    obj.scale.z = stretch
    return finish(obj, mat)

ring(.271, .067, 0, tire, 2.08)
for side in [-1, 1]:
    ring(.235, .012, side * .133, machined)
    ring(.218, .009, side * .117, alloy)
    ring(.284, .003, side * .132, tire)
    for i in range(10):
        a = i * math.tau / 10
        bpy.ops.mesh.primitive_cube_add(size=1, location=(side * .128, math.cos(a) * .13, math.sin(a) * .13))
        obj = bpy.context.object
        obj.scale = (.021, .187, .027)
        obj.rotation_euler.x = a
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bevel = obj.modifiers.new('Soft forged edges', 'BEVEL')
        bevel.width = .005
        bevel.segments = 2
        bpy.ops.object.modifier_apply(modifier=bevel.name)
        finish(obj, alloy)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=.049, depth=.024,
        location=(side * .137, 0, 0), rotation=(0, math.pi / 2, 0))
    finish(bpy.context.object, machined)

# Three shared meshes/materials per wheel; no textures or external dependencies.
for mat in [tire, alloy, machined]:
    bpy.ops.object.select_all(action='DESELECT')
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.data.materials[0] == mat]
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    bpy.context.object.name = mat.name

assets = root / 'public' / 'assets'
assets.mkdir(parents=True, exist_ok=True)
source = root / 'art' / 'blender'
source.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(source / 'gt-wheel.blend'))
bpy.ops.export_scene.gltf(filepath=str(assets / 'gt-wheel.glb'), export_format='GLB', export_yup=True)
print('ASTRA wheel exported:', assets / 'gt-wheel.glb')
