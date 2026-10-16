import * as THREE from 'three';
async function boot(): Promise<void> {
  const RAPIER = (await import('@dimforge/rapier2d-compat')).default;
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0 });
  const el = document.getElementById('app');
  if (el) el.textContent = `rapier ${RAPIER.version()} three r${THREE.REVISION} bodies ${world.bodies.len()}`;
}
void boot();
