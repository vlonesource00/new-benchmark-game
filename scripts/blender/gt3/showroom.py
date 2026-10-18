# Lays every built GT3 out in a showroom row and saves a .blend to open in Blender.
#   blender -b --factory-startup --python showroom.py -- <glb dir> <out.blend>
import bpy, sys, os, math
args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
CARS = ['porsche', 'bmw', 'corvette', 'mclaren', 'ferrari', 'mustang', 'aston', 'mercedes', 'lexus']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
gap = 2.9
for i, name in enumerate(CARS):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(src, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    col = bpy.data.collections.new(name.capitalize())
    scene.collection.children.link(col)
    root = bpy.data.objects.new(name.capitalize(), None)
    col.objects.link(root)
    for o in new:
        for c in o.users_collection:
            c.objects.unlink(o)
        col.objects.link(o)
        if o.parent is None:
            o.parent = root
    root.location = ((i - (len(CARS) - 1) / 2) * gap, 0, 0)
# Floor, lights, camera.
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
floor = bpy.context.object; floor.name = 'Floor'
m = bpy.data.materials.new('Floor'); m.use_nodes = True
m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.08, 0.08, 0.09, 1)
m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.35
floor.data.materials.append(m)
bpy.ops.object.light_add(type='SUN', location=(0, 0, 10)); sun = bpy.context.object
sun.data.energy = 3.0; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
bpy.ops.object.light_add(type='AREA', location=(0, -9, 6)); a = bpy.context.object
a.data.energy = 4000; a.data.size = 20; a.rotation_euler = (math.radians(55), 0, 0)
world = bpy.data.worlds.new('World'); scene.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.68, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
bpy.ops.object.camera_add(location=(9, -17, 5.5)); cam = bpy.context.object
cam.rotation_euler = (math.radians(74), 0, math.radians(28)); cam.data.lens = 30
scene.camera = cam
scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
bpy.ops.wm.save_as_mainfile(filepath=out)
print('SAVED', out)
