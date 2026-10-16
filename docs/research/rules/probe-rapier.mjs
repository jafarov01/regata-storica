import RAPIER from '@dimforge/rapier2d-compat';
import { MathUtils, Vector2 } from 'three';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0 });
world.timestep = 1 / 60;
// a fixed wall at x = 20, spanning y in [-5, 5]
const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(20, 0));
const wall = world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 5), wallBody);
// a dynamic boat at origin
const boatBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0));
const boat = world.createCollider(RAPIER.ColliderDesc.cuboid(3, 0.7), boatBody);
for (let i = 0; i < 10; i++) world.step();
const ray = new RAPIER.Ray({ x: 0, y: 0 }, { x: 1, y: 0 });
const hitAll = world.castRay(ray, 100, true);
const hitFixedOnly = world.castRay(ray, 100, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
const hitExcludeSelf = world.castRay(ray, 100, true, undefined, undefined, boat);
const hitBlockedDir = world.castRay(new RAPIER.Ray({ x: 0, y: 8 }, { x: 1, y: 0 }), 100, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
console.log(JSON.stringify({
  rapierVersion: RAPIER.version(),
  handleTypes: { body: typeof boatBody.handle, collider: typeof boat.handle, bodyHandle: boatBody.handle, wallHandle: wallBody.handle },
  hitAll: hitAll ? { toi: hitAll.timeOfImpact, collider: hitAll.collider.handle } : null,
  hitFixedOnly: hitFixedOnly ? { toi: hitFixedOnly.timeOfImpact, collider: hitFixedOnly.collider.handle } : null,
  hitExcludeSelf: hitExcludeSelf ? { toi: hitExcludeSelf.timeOfImpact, collider: hitExcludeSelf.collider.handle } : null,
  hitBlockedDir: hitBlockedDir,
  isFixed: wallBody.isFixed(), bodyType: boatBody.bodyType(), fixedType: RAPIER.RigidBodyType.Fixed,
  threeEuclid: MathUtils.euclideanModulo(-1, 5), threeDeg: MathUtils.degToRad(180), vec: new Vector2(1, 2).length(),
  worldHasToJSON: typeof world.takeSnapshot,
}, null, 1));
world.free();
