// annotate.mjs - prints map.txt with a column ruler and row numbers, and a
// "human" rendering where the width classes are visible.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(resolve(here, 'map.txt'), 'utf8').split('\n').filter((l) => l.length);
const W = lines[0].length, H = lines.length;
const tens = '    ' + Array.from({ length: W }, (_, c) => (c % 10 === 0 ? String(c / 10) : ' ')).join('');
const ones = '    ' + Array.from({ length: W }, (_, c) => String(c % 10)).join('');
console.log(tens);
console.log(ones);
lines.forEach((l, r) => console.log(String(r).padStart(2, ' ') + '  ' + l + '  ' + String(r).padStart(2, ' ')));
console.log(ones);
console.log(tens);
console.log();
// human rendering: buildings as '#', water as ' ', lagoon as '.', bridges '=' / 'R', tower 'T', docks 'S', crates 'C', piles 'P'
const human = { B: '#', '~': ' ', L: '.', '=': '=', R: 'R', T: 'T', S: 'S', C: 'C', P: 'P' };
console.log(tens);
lines.forEach((l, r) => console.log(String(r).padStart(2, ' ') + '  ' + [...l].map((ch) => human[ch]).join('')));
