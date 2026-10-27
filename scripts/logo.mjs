// Vyrobí z písma jména (site.json → pismoJmena) vektorové logo a vloží ho do index.html.
// Samotný soubor písma pak na web vůbec nemusí: licence Uncle Typewriter zakazuje
// dávat písmo na web ke stažení, ale použít ho na cokoli (třeba na logo) dovoluje.
// Spouští se příkazem: npm run logo

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FONTS = {
  'uncle-typewriter': { file: 'assets/fonts/nezverejnovat/uncle-typewriter.ttf', lowercase: true },
  'tox-typewriter': { file: 'assets/fonts/tox-typewriter.ttf' },
  'rat-typewriter': { file: 'assets/fonts/rat-typewriter.ttf' },
  'x-typewriter': { file: 'assets/fonts/XTypewriter-Regular.ttf' },
  'orange-typewriter': { file: 'assets/fonts/nezverejnovat/orange-typewriter.ttf' },
};

const site = JSON.parse(await readFile(path.join(ROOT, 'site.json'), 'utf8'));
const key = site.pismoJmena || site.pismo;
const conf = FONTS[key];
if (!conf) {
  console.error(`Pro písmo „${key}“ logo neumím, použije se obyčejný text.`);
  process.exit(1);
}

let font;
try {
  font = opentype.loadSync(path.join(ROOT, conf.file));
} catch {
  console.error(`Soubor písma ${conf.file} chybí. Logo se dá vyrobit jen na počítači, kde písmo je.`);
  process.exit(1);
}

const SIZE = 100; // 1em = 100 jednotek
let name = site.jmeno || 'Bea Krä';
if (conf.lowercase) name = name.toLowerCase();

const parts = [];
const bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
const grow = (x1, y1, x2, y2) => {
  bb.x1 = Math.min(bb.x1, x1);
  bb.y1 = Math.min(bb.y1, y1);
  bb.x2 = Math.max(bb.x2, x2);
  bb.y2 = Math.max(bb.y2, y2);
};
let x = 0;
const baseline = SIZE;
for (const ch of name) {
  const d = ch.normalize('NFD');
  const base = d[0];
  const glyph = font.charToGlyph(base);
  const p = glyph.getPath(x, baseline, SIZE);
  parts.push(p.toPathData(1));
  const gb = p.getBoundingBox();
  if (Number.isFinite(gb.x1)) grow(gb.x1, gb.y1, gb.x2, gb.y2);
  // Přehláska jako na psacím stroji: dvě čárky nad písmenem.
  if (d.length > 1 && d[1] === '̈') {
    // Obrys písmene je kvůli cákancům širší a vyšší, proto střed bereme ze šířky znaku
    // a výšku z výšky malých písmen.
    const cx = x + ((glyph.advanceWidth / font.unitsPerEm) * SIZE) / 2;
    const w = SIZE * 0.075;
    const h = SIZE * 0.2;
    const bottom = baseline - SIZE * 0.66;
    for (const dx of [-SIZE * 0.09, SIZE * 0.09]) {
      const l = cx + dx - w / 2;
      const r = w / 2;
      grow(l, bottom - h, l + w, bottom);
      parts.push(
        `M${(l + r).toFixed(1)} ${(bottom - h).toFixed(1)}h0a${r} ${r} 0 0 1 ${r} ${r}v${(h - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 ${-2 * r} 0v${(-(h - 2 * r)).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${-r}z`
      );
    }
  }
  x += (glyph.advanceWidth / font.unitsPerEm) * SIZE;
}

// Rozměry podle skutečných tvarů včetně inkoustových cákanců.
const pad = 2;
const vx = Math.floor(bb.x1 - pad);
const vy = Math.floor(bb.y1 - pad);
const vw = Math.ceil(bb.x2 - bb.x1 + pad * 2);
const vh = Math.ceil(bb.y2 - bb.y1 + pad * 2);

// Písmena mají stát tam, kde by stál text: cákance vlevo přetečou do okraje
// a na výšku je uprostřed hlavička písmen, ne celý obrázek i s cákanci.
const shiftX = vx / SIZE;
const shiftY = (vy + vh / 2 - (baseline - SIZE * 0.28)) / SIZE;
const svg =
  `<svg class="brand-logo" viewBox="${vx} ${vy} ${vw} ${vh}" width="${(vw / SIZE).toFixed(3)}em" height="${(vh / SIZE).toFixed(3)}em" ` +
  `style="margin-left:${shiftX.toFixed(3)}em;translate:0 ${shiftY.toFixed(3)}em" aria-hidden="true">` +
  `<path fill="currentColor" d="${parts.join('')}"/></svg>`;

const htmlFile = path.join(ROOT, 'index.html');
const html = await readFile(htmlFile, 'utf8');
const re = /<!-- logo -->[\s\S]*?<!-- \/logo -->/;
if (!re.test(html)) {
  console.error('V index.html chybí značky <!-- logo --> a <!-- /logo -->.');
  process.exit(1);
}
await writeFile(htmlFile, html.replace(re, `<!-- logo -->${svg}<!-- /logo -->`));
console.log(`Logo „${name}“ je v index.html (${(svg.length / 1024).toFixed(0)} kB).`);
