// Proof 1: init Rapier 2D compat, build a zero-gravity world, step a dynamic body,
// check the API names used in final.md actually exist at runtime.
import RAPIER from '@dimforge/rapier2d-compat';

await RAPIER.init();
console.log('rapier version', RAPIER.version());

const world = new RAPIER.World({ x: 0, y: 0 });
console.log('default timestep', world.timestep, 'integrationParameters.dt', world.integrationParameters.dt);
world.timestep = 1 / 60;

// collision groups: membership in high 16 bits, filter in low 16 bits
const G_BOAT = 1 << 0, G_WALL = 1 << 1, G_CRATE = 1 << 2;
const groups = (mem, filt) => ((mem & 0xffff) << 16) | (filt & 0xffff);

const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
  .setTranslation(0, 0)
  .setRotation(0)
  .setLinearDamping(0.5)
  .setAngularDamping(2)
  .setCanSleep(false)
  .setUserData({ kind: 'boat', id: 'A' });
const body = world.createRigidBody(bodyDesc);
const colDesc = RAPIER.ColliderDesc.cuboid(3, 0.7)
  .setDensity(1)
  .setFriction(0.2)
  .setRestitution(0.3)
  .setCollisionGroups(groups(G_BOAT, G_BOAT | G_WALL | G_CRATE))
  .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
  .setContactForceEventThreshold(10);
const col = world.createCollider(colDesc, body);
console.log('body.userData', body.userData, 'handle', body.handle, 'collider handle', col.handle);
console.log('mass from density 1 cuboid 6x1.4 =', body.mass(), 'inertia', body.principalInertia());
body.setAdditionalMass(0, true);

// a wall
const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(20, 0));
const wallCol = world.createCollider(
  RAPIER.ColliderDesc.cuboid(1, 10).setCollisionGroups(groups(G_WALL, G_BOAT | G_CRATE)),
  wallBody,
);

// sensor crate
const crateBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(8, 0).setLinearDamping(1).setAngularDamping(1));
const crateCol = world.createCollider(
  RAPIER.ColliderDesc.ball(1.0).setSensor(true).setCollisionGroups(groups(G_CRATE, G_BOAT)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
  crateBody,
);

const eq = new RAPIER.EventQueue(true);
const f = { x: 0, y: 0 };
const tmp = { x: 0, y: 0 };
let t = 0;
const log = [];
for (let i = 0; i < 240; i++) {
  f.x = 2000; f.y = 0;
  body.resetForces(true);
  body.addForce(f, true);
  world.step(eq);
  t += world.timestep;
  eq.drainCollisionEvents((h1, h2, started) => {
    log.push(`t=${t.toFixed(3)} collision ${h1} ${h2} started=${started}`);
  });
  eq.drainContactForceEvents((ev) => {
    log.push(`t=${t.toFixed(3)} contactForce ${ev.collider1()} ${ev.collider2()} total=${ev.totalForceMagnitude().toFixed(1)} max=${ev.maxForceMagnitude().toFixed(1)} dir=${JSON.stringify(ev.maxForceDirection(tmp))}`);
  });
}
console.log('after 4 s: pos', body.translation(), 'linvel', body.linvel(tmp), 'angvel', body.angvel());
console.log(log.slice(0, 12).join('\n'));

// castRay with group filter (hit the wall only)
const ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 1, y: 0 });
const hit = world.castRay(ray, 100, true, undefined, groups(0xffff, G_WALL), undefined, undefined, undefined);
console.log('castRay hit', hit ? { collider: hit.collider.handle, toi: hit.timeOfImpact, point: ray.pointAt(hit.timeOfImpact) } : null);
const hitN = world.castRayAndGetNormal(ray, 100, true, undefined, groups(0xffff, G_WALL));
console.log('castRayAndGetNormal', hitN ? { toi: hitN.timeOfImpact, normal: hitN.normal } : null);
const hitExcl = world.castRay(ray, 100, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, col);
console.log('castRay exclude self collider', hitExcl ? hitExcl.collider.handle : null);

// intersectionsWithShape (query-based pickup detection)
const found = [];
world.intersectionsWithShape(body.translation(), body.rotation(), new RAPIER.Ball(2), (c) => { found.push(c.handle); return true; }, undefined, groups(0xffff, G_CRATE));
console.log('intersectionsWithShape around boat found', found);

// contactPair manifold reading (impact point + normal)
world.contactPair(col, wallCol, (manifold, flipped) => {
  console.log('manifold normal', manifold.normal(tmp), 'numContacts', manifold.numContacts(), 'numSolverContacts', manifold.numSolverContacts(), 'flipped', flipped, 'pt0', manifold.solverContactPoint(0));
});

// runtime group switch + teleport + velocity reset
col.setCollisionGroups(groups(1 << 4, 0));
body.setTranslation({ x: -50, y: 10 }, true);
body.setRotation(Math.PI / 2, true);
body.setLinvel({ x: 0, y: 0 }, true);
body.setAngvel(0, true);
world.step(eq);
console.log('after teleport', body.translation(), body.rotation(), 'groups', col.collisionGroups().toString(16));

// impulse at point
body.applyImpulseAtPoint({ x: 0, y: 500 }, { x: body.translation().x + 2.5, y: body.translation().y }, true);
world.step(eq);
console.log('angvel after offset impulse', body.angvel());

// remove
world.removeRigidBody(crateBody);
console.log('crate collider valid after body removal?', crateCol.isValid(), 'bodies', world.bodies.len(), 'colliders', world.colliders.len());
world.removeCollider(wallCol, true);
console.log('colliders after removeCollider', world.colliders.len());
eq.free();
world.free();
console.log('OK');
