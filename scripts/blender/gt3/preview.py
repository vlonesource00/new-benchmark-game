# Studio renders of a built car for checking shapes against the references.
import bpy, math, os
from mathutils import Vector
import core

VIEWS = {
    # name: (camera position in three coords, look-at, lens)
    'fq': ((4.6, 1.5, 5.6), (0, 0.55, 0.15), 55),
    'rq': ((-4.4, 1.7, -5.6), (0, 0.6, -0.2), 55),
    'side': ((8.5, 0.75, 0.05), (0, 0.6, 0.05), 60),
    'front': ((0, 0.75, 8.5), (0, 0.6, 0), 70),
    'rear': ((0, 0.9, -8.5), (0, 0.6, 0), 70),
    'top': ((0, 9, 0.01), (0, 0, 0), 55),
    'fl': ((2.2, 1.05, 4.0), (0.35, 0.55, 1.7), 45),
    'low': ((3.4, 0.45, 4.2), (0, 0.5, 0.4), 40),
}


def render(scene, path, views, paint):
    world = bpy.data.worlds.new('w'); world.use_nodes = True
    nt = world.node_tree
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(os.path.join(bpy.utils.system_resource('DATAFILES', path='studiolights/world'), 'city.exr'))
    nt.links.new(env.outputs['Color'], nt.nodes['Background'].inputs['Color'])
    nt.nodes['Background'].inputs['Strength'].default_value = 1.0
    scene.world = world
    sun = bpy.data.objects.new('_sun', bpy.data.lights.new('_sun', 'SUN'))
    sun.data.energy = 3.5; sun.rotation_euler = (0.75, 0.15, 0.6); scene.collection.objects.link(sun)
    me = bpy.data.meshes.new('_ground')
    me.from_pydata([(-30, -30, 0), (30, -30, 0), (30, 30, 0), (-30, 30, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('_ground', me); scene.collection.objects.link(g)
    gm = bpy.data.materials.new('_asphalt'); gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.09, 0.09, 0.1, 1)
    gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
    me.materials.append(gm)
    # wheels so proportions read right
    for x in (-core.WHEEL_X, core.WHEEL_X):
        for z in (core.WHEEL_ZF, core.WHEEL_ZR):
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=core.WHEEL_R, depth=0.29, location=core.B((x, core.WHEEL_R, z)), rotation=(0, math.pi / 2, 0))
            w = bpy.context.active_object; w.name = '_tyre'; w.data.materials.append(core.MATS['Well'])
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.23, depth=0.30, location=core.B((x, core.WHEEL_R, z)), rotation=(0, math.pi / 2, 0))
            w = bpy.context.active_object; w.name = '_rim'; w.data.materials.append(core.MATS['Chrome'])
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 1100, 620
    scene.view_settings.view_transform = 'AgX'
    cam = bpy.data.objects.new('_cam', bpy.data.cameras.new('_cam')); scene.collection.objects.link(cam); scene.camera = cam
    for v in views:
        pos, at, lens = VIEWS[v]
        cam.location = core.B(pos)
        d = core.B(at) - core.B(pos)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = lens
        if v == 'top':
            cam.data.type = 'ORTHO'; cam.data.ortho_scale = 6
        else:
            cam.data.type = 'PERSP'
        scene.render.filepath = path.replace('.png', f'-{v}.png')
        bpy.ops.render.render(write_still=True)
    for ob in list(scene.objects):
        if ob.name.startswith('_'):
            bpy.data.objects.remove(ob, do_unlink=True)
