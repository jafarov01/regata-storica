import RAPIER from '@dimforge/rapier2d-compat';
import { Matrix4, Vector3 } from 'three';

await RAPIER.init();
console.log('rapier version', RAPIER.version());
const world = new RAPIER.World({ x: 0, y: 0 });
// a wall: fixed cuboid, half extents in metres, centred at x=10
const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(4, 4).setTranslation(10, 0), wallBody);
// a "boat" ball moving +x at 10 m/s
const boat = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0).setRotation(Math.PI / 2));
world.createCollider(RAPIER.ColliderDesc.ball(1).setRestitution(0.3), boat);
boat.setLinvel({ x: 10, y: 0 }, true);
world.integrationParameters.dt = 1 / 60;
for (let i = 0; i < 120; i++) world.step();
console.log('boat after 2 s', boat.translation(), 'rotation', boat.rotation(), '(expected x < 5 because wall face is at x=6, rotation pi/2)');

const m = new Matrix4().makeRotationY(0.5);
const v = new Vector3(1, 0, 0).applyMatrix4(m);
console.log('three makeRotationY(0.5) * (1,0,0) =', v.toArray().map(n => n.toFixed(4)), 'expected (cos .5, 0, -sin .5) =', [Math.cos(0.5).toFixed(4), 0, (-Math.sin(0.5)).toFixed(4)]);
