import RAPIER from '@dimforge/rapier2d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0 });
const theta = 0.7;
const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0).setRotation(theta));
// a collider 1 m ahead along the body's local +x
const col = world.createCollider(RAPIER.ColliderDesc.ball(0.1).setTranslation(1, 0), body);
world.step();
const t = col.translation();
console.log('collider world pos', t.x.toFixed(4), t.y.toFixed(4), 'expected (cos,sin) =', Math.cos(theta).toFixed(4), Math.sin(theta).toFixed(4));
