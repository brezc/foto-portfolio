// Projde složku alba/, z originálů udělá webové verze do img/ a seznam alb do data/.
// Spouští se příkazem: npm run fotky

import { readdir, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import exifReader from 'exif-reader';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'alba');
const IMG_DIR = path.join(ROOT, 'img');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_FILE = path.join(ROOT, '.cache', 'fotky.json');

// Delší strana jednotlivých velikostí v pixelech. Prohlížeč si sám vybere tu, kterou potřebuje.
const SIZES = [640, 1280, 2400];
// AVIF je zhruba o polovinu menší než WebP při stejné viditelné kvalitě, takže se na web vejde víc fotek.
const FORMAT = 'avif';
const QUALITY = 50;
const BUILD_VERSION = 4; // zvýšit, když se změní způsob zpracování, aby se vše přegenerovalo

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);
// Web je anglicky, proto i automatické datum alba.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// album.txt přijímá české i anglické názvy polí.
const KEYS = { title: 'nazev', name: 'nazev', date: 'datum', place: 'misto', location: 'misto', description: 'popis', text: 'popis', cover: 'obal', order: 'razeni' };

const isTTY = process.stdout.isTTY;
const log = (...a) => console.log(...a);
const warn = (msg) => console.log(`  ! ${msg}`);

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function slugify(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function prettyFolderName(name) {
  // „2024-06 Island“ → „Island“
  return name.replace(/^\d{4}([-_.]\d{1,2}){0,2}[\s_-]+/, '').replace(/[_]+/g, ' ').trim() || name;
}

// album.txt: řádky „klíč: hodnota“. Řádek bez klíče pokračuje předchozí hodnotou.
function parseAlbumTxt(text) {
  const out = {};
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([^:\s][^:]{0,30}):\s*(.*)$/);
    if (m) {
      last = stripDiacritics(m[1]).toLowerCase().trim();
      last = KEYS[last] || last;
      out[last] = m[2].trim();
    } else if (last) {
      out[last] += '\n' + raw.trim();
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

// Datum z album.txt („July 2025“, „červenec 2025“, „2025“) pro řazení alb. Hodí se, když má
// foťák špatně nastavené hodiny a datum z fotek nesedí.
const CZ_MONTHS = ['leden', 'unor', 'brezen', 'duben', 'kveten', 'cerven', 'cervenec', 'srpen', 'zari', 'rijen', 'listopad', 'prosinec'];
function parseDateText(text) {
  const t = stripDiacritics(String(text || '')).toLowerCase();
  const year = t.match(/\b(19|20)\d{2}\b/)?.[0];
  if (!year) return null;
  let month = MONTHS.findIndex((m) => t.includes(m.toLowerCase()));
  if (month < 0) {
    // „cervenec“ obsahuje „cerven“, proto se hledá od nejdelšího názvu
    const byLength = CZ_MONTHS.map((m, i) => [m, i]).sort((a, b) => b[0].length - a[0].length);
    month = byLength.find(([m]) => t.includes(m))?.[1] ?? 0;
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}

function formatExif(ex) {
  if (!ex) return '';
  const I = ex.Image || {};
  const P = ex.Photo || {};
  const parts = [];
  const make = String(I.Make || '').trim();
  let model = String(I.Model || '').trim();
  if (model) {
    if (make && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0])) {
      const niceMake = make.length <= 4 ? make : make[0] + make.slice(1).toLowerCase();
      model = `${niceMake} ${model}`;
    }
    parts.push(model);
  }
  if (P.FocalLength) parts.push(`${Math.round(P.FocalLength)} mm`);
  if (P.FNumber) parts.push(`f/${+P.FNumber.toFixed(1)}`);
  if (P.ExposureTime) {
    const t = P.ExposureTime;
    parts.push(t >= 1 ? `${+t.toFixed(1)} s` : `1/${Math.round(1 / t)} s`);
  }
  const iso = P.ISOSpeedRatings ?? P.PhotographicSensitivity;
  if (iso) parts.push(`ISO ${Array.isArray(iso) ? iso[0] : iso}`);
  return parts.join(' · ');
}

function plural(n, one, few, many) {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}

function toHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readSite() {
  const file = path.join(ROOT, 'site.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`\nV souboru site.json je chyba: ${e.message}`);
    console.error('Zkontroluj uvozovky a čárky mezi řádky.\n');
    process.exit(1);
  }
}

async function processPhoto(file, albumSlug, id) {
  const meta = await sharp(file).metadata();
  let { width, height } = meta;
  if ((meta.orientation || 1) >= 5) [width, height] = [height, width];
  const long = Math.max(width, height);

  let exif = null;
  if (meta.exif) {
    try {
      exif = exifReader(meta.exif);
    } catch {
      exif = null;
    }
  }

  // Jedno dekódování originálu: zmenšíme na největší velikost a z ní děláme ostatní.
  const maxLong = Math.min(long, SIZES[SIZES.length - 1]);
  const maxW = Math.round((width * maxLong) / long);
  const { data, info } = await sharp(file, { failOn: 'none' })
    .rotate()
    .resize({ width: maxW })
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawOpts = { raw: { width: info.width, height: info.height, channels: info.channels } };

  const longs = [...new Set([...SIZES.filter((s) => s < maxLong), maxLong])];
  const widths = [];
  for (const l of longs) {
    const w = Math.round((info.width * l) / Math.max(info.width, info.height));
    widths.push(w);
    await sharp(data, rawOpts)
      .resize({ width: w })
      .avif({ quality: QUALITY, effort: 4 })
      .toFile(path.join(IMG_DIR, albumSlug, `${id}-${w}.${FORMAT}`));
  }

  const lqip = await sharp(data, rawOpts).resize({ width: 24 }).webp({ quality: 40 }).toBuffer();
  const { dominant } = await sharp(data, rawOpts).resize({ width: 64 }).stats();

  const taken = exif?.Photo?.DateTimeOriginal;
  return {
    photo: {
      id,
      e: FORMAT,
      w: info.width,
      h: info.height,
      v: widths,
      c: toHex(dominant),
      q: `data:image/webp;base64,${lqip.toString('base64')}`,
      x: formatExif(exif),
    },
    taken: taken instanceof Date && !isNaN(taken) ? taken.toISOString() : null,
  };
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const started = Date.now();
  if (!existsSync(SRC_DIR)) {
    console.error('Složka alba/ neexistuje. Vytvoř ji a dej do ní podsložky s fotkami.');
    process.exit(1);
  }

  const site = await readSite();
  const cache = await readJson(CACHE_FILE, { version: BUILD_VERSION, entries: {} });
  if (cache.version !== BUILD_VERSION) cache.entries = {};
  const nextCache = { version: BUILD_VERSION, entries: {} };

  const folders = (await readdir(SRC_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name);

  if (!folders.length) {
    console.error('Ve složce alba/ není žádné album. Nic se nezměnilo.');
    process.exit(1);
  }

  const albums = [];
  const usedSlugs = new Set();
  const jobs = [];

  for (const folder of folders) {
    const dir = path.join(SRC_DIR, folder);
    let slug = slugify(prettyFolderName(folder));
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${slugify(prettyFolderName(folder))}-${n}`;
    usedSlugs.add(slug);

    let info = {};
    const txt = path.join(dir, 'album.txt');
    if (existsSync(txt)) info = parseAlbumTxt(await readFile(txt, 'utf8'));

    const files = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'cs', { numeric: true }));

    const photos = [];
    const usedIds = new Set();
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      if (name === 'album.txt') continue;
      if (!SUPPORTED.has(ext)) {
        if (['.heic', '.heif'].includes(ext)) warn(`${folder}/${name}: HEIC neumím, vyexportuj ho jako JPEG.`);
        else if (!['.txt', '.md', '.xmp', '.aae', '.ds_store'].includes(ext)) warn(`${folder}/${name}: přeskakuji (nepodporovaný formát).`);
        continue;
      }
      let id = slugify(path.parse(name).name);
      for (let n = 2; usedIds.has(id); n++) id = `${slugify(path.parse(name).name)}-${n}`;
      usedIds.add(id);
      const entry = { name, id, file: path.join(dir, name), result: null };
      photos.push(entry);
      jobs.push({ album: slug, folder, entry });
    }

    if (!photos.length) {
      warn(`${folder}: žádné fotky, album vynechávám.`);
      usedSlugs.delete(slug);
      continue;
    }
    albums.push({ folder, slug, info, photos });
  }

  // Zpracování fotek (s cache, takže se znovu dělají jen nové nebo změněné).
  let done = 0;
  let fresh = 0;
  const failed = [];
  const concurrency = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

  await pool(jobs, concurrency, async ({ album, folder, entry }) => {
    const key = `${folder}/${entry.name}`;
    const st = await stat(entry.file);
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
    const cached = cache.entries[key];
    const outputsExist =
      cached && cached.album === album && cached.result.photo.id === entry.id &&
      cached.result.photo.v.every((w) => existsSync(path.join(IMG_DIR, album, `${entry.id}-${w}.${cached.result.photo.e || 'webp'}`)));

    if (cached && cached.sig === sig && outputsExist) {
      entry.result = cached.result;
    } else {
      await mkdir(path.join(IMG_DIR, album), { recursive: true });
      try {
        entry.result = await processPhoto(entry.file, album, entry.id);
        fresh++;
      } catch (e) {
        failed.push(`${key}: ${e.message}`);
      }
    }
    if (entry.result) nextCache.entries[key] = { sig, album, result: entry.result };
    done++;
    if (isTTY) process.stdout.write(`\r  Zpracovávám fotky: ${done}/${jobs.length}   `);
  });
  if (isTTY) process.stdout.write('\n');

  // Výstupní data.
  const index = [];
  await mkdir(path.join(DATA_DIR, 'album'), { recursive: true });

  for (const a of albums) {
    const ok = a.photos.filter((p) => p.result);
    if (!ok.length) continue;
    // Pořadí fotek (album.txt → order):
    //   order: date        podle data focení
    //   order:             a pod tím názvy souborů, každý na řádku (přípona není nutná);
    //                      fotky, které v seznamu chybí, jdou na konec podle data focení
    //   bez order          podle názvu souboru
    const byDate = (x, y) => (x.result.taken || '9').localeCompare(y.result.taken || '9') || x.name.localeCompare(y.name, 'cs', { numeric: true });
    const order = (a.info.razeni || '').trim();
    if (/^dat/i.test(stripDiacritics(order))) {
      ok.sort(byDate);
    } else if (order) {
      const norm = (n) => stripDiacritics(path.parse(n.trim()).name).toLowerCase();
      const wanted = order.split(/\r?\n/).map(norm).filter(Boolean);
      const rank = (p) => {
        const r = wanted.indexOf(norm(p.name));
        return r < 0 ? wanted.length : r;
      };
      for (const w of wanted) if (!ok.some((p) => norm(p.name) === w)) warn(`${a.folder}: v pořadí je „${w}“, ale taková fotka ve složce není.`);
      ok.sort((x, y) => rank(x) - rank(y) || byDate(x, y));
    }
    // Název souboru (bez přípony) slouží jako popis fotky.
    const photos = ok.map((p) => ({ ...p.result.photo, t: path.parse(p.name).name }));

    let coverIndex = 0;
    if (a.info.obal) {
      const want = a.info.obal.toLowerCase();
      const found = ok.findIndex((p) => p.name.toLowerCase() === want || path.parse(p.name).name.toLowerCase() === want);
      if (found >= 0) coverIndex = found;
      else warn(`${a.folder}: obal „${a.info.obal}“ ve složce není, beru první fotku.`);
    }

    const dates = ok.map((p) => p.result.taken).filter(Boolean).sort();
    const first = dates[0] ? new Date(dates[0]) : null;
    const autoDate = first ? `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}` : '';

    const album = {
      slug: a.slug,
      title: a.info.nazev || prettyFolderName(a.folder),
      date: a.info.datum || autoDate,
      place: a.info.misto || '',
      description: a.info.popis || '',
      count: photos.length,
      cover: photos[coverIndex],
      sort: parseDateText(a.info.datum) || (first ? first.toISOString() : ''),
      folder: a.folder,
    };
    index.push(album);
    await writeFile(
      path.join(DATA_DIR, 'album', `${a.slug}.json`),
      JSON.stringify({ slug: a.slug, coverIndex, photos })
    );
  }

  // Nejnovější alba nahoře. Alba bez data focení řadíme podle názvu složky.
  index.sort((x, y) => (y.sort || '').localeCompare(x.sort || '') || y.folder.localeCompare(x.folder, 'cs', { numeric: true }));
  for (const a of index) {
    delete a.sort;
    delete a.folder;
  }

  await writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify({ site, albums: index }, null, 1));

  // Úklid: smaže webové verze fotek a alb, které už ve složce alba/ nejsou.
  const keepAlbums = new Set(index.map((a) => a.slug));
  const keepFiles = new Set();
  for (const a of albums) for (const p of a.photos) if (p.result) for (const w of p.result.photo.v) keepFiles.add(`${a.slug}/${p.id}-${w}.${p.result.photo.e || 'webp'}`);

  let removed = 0;
  if (existsSync(IMG_DIR)) {
    for (const d of await readdir(IMG_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (!keepAlbums.has(d.name)) {
        await rm(path.join(IMG_DIR, d.name), { recursive: true, force: true });
        removed++;
        continue;
      }
      for (const f of await readdir(path.join(IMG_DIR, d.name))) {
        if (/\.(webp|avif)$/.test(f) && !keepFiles.has(`${d.name}/${f}`)) {
          await rm(path.join(IMG_DIR, d.name, f));
          removed++;
        }
      }
    }
  }
  for (const f of await readdir(path.join(DATA_DIR, 'album'))) {
    if (f.endsWith('.json') && !keepAlbums.has(f.slice(0, -5))) await rm(path.join(DATA_DIR, 'album', f));
  }

  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(nextCache));

  // Styly a skript dostanou v index.html značku verze podle obsahu. Po nahrání změn si je
  // prohlížeč stáhne znovu, místo aby ještě chvíli používal staré z mezipaměti.
  const htmlFile = path.join(ROOT, 'index.html');
  let html = await readFile(htmlFile, 'utf8');
  for (const asset of ['assets/css/style.css', 'assets/js/app.js']) {
    const hash = createHash('md5').update(await readFile(path.join(ROOT, asset))).digest('hex').slice(0, 8);
    html = html.replace(new RegExp(`${asset.replace(/[./]/g, '\\$&')}(\\?v=\\w+)?`), `${asset}?v=${hash}`);
  }
  await writeFile(htmlFile, html);

  // Shrnutí.
  let bytes = 0;
  for (const slug of keepAlbums) {
    for (const f of await readdir(path.join(IMG_DIR, slug))) bytes += (await stat(path.join(IMG_DIR, slug, f))).size;
  }
  const total = index.reduce((n, a) => n + a.count, 0);
  log('');
  for (const a of index) log(`  ${a.title.padEnd(28)} ${String(a.count).padStart(4)} ${plural(a.count, 'fotka', 'fotky', 'fotek').padEnd(5)}   ${a.date}`);
  log('');
  log(`  Hotovo za ${((Date.now() - started) / 1000).toFixed(1)} s: ${index.length} ${plural(index.length, 'album', 'alba', 'alb')}, ${total} ${plural(total, 'fotka', 'fotky', 'fotek')} (${fresh} nově zpracovaných${removed ? `, ${removed} smazaných starých souborů` : ''}).`);
  log(`  Velikost webových fotek: ${(bytes / 1024 / 1024).toFixed(0)} MB`);
  if (failed.length) {
    log('\n  Tyhle fotky se nepodařilo zpracovat:');
    for (const f of failed) log(`   - ${f}`);
  }
  log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
