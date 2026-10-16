import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(resolve(here, p), 'utf8').replace(/\n$/, '');
const run = (args) => execFileSync('node', args, { cwd: here, encoding: 'utf8' }).replace(/\n$/, '');
let doc = rd('final.template.md');
const parts = {
  MAP: rd('map.txt'),
  ANNOTATED: run(['annotate.mjs']),
  VALIDATE_OUT: run(['validate.mjs']),
  MAP_TS: rd('ts/shared/map.ts'),
  MAP_TEST_TS: rd('ts/shared/map.test.ts'),
  MAP_PHYSICS_TS: rd('ts/src/sim/mapPhysics.ts'),
  MAP_GEOMETRY_TS: rd('ts/src/render/mapGeometry.ts'),
  VALIDATE_MJS: rd('validate.mjs'),
};
for (const [k, v] of Object.entries(parts)) {
  const marker = `<<${k}>>`;
  if (!doc.includes(marker)) throw new Error(`marker ${marker} missing`);
  doc = doc.replace(marker, () => v);
}
if (/<<[A-Z_]+>>/.test(doc)) throw new Error('unreplaced marker');
writeFileSync(resolve(here, 'final.md'), doc + '\n');
console.log('final.md', doc.length, 'chars');
