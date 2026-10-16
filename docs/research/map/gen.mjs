// gen.mjs - paints map.txt from geometric primitives. Design tool only; the
// deliverable is the resulting map.txt (pasted into shared/map.ts as a literal).
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 50, H = 38;
const g = Array.from({ length: H }, () => Array(W).fill('B'));
const set = (c, r, ch) => {
  if (c < 0 || r < 0 || c >= W || r >= H) throw new Error(`out of grid (${c},${r})`);
  g[r][c] = ch;
};
const get = (c, r) => g[r]?.[c] ?? 'B';
const rect = (c0, r0, c1, r1, ch) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set(c, r, ch); };
// 1-wide path through waypoints (straight segments, inclusive)
const path = (pts, ch = '~') => {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [c0, r0] = pts[i], [c1, r1] = pts[i + 1];
    if (c0 !== c1 && r0 !== r1) throw new Error(`diagonal segment ${pts[i]}->${pts[i + 1]}`);
    const dc = Math.sign(c1 - c0), dr = Math.sign(r1 - r0);
    let c = c0, r = r0;
    for (;;) { set(c, r, ch); if (c === c1 && r === r1) break; c += dc; r += dr; }
  }
};
// marker on an existing water cell
const mark = (c, r, ch) => {
  if (!'~L'.includes(get(c, r))) throw new Error(`${ch} at (${c},${r}) is on '${get(c, r)}', not water`);
  set(c, r, ch);
};
const solidIn = (c, r, ch) => {
  if (get(c, r) !== 'B') throw new Error(`${ch} at (${c},${r}) is on '${get(c, r)}', not building`);
  set(c, r, ch);
};

// ---- lagoon: strip along the east edge + the bacino bulge in front of the canal mouth
rect(42, 1, 48, 36, 'L');
rect(37, 17, 41, 31, 'L');

// ---- main canal, a reversed S like the Canal Grande
rect(1, 6, 29, 9, '~');                                    // arm 1: west mouth, eastbound along the north
for (let c = 29; c >= 14; c--) rect(c, 36 - c, c, 40 - c, '~'); // 45-degree run south-west, 5 cells tall per column
rect(14, 23, 36, 26, '~');                                 // arm 3: eastbound along the south into the bacino
rect(13, 24, 13, 25, '~');                                 // rounded hairpin tip

// ---- rii (1-wide side canals)
path([[7, 5], [7, 3], [24, 3], [24, 5]]);                  // N1 Rio Nord: bypass loop north of arm 1
path([[15, 2], [15, 1]]);                                   //    spur, dead end
path([[30, 8], [35, 8], [35, 12], [41, 12]]);               // N2 Rio dei Greci: bend -> lagoon
path([[41, 3], [32, 3], [32, 7]]);                          // N3 Rio dei Greci loop: lagoon -> joins N2 (ambush loop round the NE block)
path([[5, 10], [5, 16], [8, 16], [8, 20], [12, 20], [12, 24]]); // W1 Rio di San Polo: arm 1 -> hairpin tip
path([[4, 17], [4, 33], [13, 33], [13, 30], [18, 30], [18, 27]]); // W3 Rio Ovest + S1 Rio Terà: west side -> arm 3
path([[5, 17], [4, 17]]);                                   //    link W1 -> W3
path([[5, 22], [8, 22]]);                                   //    spur, dead end (quiet dock)
path([[12, 10], [12, 14], [10, 14], [10, 17], [17, 17], [17, 18]]); // W2 Rio dei Mendicanti: arm 1 -> diagonal
path([[14, 14], [14, 16]]);                                 //    spur, dead end
path([[41, 34], [31, 34], [31, 33], [23, 33], [23, 34], [15, 34], [15, 33], [14, 33]]); // S4 Rio della Giudecca: lagoon -> joins S1
path([[22, 27], [22, 30], [26, 30], [26, 31], [36, 31]]);   // S2 Rio dei Tolentini: arm 3 -> bacino
path([[31, 27], [31, 29], [36, 29]]);                       // S3 Rio Corto: arm 3 -> bacino
path([[27, 14], [27, 17], [30, 17], [30, 22]]);             // E1 Rio del Campanile: diagonal -> arm 3
path([[36, 18], [33, 18], [33, 22]]);                       // E2 Rio dell'Arsenale: bacino -> arm 3

// ---- bridges: '=' arches (water for physics), 'R' covered bridge
rect(9, 6, 9, 9, '=');     // 1 over arm 1
rect(20, 6, 20, 9, '=');   // 2 over arm 1
rect(35, 23, 35, 26, '='); // 3 over arm 3
for (const [c, r] of [[11, 3], [5, 13], [31, 31], [13, 31]]) mark(c, r, '='); // 4-7 over rii
rect(26, 23, 27, 26, 'R'); // covered bridge, 2 cells deep x 4 across, deck north-south

// ---- landmark tower on the wedge tip, piles in the lagoon
solidIn(19, 22, 'T');
for (const [c, r] of [[45, 5], [46, 16], [38, 24], [45, 29]]) mark(c, r, 'P');

// ---- docks (water cell with a quay)
for (const [c, r] of [
  [14, 6], [29, 10], [23, 13], [15, 26], [30, 26], [36, 23],
  [42, 6], [37, 17], [38, 31], [42, 35],
  [7, 16], [8, 22], [26, 33], [20, 3], [38, 12], [10, 33],
]) mark(c, r, 'S');

// ---- crates
for (const [c, r] of [
  [44, 3], [46, 9], [43, 14], [47, 31], [44, 33],                        // lagoon strip
  [39, 20], [43, 21], [41, 23], [45, 24], [39, 26], [43, 27], [41, 29],  // bacino cluster (densest)
  [6, 8], [18, 7], [26, 12], [20, 19], [22, 24], [33, 25],               // main canal
  [15, 1], [32, 5], [14, 14], [4, 31], [36, 34], [28, 17],               // rii and dead ends
]) mark(c, r, 'C');

const out = g.map((row) => row.join('')).join('\n') + '\n';
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(resolve(here, 'map.txt'), out);
process.stdout.write(out);
