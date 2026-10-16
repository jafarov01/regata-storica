import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const mapTxt = readFileSync(resolve(here, '..', 'map.txt'), 'utf8');
const ts = readFileSync(resolve(here, '..', 'ts/shared/map.ts'), 'utf8');
const m = ts.match(/export const MAP_TEXT = `([\s\S]*?)`;/);
const mapText = m[1];
console.log('MAP_TEXT byte-identical to map.txt:', mapText === mapTxt);
const gridLines = mapText.split('\n').filter(l => l.length && !l.startsWith('#'));
console.log('MAP_TEXT grid lines (comments/blank removed) identical to map.txt:', gridLines.join('\n') + '\n' === mapTxt, '; MAP_TEXT has', mapText.split('\n').length, 'raw lines, starts with newline:', mapText.startsWith('\n'), '; comment lines:', mapText.split('\n').filter(l => l.startsWith('#')).length);
// 45 degree run detection using contiguous runs
const lines = mapTxt.split('\n').filter(Boolean); const W = 50, H = 38;
const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? 'B' : lines[r][c]);
const NAV = new Set(['~', '=', 'R', 'L', 'S', 'C']); const nav = (c, r) => NAV.has(at(c, r));
const runs = (c) => { const out = []; let s = -1; for (let r = 0; r <= H; r++) { const w = r < H && nav(c, r) && at(c, r) !== 'L'; if (w && s < 0) s = r; if (!w && s >= 0) { out.push([s, r - 1]); s = -1; } } return out; };
const diag = [];
for (let c = 1; c < W - 1; c++) for (const [a0, a1] of runs(c)) if (a1 - a0 + 1 === 5) for (const [b0, b1] of runs(c + 1)) if (b1 - b0 + 1 === 5 && a0 === b0 + 1) diag.push(`c${c}:${a0}-${a1}`);
console.log('45-degree run columns (5-tall, shifted 1 row vs next column):', diag.join(' '));
// main canal cells: recompute thick (3x3) and check every diagonal cell
const allW = (c0, r0, k) => { for (let r = r0; r < r0 + k; r++) for (let c = c0; c < c0 + k; c++) if (!nav(c, r)) return false; return true; };
const inWin = (c, r, k) => { for (let dr = -(k - 1); dr <= 0; dr++) for (let dc = -(k - 1); dc <= 0; dc++) if (allW(c + dc, r + dr, k)) return true; return false; };
let bad = []; for (const d of diag) { const [, c, a, b] = d.match(/c(\d+):(\d+)-(\d+)/).map(Number); for (let r = a; r <= b; r++) if (!inWin(c, r, 3)) bad.push(`(${c},${r})`); }
console.log('diagonal cells outside a 3x3 window:', bad.length ? bad.join(' ') : 'none');
// perpendicular width of the diagonal: for a band of 5 rows per column shifted one per column, the perpendicular distance between the band edges
// edges: top edge line r = r0 - (c - c0), bottom edge r = r0 + 4 - (c - c0) -> band thickness 5 cells vertically -> perpendicular (5)/sqrt(2) cells; with cell extents it is 5 cells of cell height projected: 5*8/sqrt2
console.log('perpendicular width:', (5 * 8 / Math.SQRT2).toFixed(1), 'm (centre-to-centre thickness is 4 rows -> ', (4 * 8 / Math.SQRT2).toFixed(1), 'm)');
// main canal path from the west mouth to the last main-canal column (36) via main-canal cells
const key = (c, r) => r * W + c;
const inL = (c, r) => at(c, r) === 'L';
// lagoon mask flood
const lag = new Uint8Array(W * H); { const q = []; for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (inL(c, r)) { lag[key(c, r)] = 1; q.push([c, r]); } for (let i = 0; i < q.length; i++) { const [c, r] = q[i]; for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nc = c + dc, nr = r + dr; if (lag[key(nc, nr)] || !['L','C','S','P'].includes(at(nc, nr))) continue; lag[key(nc, nr)] = 1; q.push([nc, nr]); } } }
const mainC = (c, r) => nav(c, r) && !lag[key(c, r)] && (inWin(c, r, 3) || ((c === 13) && (r === 24 || r === 25)));
const bfs = (seeds, pass) => { const d = new Int32Array(W * H).fill(-1); const q = []; for (const s of seeds) { d[key(...s)] = 0; q.push(s); } for (let i = 0; i < q.length; i++) { const [c, r] = q[i]; for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nc = c + dc, nr = r + dr; if (nc < 0 || nr < 0 || nc >= W || nr >= H || d[key(nc, nr)] !== -1 || !pass(nc, nr)) continue; d[key(nc, nr)] = d[key(c, r)] + 1; q.push([nc, nr]); } } return d; };
const d = bfs([[1,6],[1,7],[1,8],[1,9]], mainC);
for (const r of [23,24,25,26]) console.log(`main-canal steps from west mouth to (36,${r}):`, d[key(36, r)], ' to (35,'+r+'):', d[key(35, r)]);
// Count main canal cells along the center line between mouths: BFS "length" = max over the east-most main cells
let mx = 0; for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (mainC(c, r) && d[key(c, r)] > mx) mx = d[key(c, r)];
console.log('max main-canal BFS distance from the west mouth:', mx);
