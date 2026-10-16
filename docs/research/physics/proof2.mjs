// Proof 2: damping formula, terminal velocity, keel stability, handles, hull shapes, events inside handlers.
import RAPIER from '@dimforge/rapier2d-compat';
await RAPIER.init();

const groups = (mem, filt) => ((mem & 0xffff) << 16) | (filt & 0xffff);
const DT = 1 / 60;

// --- 1. Damping formula: one step, no force, v0 = 10, damping d = 1 ---
{
  const w = new RAPIER.World({ x: 0, y: 0 });
  w.timestep = DT;
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinvel(10, 0).setLinearDamping(1).setAngvel(2).setAngularDamping(3).setCanSleep(false));
  w.createCollider(RAPIER.ColliderDesc.cuboid(0.7, 3).setMass(1000), b);
  console.log('mass via ColliderDesc.setMass(1000):', b.mass(), 'inertia', b.principalInertia(), 'expected I=m(w^2+l^2)/12 =', 1000 * (1.4 ** 2 + 6 ** 2) / 12);
  w.step();
  const v = b.linvel().x;
  console.log('one-step damping ratio', v / 10, 'candidate 1/(1+dt*d)=', 1 / (1 + DT * 1), 'candidate 1-dt*d=', 1 - DT, 'exp(-dt d)=', Math.exp(-DT));
  console.log('angular ratio', b.angvel() / 2, 'candidate 1/(1+dt*3)=', 1 / (1 + DT * 3));
  w.free();
}

// --- 2. Terminal velocity with constant force: v_inf = F/(m d) ? and order of ops ---
{
  const w = new RAPIER.World({ x: 0, y: 0 });
  w.timestep = DT;
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinearDamping(1).setCanSleep(false));
  w.createCollider(RAPIER.ColliderDesc.cuboid(0.7, 3).setMass(1000), b);
  const F = { x: 10000, y: 0 };
  const tmp = { x: 0, y: 0 };
  const samples = [];
  for (let i = 1; i <= 600; i++) {
    b.resetForces(false);
    b.addForce(F, true);
    w.step();
    if (i === 60 || i === 120 || i === 180 || i === 300 || i === 600) samples.push([i / 60, b.linvel(tmp).x]);
  }
  console.log('terminal: samples [t, v]', JSON.stringify(samples.map(([t, v]) => [t, +v.toFixed(3)])));
  console.log('v_inf candidates: F/(m d)=', 10000 / 1000, ' F/(m d)*(1+dt d)=', 10 * (1 + DT));
  // analytic check: discrete recurrence v' = (v + a dt)/(1+dt d)
  let vd = 0; for (let i = 0; i < 180; i++) vd = (vd + 10 * DT) / (1 + DT);
  console.log('recurrence (v+a dt)/(1+dt d) after 3 s:', vd.toFixed(4), ' continuous a/d(1-e^-dt):', (10 * (1 - Math.exp(-3))).toFixed(4));
  w.free();
}

// --- 3. Keel: lateral velocity kill via setLinvel vs counter impulse, stability at 60 Hz ---
{
  for (const mode of ['setLinvel', 'impulse']) {
    const w = new RAPIER.World({ x: 0, y: 0 });
    w.timestep = DT;
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setLinearDamping(1).setAngularDamping(3).setCanSleep(false).setLinvel(7, 7).setRotation(0));
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.7, 3).setMass(1000), b);
    const tmpV = { x: 0, y: 0 };
    const out = [];
    for (let i = 1; i <= 90; i++) {
      const a = b.rotation();
      const fx = -Math.sin(a), fy = Math.cos(a); // bow = local +y
      const rx = fy, ry = -fx; // right = (cos a, sin a)
      const v = b.linvel(tmpV);
      const vf = v.x * fx + v.y * fy;
      const vr = v.x * rx + v.y * ry;
      if (mode === 'setLinvel') {
        const keep = Math.exp(-8 * DT); // 8/s lateral decay
        const vr2 = vr * keep;
        b.setLinvel({ x: fx * vf + rx * vr2, y: fy * vf + ry * vr2 }, true);
      } else {
        const k = 8; // 1/s
        b.applyImpulse({ x: -rx * vr * k * DT * b.mass(), y: -ry * vr * k * DT * b.mass() }, true);
      }
      w.step();
      if (i % 15 === 0) {
        const v2 = b.linvel(tmpV);
        out.push(+(v2.x * rx + v2.y * ry).toFixed(3));
      }
    }
    console.log(`keel ${mode}: lateral vel every 0.25 s`, JSON.stringify(out));
    w.free();
  }
}

// --- 4. Handles: opaque numbers? Map keys and getCollider round trip ---
{
  const w = new RAPIER.World({ x: 0, y: 0 });
  const hs = [];
  for (let i = 0; i < 4; i++) {
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(i * 10, 0));
    const c = w.createCollider(RAPIER.ColliderDesc.ball(1), b);
    hs.push([b.handle, c.handle]);
  }
  console.log('handles [body, collider]:', JSON.stringify(hs), 'integers?', hs.map(([b, c]) => Number.isInteger(b) && Number.isInteger(c)));
  const m = new Map();
  for (const [, c] of hs) m.set(c, true);
  console.log('Map size with collider handles as keys', m.size, 'getCollider(h).handle === h', hs.every(([, c]) => w.getCollider(c).handle === c));
  // remove one, create another: handle reuse with generation?
  w.removeRigidBody(w.getRigidBody(hs[1][0]));
  const b2 = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const c2 = w.createCollider(RAPIER.ColliderDesc.ball(1), b2);
  console.log('after remove+create: new body handle', b2.handle, 'new collider handle', c2.handle, 'equal to removed?', c2.handle === hs[1][1]);
  console.log('getCollider(removed handle) ->', w.getCollider(hs[1][1]));
  w.free();
}

// --- 5. Convex hull gondola outline ---
{
  const w = new RAPIER.World({ x: 0, y: 0 });
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  // bow at +y: pointed bow and stern, 1.4 wide amidships, 6 long
  const pts = new Float32Array([0, 3.0, 0.7, 1.2, 0.7, -1.4, 0.3, -3.0, -0.3, -3.0, -0.7, -1.4, -0.7, 1.2]);
  const desc = RAPIER.ColliderDesc.convexHull(pts);
  console.log('convexHull desc null?', desc === null);
  if (desc) {
    const c = w.createCollider(desc.setMass(1000), b);
    console.log('hull shape type', c.shapeType(), '== ConvexPolygon', RAPIER.ShapeType.ConvexPolygon, 'mass', b.mass(), 'inertia', b.principalInertia(), 'verts', c.vertices().length / 2);
  }
  w.free();
}

// --- 6. Events: contactPair manifold readable inside collision-started handler; sensor events; multi-collider body ---
{
  const w = new RAPIER.World({ x: 0, y: 0 });
  w.timestep = DT;
  const G_BOAT = 1, G_WALL = 2, G_MINE_TRIG = 8, G_MINE_BODY = 16;
  const boat = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0).setRotation(0).setLinvel(0, 12).setCanSleep(false));
  const boatCol = w.createCollider(
    RAPIER.ColliderDesc.cuboid(0.7, 3).setMass(1000).setRestitution(0.3).setFriction(0.3)
      .setCollisionGroups(groups(G_BOAT, G_BOAT | G_WALL | G_MINE_TRIG)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), boat);
  const wall = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 20));
  const wallCol = w.createCollider(RAPIER.ColliderDesc.cuboid(10, 1).setCollisionGroups(groups(G_WALL, 0xffff)), wall);
  // mine: dynamic body with a solid small ball (walls only) + a sensor ball (boats only)
  const mine = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 8).setLinearDamping(2).setCanSleep(false));
  const mineSolid = w.createCollider(RAPIER.ColliderDesc.ball(0.4).setMass(10).setCollisionGroups(groups(G_MINE_BODY, G_WALL | G_MINE_BODY)), mine);
  const mineTrig = w.createCollider(RAPIER.ColliderDesc.ball(1.5).setSensor(true).setCollisionGroups(groups(G_MINE_TRIG, G_BOAT)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), mine);
  console.log('mine body colliders', mine.numColliders(), 'mass', mine.mass(), 'sensor isSensor', mineTrig.isSensor());
  const eq = new RAPIER.EventQueue(true);
  const prevVel = { x: 0, y: 0 };
  const tmp = { x: 0, y: 0 };
  let t = 0;
  for (let i = 0; i < 180; i++) {
    boat.linvel(prevVel); const pv = { ...prevVel };
    w.step(eq);
    t += DT;
    eq.drainCollisionEvents((h1, h2, started) => {
      const c1 = w.getCollider(h1), c2 = w.getCollider(h2);
      const kinds = [c1 === boatCol ? 'boat' : c1 === wallCol ? 'wall' : c1 === mineTrig ? 'mineTrig' : c1 === mineSolid ? 'mineSolid' : '?',
                     c2 === boatCol ? 'boat' : c2 === wallCol ? 'wall' : c2 === mineTrig ? 'mineTrig' : c2 === mineSolid ? 'mineSolid' : '?'];
      let info = '';
      if (started && (kinds.includes('wall'))) {
        w.contactPair(c1, c2, (m, flipped) => {
          const n = m.normal(tmp);
          const p = m.solverContactPoint(0);
          const approach = -(pv.x * n.x + pv.y * n.y) * (flipped ? -1 : 1);
          info = ` normal=(${n.x.toFixed(2)},${n.y.toFixed(2)}) flipped=${flipped} solverContacts=${m.numSolverContacts()} pt=${p ? `(${p.x.toFixed(2)},${p.y.toFixed(2)})` : 'null'} preStepVel=(${pv.x.toFixed(2)},${pv.y.toFixed(2)}) postVel=(${boat.linvel(tmp).x.toFixed(2)},${boat.linvel(tmp).y.toFixed(2)}) approachAlongN=${approach.toFixed(2)}`;
        });
        if (info === '') info = ' (no manifold yet)';
      }
      console.log(`t=${t.toFixed(3)} ${kinds.join('-')} started=${started}${info}`);
    });
  }
  // intersectionsWithShape positive case: query a ball around the mine for boats
  const found = [];
  w.intersectionsWithShape(mine.translation(), 0, new RAPIER.Ball(30), (c) => { found.push(c === boatCol ? 'boat' : 'other'); return true; }, undefined, groups(0xffff, G_BOAT));
  console.log('intersectionsWithShape (r=30 around mine, filter BOAT):', found);
  // intersectionPairsWith on the sensor right now
  const pairs = [];
  w.intersectionPairsWith(mineTrig, (c) => pairs.push(c === boatCol ? 'boat' : 'other'));
  console.log('intersectionPairsWith(mineTrig):', pairs, 'boat at', boat.translation());
  eq.free(); w.free();
}
console.log('OK2');
