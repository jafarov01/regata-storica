import { MAP, isLagoon, cellAt, cellCentre } from './shared/map';
const m = MAP;
console.log('size', m.width, m.height, 'walls', m.walls.length, 'docks', m.docks.length, 'crates', m.crates.length, 'bridges', m.bridges.length, 'piles', m.piles.length, 'lagoonEdge', m.lagoonEdge, 'lagoonCells', m.lagoonCells.length);
console.log('tower', m.tower);
for (const b of m.bridges) console.log('bridge', b.kind, b.orientation, 'at', b.x, b.z, 'len', b.length, 'width', b.width);
for (const d of m.docks) console.log('dock', d.col, d.row, 'xz', d.x, d.z, 'heading deg', Math.round(d.heading * 180 / Math.PI));
const big = [...m.walls].sort((a, b) => b.w * b.d - a.w * a.d).slice(0, 3);
console.log('largest walls', big);
console.log('isLagoon at crate (43,21):', isLagoon(m, cellCentre(m, 43, 21).x, cellCentre(m, 43, 21).z), 'cellAt centre:', cellAt(m, 0, 0));
