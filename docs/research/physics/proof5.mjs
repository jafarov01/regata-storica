// debugRender buffers + profiler timing for a representative scene: 6 boats, 24 crates, 6 mines, ~100 static colliders
import RAPIER from '@dimforge/rapier2d-compat';
await RAPIER.init();
const w = new RAPIER.World({ x: 0, y: 0 });
w.timestep = 1 / 60;
const st = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
for (let i = 0; i < 100; i++) w.createCollider(RAPIER.ColliderDesc.cuboid(8, 8).setTranslation((i % 10) * 40 - 200, Math.floor(i / 10) * 40 - 200), st);
const boats = [];
for (let i = 0; i < 6; i++) { const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(i * 10 - 25, 0).setLinearDamping(1).setAngularDamping(3).setCanSleep(false)); w.createCollider(RAPIER.ColliderDesc.roundCuboid(0.55, 2.85, 0.15).setMass(1000).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), b); boats.push(b); }
for (let i = 0; i < 24; i++) { const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(i * 7 - 80, 15).setLinearDamping(1.5)); w.createCollider(RAPIER.ColliderDesc.ball(0.8).setMass(20).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), b); }
for (let i = 0; i < 6; i++) { const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(i * 7 - 20, -15).setLinearDamping(2)); w.createCollider(RAPIER.ColliderDesc.ball(0.4).setMass(10), b); w.createCollider(RAPIER.ColliderDesc.ball(1.6).setSensor(true).setDensity(0).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), b); }
const eq = new RAPIER.EventQueue(true);
w.profilerEnabled = true;
const t0 = performance.now();
const N = 600;
for (let i = 0; i < N; i++) { for (const b of boats) { b.resetForces(false); b.addForce({ x: 0, y: 10000 }, true); } w.step(eq); eq.drainCollisionEvents(() => {}); }
const ms = (performance.now() - t0) / N;
console.log('avg wall ms per step (6 boats, 24 crates, 6 mines, 100 walls):', ms.toFixed(3), 'rapier timingStep ms:', w.timingStep().toFixed(3));
const dbg = w.debugRender();
console.log('debugRender vertices floats', dbg.vertices.length, 'colors floats', dbg.colors.length, '(2 floats per vertex, 4 per colour)');
console.log('ray cost: ', (() => { const r = new RAPIER.Ray({ x: 0, y: 0 }, { x: 1, y: 0 }); const t = performance.now(); for (let i = 0; i < 10000; i++) w.castRay(r, 100, true); return ((performance.now() - t) / 10000 * 1000).toFixed(2) + ' us per castRay'; })());
