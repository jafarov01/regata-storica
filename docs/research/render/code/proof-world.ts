import { InstancedMesh, Mesh, Texture, type BufferGeometry } from 'three';
import { buildWorld, mergeBlocks, findBridgeRuns } from './src/render/buildings.ts';
import { buildHullGeometry, buildTrimGeometry, buildFerroGeometry } from './src/render/gondola.ts';
import { parseMap, SAMPLE_MAP } from './shared/map.ts';
import { computeLayout } from './src/scene/layout.ts';
import { verticalFovDeg } from './src/scene/camera.ts';

const map = parseMap(SAMPLE_MAP);
const tex = { grain: new Texture(), stripesBlue: new Texture(), stripesRed: new Texture() };
const world = buildWorld(map, tex);
const tris = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
let meshes = 0, instanced = 0, triStatic = 0, triInstanced = 0, instances = 0;
world.group.traverse((o) => {
  if (o instanceof InstancedMesh) { instanced++; instances += o.count; triInstanced += tris(o.geometry) * o.count; }
  else if (o instanceof Mesh) { meshes++; triStatic += tris(o.geometry); }
});
console.log('sample grid', map.cols, 'x', map.rows, 'cells;', 'B blocks:', mergeBlocks(map).length, 'bridge runs:', findBridgeRuns(map).length);
console.log('static meshes (draw calls if all visible):', meshes, 'triangles:', triStatic);
console.log('instanced meshes:', instanced, 'instances:', instances, 'triangles:', triInstanced, 'windows:', world.group.userData['windowCount']);
console.log('cullables:', world.cullables.length, 'detail objects:', world.detail.length);
// scale estimate to the real 50 x 38 grid (SPEC): area ratio
const ratio = (50 * 38) / (map.cols * map.rows);
console.log('scaled to 50x38 (x%.1f): ~%d static draws, ~%d static tris, ~%d window instances', ratio, Math.round(meshes * ratio), Math.round(triStatic * ratio), Math.round(Number(world.group.userData['windowCount']) * ratio));
console.log('hull tris', tris(buildHullGeometry()), 'trim tris', tris(buildTrimGeometry()), 'ferro tris', tris(buildFerroGeometry()));
for (const n of [2, 3, 4, 5, 6]) {
  const l = computeLayout(n, 1920, 1080);
  const c = l.cells[0]!;
  console.log(`${n} teams: cell ${c.w}x${c.h} aspect ${(c.w / c.h).toFixed(3)} vfov ${verticalFovDeg(c.w / c.h).toFixed(1)} minimap ${l.minimap.w}x${l.minimap.h}@${l.minimap.x},${l.minimap.y} spare ${l.spare ? `${l.spare.w}x${l.spare.h}` : 'none'}`);
}
// fog numbers
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
console.log('linear fog 40..140: factor at 80 m', smooth(40, 140, 80).toFixed(3), 'at 120 m', smooth(40, 140, 120).toFixed(3), 'at 140 m', smooth(40, 140, 140).toFixed(3));
const rho = Math.sqrt(Math.log(10)) / 120;
console.log('FogExp2 density for 90% at 120 m:', rho.toFixed(5), '-> at 250 m', (1 - Math.exp(-((250 * rho) ** 2))).toFixed(5));
console.log('shadow texel: 520 m / 2048 =', (520 / 2048).toFixed(3), 'm');
console.log('camera: boat centre below horizon', (Math.atan2(4, 9) * 180 / Math.PI).toFixed(1), 'deg; half vfov at 16:9', (verticalFovDeg(16 / 9) / 2).toFixed(1), 'deg');
