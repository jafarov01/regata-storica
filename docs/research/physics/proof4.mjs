import RAPIER from '@dimforge/rapier2d-compat';
await RAPIER.init();
const w = new RAPIER.World({ x: 0, y: 0 });
const wall = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 10));
const wc = w.createCollider(RAPIER.ColliderDesc.cuboid(5, 1), wall);
const ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 0, y: 1 });
console.log('castRay right after createCollider:', w.castRay(ray, 100, true));
w.propagateModifiedBodyPositionsToColliders();
console.log('after propagateModifiedBodyPositionsToColliders:', w.castRay(ray, 100, true));
w.step();
const h = w.castRay(ray, 100, true);
console.log('after one step:', h ? h.timeOfImpact : null);
// teleport the wall: do queries see the new position before a step?
wall.setTranslation({ x: 100, y: 10 }, true);
console.log('after setTranslation (no step):', w.castRay(ray, 100, true) ? 'still hit at old place' : 'miss');
w.propagateModifiedBodyPositionsToColliders();
console.log('after propagate (no step):', w.castRay(ray, 100, true) ? 'still hit' : 'miss');
w.step();
console.log('after step:', w.castRay(ray, 100, true) ? 'hit' : 'miss');
// add a second collider mid-game and query it with intersectionsWithShape before/after step
const b2 = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10));
w.createCollider(RAPIER.ColliderDesc.ball(1), b2);
let n = 0; w.intersectionsWithShape({ x: 0, y: 10 }, 0, new RAPIER.Ball(2), () => { n++; return true; });
console.log('intersectionsWithShape sees new dynamic collider before step:', n);
w.step(); n = 0; w.intersectionsWithShape({ x: 0, y: 10 }, 0, new RAPIER.Ball(2), () => { n++; return true; });
console.log('after step:', n);
console.log('wc valid', wc.isValid());
