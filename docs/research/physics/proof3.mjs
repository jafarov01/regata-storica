import RAPIER from '@dimforge/rapier2d-compat';
await RAPIER.init();
const w = new RAPIER.World({ x: 0, y: 0 });
const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
w.createCollider(RAPIER.ColliderDesc.ball(0.4).setMass(10), b);
w.createCollider(RAPIER.ColliderDesc.ball(1.5).setSensor(true).setDensity(0), b);
console.log('mine mass with sensor density 0:', b.mass());
// stale handle aliasing check
const b1 = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const c1 = w.createCollider(RAPIER.ColliderDesc.ball(1), b1);
const stale = c1.handle;
w.removeRigidBody(b1);
console.log('after remove: colliders.contains(stale)', w.colliders.contains(stale), 'colliders.get(stale)', w.colliders.get(stale), 'c1.isValid()', c1.isValid());
const b2 = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const c2 = w.createCollider(RAPIER.ColliderDesc.ball(1), b2);
console.log('new handle === stale?', c2.handle === stale, 'colliders.get(stale) after reuse ->', w.colliders.get(stale) ? 'object(handle=' + w.colliders.get(stale).handle + ')' : null, 'contains(stale)', w.colliders.contains(stale), 'c1.isValid() now', c1.isValid());
// decode handle bits
const f = new Float64Array(1); const u = new Uint32Array(f.buffer);
f[0] = c2.handle; console.log('c2 handle bits (lo=index, hi=generation):', u[0], u[1]);
f[0] = stale; console.log('stale handle bits:', u[0], u[1]);
// removeCollider on a stale wrapper?
try { w.removeCollider(c1, true); console.log('removeCollider(stale wrapper) did not throw; c2 valid?', c2.isValid()); } catch (e) { console.log('removeCollider stale threw', e.message); }
w.free();
