// Celý web je jedna stránka: úvod se seznamem alb, album a prohlížeč fotek.
// Adresy: #/ (úvod), #/slug-alba (album), #/slug-alba/3 (třetí fotka v prohlížeči).

import { ART } from './ascii.js';

const root = document.documentElement;
const view = document.getElementById('view');
const header = document.getElementById('header');
const footer = document.getElementById('footer');

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canVT = typeof document.startViewTransition === 'function' && !reduceMotion;
// Na dotykovém displeji se alba na úvodu listují tažením do stran, na počítači scrollováním.
const swipeMQ = matchMedia('(hover: none) and (pointer: coarse)');

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
const EASE_SOFT = 'cubic-bezier(0.25, 0.1, 0.1, 1)';

const state = {
  site: {},
  albums: [],
  data: new Map(), // slug → Promise s fotkami alba
  view: null, // 'home' | 'album' | 'missing'
  slug: null,
  album: null,
  photos: [],
  homeScroll: null,
  homeIndex: null,
};

let lenis = null;
let ignorePop = 0;

// ===== Pomocníci =====

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n) => String(n).padStart(2, '0');
const srcOf = (slug, p, w) => `img/${slug}/${p.id}-${w}.${p.e || 'webp'}`;
const srcsetOf = (slug, p) => p.v.map((w) => `${srcOf(slug, p, w)} ${w}w`).join(', ');
const phStyle = (p) => `--c:${p.c};--q:url(${p.q})`;
const hrefAlbum = (slug) => `#/${slug}`;
const hrefPhoto = (slug, i) => `#/${slug}/${i + 1}`;
const clampIndex = (i) => Math.max(0, Math.min(state.photos.length - 1, i));

function inViewport(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function jumpTo(y) {
  if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
  else window.scrollTo(0, y);
}

function decoded(img) {
  if (!img) return Promise.resolve();
  const p = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  return Promise.race([p, new Promise((r) => setTimeout(r, 500))]);
}

// Obrázek se po načtení jemně prolne přes rozmazaný náhled.
function wire(img) {
  const ph = img.closest('.ph');
  if (!ph) return;
  if (img.complete && img.naturalWidth) ph.classList.add('ld');
  else img.addEventListener('load', () => ph.classList.add('ld'), { once: true });
}

function setInert(on) {
  for (const n of [header, view, footer]) n.inert = on;
}

// ===== Data =====

async function loadIndex() {
  // Seznam alb se vždy ověří u serveru, ať se po nahrání nových fotek neukazuje starý.
  const r = await fetch('data/index.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`data/index.json: ${r.status}`);
  return r.json();
}

function loadAlbum(slug) {
  let p = state.data.get(slug);
  if (!p) {
    p = fetch(`data/album/${encodeURIComponent(slug)}.json`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`album ${slug}: ${r.status}`);
      return r.json();
    });
    p.catch(() => state.data.delete(slug));
    state.data.set(slug, p);
  }
  return p;
}

// ===== Objevování při scrollování =====

const revealIO = new IntersectionObserver(
  (entries) => {
    let k = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      revealIO.unobserve(el);
      const delay = Math.min(k++ * 80, 480);
      if (delay) {
        el.style.transitionDelay = `${delay}ms`;
        setTimeout(() => (el.style.transitionDelay = ''), delay + 1400);
      }
      el.classList.add('in');
    }
  },
  { rootMargin: '0px 0px -4% 0px' }
);

function observeReveals(scope, { instantInView = false } = {}) {
  for (const el of scope.querySelectorAll('.reveal:not(.in)')) {
    if (reduceMotion || (instantInView && inViewport(el))) {
      el.classList.add('in', 'instant');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('instant')));
    } else {
      revealIO.observe(el);
    }
  }
}

// ===== Psací stroj: znaky, které písmo nemá =====

// Starý psací stroj neměl přehlásky ani čárky. „ä“ se psalo jako „a“, krok zpět a přes něj uvozovky.
// Stejně to skládáme u písem, kterým tyhle znaky chybí. Čtečky obrazovky dostanou původní text.
const MARKS = { '̈': '"', '́': "'", '̀': '`', '̂': '^', '̃': '~' };
let fontInfo = {};
let brandInfo = {};

function typeset(text, info = fontInfo) {
  const t = String(text ?? '');
  if (!info.overstrike || /^[\x00-\x7f]*$/.test(t)) return esc(t);
  let html = '';
  for (const ch of t) {
    const d = ch.normalize('NFD');
    const mark = d.length === 2 && /[a-z]/i.test(d[0]) ? MARKS[d[1]] : null;
    html += mark ? `<span class="ovr">${d[0]}<span>${esc(mark)}</span></span>` : esc(ch);
  }
  return `<span aria-hidden="true">${html}</span><span class="sr">${esc(t)}</span>`;
}

// ===== Úvod =====

// Úvod je „přihrádka“: obaly alb jsou založené za sebou jako složky. Aktuální album je vepředu
// vlevo dole, další stojí za ním vějířem doprava nahoru. Na počítači se listuje obyčejným
// scrollováním: sekce je vysoká a scénu drží position: sticky. Na dotykovém displeji se listuje
// tažením prstu do stran. Listnuté album odjede doleva dolů a zmizí.

function vinylHTML(a, i) {
  const p = a.cover;
  return `
    <a class="vinyl" href="${hrefAlbum(a.slug)}" data-slug="${esc(a.slug)}" data-i="${i}" aria-label="${esc(a.title)}">
      <span class="vinyl-face ph" style="${phStyle(p)}">
        <img alt="" src="${srcOf(a.slug, p, p.v[Math.min(1, p.v.length - 1)])}" srcset="${srcsetOf(a.slug, p)}"
          sizes="(max-width: 700px) 70vw, 36vw" ${i < 4 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">
      </span>
    </a>`;
}

function renderHome({ intro = false } = {}) {
  const { site, albums } = state;
  const total = albums.reduce((n, a) => n + a.count, 0);
  const swipe = swipeMQ.matches;
  const hint = swipe
    ? `<svg class="hint-arrow" viewBox="0 0 22 10"><path d="M21 5H2M5.5 1.5L2 5l3.5 3.5"/></svg>
            <span class="meta">swipe</span>`
    : `<span class="meta">scroll</span>
            <svg class="hint-arrow" viewBox="0 0 10 22"><path d="M5 1v19M1.5 16.5L5 20l3.5-3.5"/></svg>`;
  if (!albums.length) {
    view.innerHTML = `<p class="empty">No albums yet.</p>`;
  } else {
    view.innerHTML = `
      <section class="crate${swipe ? ' is-swipe' : ''}">
        <h1 class="sr">${esc([site.jmeno, site.nadpis || 'Photography'].filter(Boolean).join(', '))}</h1>
        <div class="crate-stage">
          <div class="crate-deck">${albums.map(vinylHTML).join('')}</div>
          <div class="crate-info">
            <p class="meta"><span data-crate-num>01</span> / ${pad2(albums.length)}</p>
            <h2 class="crate-title" data-crate-title></h2>
            <p class="meta" data-crate-meta></p>
          </div>
          <nav class="crate-index" aria-label="Albums">
            <p class="meta">${count(albums.length, 'album')} · ${count(total, 'photo')}</p>
            <ol>${albums
              .map((a, i) => `<li><a href="${hrefAlbum(a.slug)}" data-i="${i}">${typeset(a.title)}</a></li>`)
              .join('')}</ol>
          </nav>
          <div class="crate-hint" aria-hidden="true">
            ${hint}
          </div>
        </div>
      </section>`;
    for (const img of view.querySelectorAll('.vinyl img')) wire(img);
  }
  state.view = 'home';
  state.slug = null;
  menu.setCurrent('');
  crate.mount(view.querySelector('.crate'), { intro });
}

const crate = {
  el: null,
  cards: [],
  links: [],
  n: 0,
  top: 0,
  step: 400,
  pos: 0,
  active: -1,
  geo: null,
  intro: null,
  snapTimer: 0,
  swipe: false, // listuje se tažením do stran (dotykový displej)
  hpos: 0, // pozice při listování do stran: 0 = první album, 1 = druhé…
  dragStep: 200, // kolik pixelů tažení je jedno album
  drag: null,
  anim: 0,
  suppressClick: 0,

  mount(el, { intro = false } = {}) {
    this.el = el;
    this.active = -1;
    cancelAnimationFrame(this.anim);
    this.drag = null;
    if (!el) return;
    this.quiet = intro; // názvy se ukážou až po prvním scrollnutí
    el.classList.toggle('is-quiet', this.quiet);
    this.swipe = el.classList.contains('is-swipe');
    this.hpos = 0;
    if (this.swipe) this.bindSwipe(el.querySelector('.crate-stage'));
    this.cards = [...el.querySelectorAll('.vinyl')];
    this.links = [...el.querySelectorAll('.crate-index a')];
    this.n = this.cards.length;
    this.measure();
    this.intro = intro && !reduceMotion ? performance.now() : null;
    this.loadY = window.scrollY;
    this.update();
    if (this.intro) this.loop();
  },

  reveal() {
    if (!this.quiet || !this.el?.isConnected) return;
    this.quiet = false;
    this.el.classList.remove('is-quiet');
  },

  // Rozměry podle okna. Podle reference: řada stoupá doprava nahoru a obaly se svažují
  // doprava dolů (oba sklony asi 18°), vepředu vlevo dole je aktuální album.
  measure() {
    if (!this.el) return;
    const W = document.documentElement.clientWidth;
    const H = window.innerHeight;
    const small = W < 700;
    this.step = Math.round(Math.min(420, Math.max(220, H * 0.36)));
    // Při listování do stran je sekce vysoká jen jednu obrazovku.
    this.el.style.height = this.swipe ? '' : `${H + (this.n - 1) * this.step}px`;
    this.dragStep = Math.max(140, W * 0.42);
    const angle = 0.32; // asi 18°
    const cw = small ? W * 0.56 : Math.min(400, Math.max(220, W * 0.23));
    this.el.style.setProperty('--cw', `${cw}px`);
    this.el.style.setProperty('--skew', `${angle}rad`);
    this.geo = {
      tan: Math.tan(angle),
      fan: cw * (small ? 0.26 : 0.34), // rozestup založených obalů
      away: cw * 1.15, // kam odjede listnuté album (dolů doleva, pryč z přihrádky)
      x0: small ? -W * 0.14 : -W * 0.18, // aktuální album je vlevo od středu
      y0: small ? H * 0.06 : H * 0.1,
      W,
    };
    this.top = this.el.getBoundingClientRect().top + window.scrollY;

    // Nápověda „scroll“: na počítači vpravo za poslední viditelnou deskou, svisle na středu
    // její pravé hrany. Na mobilu vpravo místo není, tak stojí pod přední deskou.
    const hint = this.el.querySelector('.crate-hint');
    if (hint) {
      const tan = Math.tan(angle);
      const cx = W / 2 + this.geo.x0;
      const cy = H / 2 + this.geo.y0;
      if (small) {
        hint.style.left = `${cx}px`;
        hint.style.top = `${cy + (cw * 4) / 6 + (cw * tan) / 2 + 20}px`;
        hint.style.translate = '-50% 0';
      } else {
        const gap = Math.max(48, cw * 0.3);
        const hintW = hint.offsetWidth || 60;
        let i = Math.min(this.n - 1, 8);
        while (i > 0 && cx + i * this.geo.fan + cw / 2 + gap + hintW > W - 24) i--;
        const right = cx + i * this.geo.fan + cw / 2;
        const mid = cy - i * this.geo.fan * tan + (cw / 2) * tan;
        hint.style.left = `${Math.min(right + gap, W - 24 - hintW)}px`;
        hint.style.top = `${mid}px`;
        hint.style.translate = '0 -50%';
      }
    }
  },

  update() {
    if (!this.el?.isConnected) return;
    const { tan, fan, away, x0, y0, W } = this.geo;
    if (this.swipe) {
      this.pos = this.n > 1 ? this.hpos : 0;
    } else {
      const range = Math.max(1, (this.n - 1) * this.step);
      const p = Math.min(1, Math.max(0, (window.scrollY - this.top) / range));
      this.pos = this.n > 1 ? p * (this.n - 1) : 0;
    }
    const now = performance.now();
    for (let i = 0; i < this.n; i++) {
      const d = i - this.pos;
      // Další alba stojí za aktuálním vějířem doprava nahoru, listnutá odjíždějí doleva dolů a mizí.
      let x = d >= 0 ? d * fan : d * away;
      let alpha = d >= 0 ? (d > 9 ? Math.max(0, 1 - (d - 9) / 2) : 1) : Math.max(0, 1 + d * 1.4);
      if (this.intro) {
        // Při prvním načtení se obaly rozloží z jednoho balíčku do vějíře.
        const t = Math.min(1, Math.max(0, (now - this.intro - i * 70) / 1300));
        const e = 1 - Math.pow(1 - t, 4);
        x = x * e + (1 - e) * W * 0.25;
        alpha *= Math.min(1, t * 2.5);
      }
      const card = this.cards[i];
      card.style.transform = `translate3d(${(x0 + x).toFixed(1)}px, ${(y0 - x * tan).toFixed(1)}px, 0)`;
      card.style.zIndex = String(1000 - Math.round(d * 10));
      card.style.opacity = alpha.toFixed(3);
      card.style.visibility = alpha < 0.01 ? 'hidden' : '';
    }
    const active = Math.min(this.n - 1, Math.max(0, Math.round(this.pos)));
    if (active !== this.active) this.setActive(active);
  },

  loop() {
    this.update();
    if (this.intro && performance.now() - this.intro > 1300 + this.n * 70) this.intro = null;
    if (this.intro) requestAnimationFrame(() => this.loop());
  },

  setActive(i) {
    const first = this.active < 0;
    this.active = i;
    const a = state.albums[i];
    this.cards.forEach((c, k) => c.classList.toggle('is-active', k === i));
    this.links.forEach((l, k) => l.classList.toggle('is-active', k === i));
    const info = this.el.querySelector('.crate-info');
    const write = () => {
      info.querySelector('[data-crate-num]').textContent = pad2(i + 1);
      info.querySelector('[data-crate-title]').innerHTML = typeset(a.title);
      info.querySelector('[data-crate-meta]').textContent = [a.date, count(a.count, 'photo')].filter(Boolean).join(' · ');
    };
    if (first || reduceMotion) write();
    else {
      info.getAnimations().forEach((x) => x.cancel());
      info.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { duration: 160, easing: 'ease-in' })
        .finished.then(() => {
          write();
          info.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: EASE_OUT });
        })
        .catch(() => {});
    }
    loadAlbum(a.slug).catch(() => {});
  },

  scrollFor(i) {
    return this.top + i * this.step;
  },

  goTo(i) {
    i = Math.max(0, Math.min(this.n - 1, i));
    if (this.swipe) return this.animateTo(i);
    const y = this.scrollFor(i);
    if (lenis) lenis.scrollTo(y, { duration: 1.2 });
    else window.scrollTo({ top: y, behavior: 'smooth' });
  },

  setPos(i) {
    cancelAnimationFrame(this.anim);
    this.hpos = Math.max(0, Math.min(this.n - 1, i));
    this.update();
  },

  // Plynulé dojetí na album při listování do stran.
  animateTo(target) {
    cancelAnimationFrame(this.anim);
    const from = this.hpos;
    const dist = Math.abs(target - from);
    if (dist < 0.001 || reduceMotion) return this.setPos(target);
    const dur = Math.min(950, 520 + dist * 160);
    const t0 = performance.now();
    const frame = (now) => {
      if (!this.el?.isConnected) return;
      const t = Math.min(1, (now - t0) / dur);
      this.hpos = from + (target - from) * (1 - Math.pow(1 - t, 4));
      this.update();
      if (t < 1) this.anim = requestAnimationFrame(frame);
    };
    this.anim = requestAnimationFrame(frame);
  },

  // Tažení prstem do stran. Svislý pohyb si nechává prohlížeč (touch-action: pan-y),
  // takže stránka jde dál scrollovat dolů k patičce.
  bindSwipe(stage) {
    stage.addEventListener('pointerdown', (e) => this.dragStart(e));
    stage.addEventListener('pointermove', (e) => this.dragMove(e));
    stage.addEventListener('pointerup', (e) => this.dragEnd(e));
    stage.addEventListener('pointercancel', (e) => this.dragEnd(e));
    // Po tažení se neotevírá album, na kterém prst začal.
    stage.addEventListener(
      'click',
      (e) => {
        if (performance.now() < this.suppressClick) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  },

  dragStart(e) {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    cancelAnimationFrame(this.anim);
    this.drag = { id: e.pointerId, x: e.clientX, from: this.hpos, moved: false, samples: [[e.timeStamp, this.hpos]] };
  },

  dragMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < 6) return;
      d.moved = true;
      this.reveal();
    }
    // Za prvním a posledním albem se táhne jen ztěžka, jako gumička.
    const max = this.n - 1;
    let p = d.from - dx / this.dragStep;
    if (p < 0) p *= 0.35;
    else if (p > max) p = max + (p - max) * 0.35;
    this.hpos = p;
    d.samples.push([e.timeStamp, p]);
    if (d.samples.length > 6) d.samples.shift();
    this.update();
  },

  dragEnd(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.moved) return; // obyčejné ťuknutí, album se otevře kliknutím
    this.suppressClick = performance.now() + 400;
    // Rychlost z posledních pohybů: švihnutí posune o album dál, i když prst ujel kousek,
    // ale nanejvýš o jedno album navíc, ať se nepřeletí na konec.
    const recent = d.samples.filter(([t]) => e.timeStamp - t < 120);
    let v = 0;
    if (recent.length > 1) {
      const [t0, p0] = recent[0];
      const [t1, p1] = recent[recent.length - 1];
      v = (p1 - p0) / Math.max(1, t1 - t0);
    }
    let target = Math.round(this.hpos + Math.max(-1, Math.min(1, v * 220)));
    if (target === Math.round(d.from) && Math.abs(v) > 0.002) target += Math.sign(v);
    this.animateTo(Math.max(0, Math.min(this.n - 1, target)));
  },

  // Po dojetí scrollu se deska jemně dorovná na střed.
  scheduleSnap() {
    clearTimeout(this.snapTimer);
    if (!this.el?.isConnected || this.n < 2 || this.swipe) return;
    this.snapTimer = setTimeout(() => {
      // Mezitím se mohlo otevřít album: bez desek by se srovnávalo podle staré pozice
      // a nová stránka by odjela dolů.
      if (!this.el?.isConnected || state.view !== 'home') return;
      this.update();
      const y = window.scrollY;
      if (y < this.top - 2 || y > this.top + (this.n - 1) * this.step + 2) return;
      const target = this.scrollFor(Math.round(this.pos));
      if (Math.abs(target - y) < 3) return;
      if (lenis) lenis.scrollTo(target, { duration: 0.8 });
      else window.scrollTo({ top: target, behavior: 'smooth' });
    }, 180);
  },
};

window.addEventListener(
  'scroll',
  () => {
    if (!crate.el?.isConnected) return;
    if (crate.quiet && Math.abs(window.scrollY - crate.loadY) > 4) crate.reveal();
    requestAnimationFrame(() => crate.update());
    crate.scheduleSnap();
  },
  { passive: true }
);

// Začátek scrollování poznáme i nahoře na stránce, kde se scroll ještě nepohne.
for (const type of ['wheel', 'touchmove']) {
  window.addEventListener(type, () => crate.quiet && crate.reveal(), { passive: true });
}

window.addEventListener('resize', () => {
  if (!crate.el?.isConnected) return;
  crate.measure();
  crate.update();
});

// Kdyby se způsob ovládání změnil (třeba připojená myš k tabletu), úvod se překreslí.
swipeMQ.addEventListener?.('change', () => {
  if (state.view !== 'home' || !crate.el?.isConnected) return;
  const i = Math.max(0, crate.active);
  renderHome();
  if (crate.swipe) crate.setPos(i);
  else jumpTo(crate.scrollFor(i));
  crate.update();
});

document.addEventListener('keydown', (e) => {
  if (state.view !== 'home' || !crate.el?.isConnected || lb.isOpen() || menu.isOpen()) return;
  if (e.target.closest?.('input, textarea')) return;
  if (e.key.startsWith('Arrow')) crate.reveal();
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    crate.goTo(crate.active + 1);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    crate.goTo(crate.active - 1);
  }
});

// ===== Album =====

function renderAlbum(album, data) {
  const slug = album.slug;
  const photos = data.photos;
  const pos = state.albums.indexOf(album);
  const next = state.albums.length > 1 ? state.albums[(pos + 1) % state.albums.length] : null;

  const meta = [album.date, album.place, count(album.count, 'photo')].filter(Boolean).map(esc).join(' · ');
  const desc = album.description
    ? album.description
        .split(/\n\s*\n/)
        .map((p) => `<p class="album-desc">${esc(p).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : '';

  const tiles = photos
    .map(
      (p, i) => `
        <a class="tile ph reveal" href="${hrefPhoto(slug, i)}" data-i="${i}" style="${phStyle(p)}">
          <img alt="${esc(p.t || `${album.title}, photo ${i + 1}`)}" loading="lazy" decoding="async">
        </a>`
    )
    .join('');

  view.innerHTML = `
    <article class="album">
      <header class="album-head">
        <a class="back reveal" href="#/" data-back><span>←</span> All albums</a>
        <h1 class="album-title reveal">${typeset(album.title)}</h1>
        <p class="meta reveal">${meta}</p>
        ${desc ? `<div class="album-about reveal">${desc}</div>` : ''}
      </header>
      <div class="jg">${tiles}</div>
      ${
        next
          ? `<nav class="album-next reveal">
               <p class="meta">Next album</p>
               <a href="${hrefAlbum(next.slug)}">${typeset(next.title)} <span>→</span></a>
             </nav>`
          : ''
      }
    </article>`;

  state.view = 'album';
  state.slug = slug;
  state.album = album;
  state.photos = photos;
  menu.setCurrent(album.title);

  const grid = view.querySelector('.jg');
  layoutGrid(grid);
  gridRO.disconnect();
  gridRO.observe(grid);
}

function renderMissing() {
  view.innerHTML = `
    <section class="album">
      <header class="album-head">
        <a class="back reveal" href="#/" data-back><span>←</span> All albums</a>
        <h1 class="album-title reveal">${typeset('Album not found')}</h1>
      </header>
    </section>`;
  state.view = 'missing';
  state.slug = null;
  menu.setCurrent('');
}

// ===== Mřížka: fotky v řadách stejné výšky, nic se neořezává =====

function rowTarget(W) {
  if (W < 560) return 190;
  if (W < 900) return 270;
  return Math.round(Math.min(480, Math.max(300, innerHeight * 0.44)));
}

// Hledá zlom řad tak, aby výška každé řady byla co nejblíž cílové.
function justify(ratios, W, H, gap) {
  const n = ratios.length;
  const maxK = W < 560 ? 3 : 7;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);
  const height = new Float64Array(n + 1);
  cost[0] = 0;
  for (let j = 1; j <= n; j++) {
    let sum = 0;
    for (let i = j - 1; i >= 0 && j - i <= maxK; i--) {
      sum += ratios[i];
      let h = (W - gap * (j - i - 1)) / sum;
      let c;
      if (j === n && h > H * 1.25) {
        h = H; // poslední řada zůstane kratší, neroztahujeme ji
        c = 0.05;
      } else {
        const d = h / H - 1;
        c = d * d * (d < 0 ? 1.6 : 1) + (h > H * 1.9 ? 50 : 0);
      }
      if (cost[i] + c < cost[j]) {
        cost[j] = cost[i] + c;
        from[j] = i;
        height[j] = h;
      }
    }
  }
  const rows = [];
  for (let j = n; j > 0; j = from[j]) rows.unshift({ start: from[j], end: j, h: height[j] });
  return rows;
}

function layoutGrid(grid, force = false) {
  if (!grid || !grid.isConnected) return;
  const W = grid.clientWidth;
  if (!W || (!force && W === grid._w)) return;
  grid._w = W;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
  const tiles = [...grid.children];
  const ratios = tiles.map((t) => {
    const p = state.photos[+t.dataset.i];
    return p.w / p.h;
  });
  const rows = justify(ratios, W, rowTarget(W), gap);
  let y = 0;
  for (const r of rows) {
    // Řada, která nevyplní šířku (poslední), se vycentruje.
    let rowW = gap * (r.end - r.start - 1);
    for (let k = r.start; k < r.end; k++) rowW += ratios[k] * r.h;
    let x = Math.max(0, (W - rowW) / 2);
    const top = Math.round(y);
    const hh = Math.round(y + r.h) - top;
    for (let k = r.start; k < r.end; k++) {
      const t = tiles[k];
      const w = ratios[k] * r.h;
      const L = Math.round(x);
      const R = Math.round(x + w);
      t.style.left = `${L}px`;
      t.style.top = `${top}px`;
      t.style.width = `${R - L}px`;
      t.style.height = `${hh}px`;
      const img = t.firstElementChild;
      img.sizes = `${R - L}px`;
      if (!img.srcset) {
        img.srcset = srcsetOf(state.slug, state.photos[+t.dataset.i]);
        wire(img);
      }
      x += w + gap;
    }
    y += r.h + gap;
  }
  grid.style.height = `${Math.max(0, Math.round(y - gap))}px`;
}

const gridRO = new ResizeObserver((entries) => {
  for (const e of entries) layoutGrid(e.target);
});

// ===== Přechody mezi stránkami =====

// direction: 'forward' (nová stránka přijede zprava), 'back' (stará odjede doprava).
// Z otevřeného menu se použije 'menu': menu odjede doleva a odkryje novou stránku.
async function swap(update, { initial = false, direction = 'forward' } = {}) {
  header.classList.remove('hide');
  if (initial) {
    await update();
    return;
  }
  if (canVT) {
    root.dataset.vt = menu.isOpen() ? 'menu' : direction;
    const vt = document.startViewTransition(async () => {
      menu.hide({ instant: true });
      await update();
    });
    // Přerušený přechod (třeba při obnovení stránky) není chyba, stránka se vykreslí i tak.
    vt.ready.catch(() => {});
    vt.updateCallbackDone.catch(() => {});
    try {
      await vt.finished;
    } catch {}
    delete root.dataset.vt;
    return;
  }
  // Prohlížeče bez View Transitions: posun a prolnutí jen obsahu stránky.
  menu.hide();
  const dx = direction === 'back' ? 40 : -40;
  const out = view.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${dx}px)` }], {
    duration: reduceMotion ? 1 : 320,
    easing: 'ease-in',
    fill: 'forwards',
  });
  await out.finished;
  await update();
  out.cancel();
  if (!reduceMotion) {
    view.animate([{ opacity: 0, transform: `translateX(${-dx}px)` }, { opacity: 1, transform: 'none' }], {
      duration: 800,
      easing: EASE_OUT,
    });
  }
}

function siteTitle() {
  const s = state.site;
  return [s.jmeno, s.nadpis || 'Photography'].filter(Boolean).join(' · ');
}

async function showHome({ initial = false } = {}) {
  const fromSlug = state.view === 'album' ? state.slug : null;
  await swap(
    () => {
      renderHome({ intro: initial });
      const i = fromSlug ? state.albums.findIndex((a) => a.slug === fromSlug) : -1;
      if (crate.swipe) {
        crate.setPos(state.homeIndex ?? Math.max(0, i));
        jumpTo(state.homeScroll ?? 0);
      } else if (state.homeScroll != null) jumpTo(state.homeScroll);
      else if (i >= 0) jumpTo(crate.scrollFor(i));
      else jumpTo(0);
      crate.loadY = window.scrollY;
      crate.update();
      observeReveals(view, { instantInView: !initial });
    },
    { initial, direction: 'back' }
  );
  document.title = siteTitle();
}

async function showAlbum(slug, { initial = false, photo = null } = {}) {
  const album = state.albums.find((a) => a.slug === slug);
  let data = null;
  if (album) {
    try {
      data = await loadAlbum(slug);
    } catch (e) {
      console.error(e);
    }
  }
  if (!data) {
    await swap(() => {
      renderMissing();
      observeReveals(view, { instantInView: !initial });
    }, { initial });
    document.title = siteTitle();
    return;
  }

  if (state.view === 'home') {
    state.homeScroll = window.scrollY;
    state.homeIndex = crate.active;
  }
  clearTimeout(crate.snapTimer);
  cancelAnimationFrame(crate.anim);
  await swap(
    () => {
      renderAlbum(album, data);
      jumpTo(0);
      // Při přechodu přijede stránka hotová, další fotky se odkrývají až při scrollování.
      observeReveals(view, { instantInView: !initial });
    },
    { initial, direction: 'forward' }
  );
  document.title = [album.title, state.site.jmeno].filter(Boolean).join(' · ');

  if (photo) lb.open(clampIndex(photo - 1), { pushed: false, animate: false });
}

// ===== Směrování =====

function parseRoute() {
  const parts = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { slug: parts[0] || null, photo: parts[1] ? parseInt(parts[1], 10) || null : null };
}

let routing = Promise.resolve();
function route(opts) {
  routing = routing.then(() => doRoute(opts)).catch((e) => console.error(e));
  return routing;
}

async function doRoute({ initial = false } = {}) {
  const r = parseRoute();
  if (state.view === 'album' && r.slug === state.slug) {
    if (r.photo) {
      const i = clampIndex(r.photo - 1);
      if (lb.isOpen()) lb.show(i);
      else lb.open(i, { pushed: false });
    } else if (lb.isOpen()) {
      lb.close();
    }
    return;
  }
  if (lb.isOpen()) lb.close({ instant: true });
  if (!r.slug) return showHome({ initial });
  return showAlbum(r.slug, { initial, photo: r.photo });
}

function navigate(href, historyState = null) {
  const current = location.hash || '#/';
  if (href === current) {
    if (href === '#/') lenis ? lenis.scrollTo(0, { duration: 1.4 }) : window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  history.pushState(historyState, '', href);
  route();
}

function openFromGrid(i) {
  history.pushState({ lb: 1 }, '', hrefPhoto(state.slug, i));
  lb.open(i, { pushed: true });
}

window.addEventListener('popstate', () => {
  if (ignorePop) {
    ignorePop--;
    return;
  }
  route();
});

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  if (a.classList.contains('tile')) {
    openFromGrid(+a.dataset.i);
    return;
  }
  if ((a.classList.contains('vinyl') || a.closest('.crate-index')) && +a.dataset.i !== crate.active) {
    crate.reveal();
    crate.goTo(+a.dataset.i);
    return;
  }
  const href = a.getAttribute('href');
  if (menu.isOpen() && href === (location.hash || '#/')) {
    menu.hide();
    return;
  }
  const toHome = href === '#/';
  // Zpět na úvod přes historii, ať tlačítko Zpět v prohlížeči dává smysl.
  if (toHome && state.view === 'album' && history.state?.fromHome) {
    history.back();
    return;
  }
  navigate(href, state.view === 'home' && !toHome ? { fromHome: true } : null);
});

const prefetchFrom = (e) => {
  const card = e.target.closest?.('.vinyl');
  if (card) loadAlbum(card.dataset.slug).catch(() => {});
};
view.addEventListener('pointerover', prefetchFrom);
view.addEventListener('focusin', prefetchFrom);
view.addEventListener('touchstart', prefetchFrom, { passive: true });

// ===== Prohlížeč fotek =====

const lb = (() => {
  const el = document.getElementById('lightbox');
  const bg = el.querySelector('.lb-bg');
  const stage = el.querySelector('.lb-stage');
  const track = el.querySelector('.lb-track');
  const ui = el.querySelector('.lb-ui');
  const countEl = el.querySelector('.lb-count');
  const exifEl = el.querySelector('.lb-exif');
  const btnClose = el.querySelector('.lb-close');
  const btnPrev = el.querySelector('.lb-prev');
  const btnNext = el.querySelector('.lb-next');
  // Fotky leží pod sebou jako na svislém pásu, každá zabírá jednu výšku okna.
  // Pás jede plynule za kolečkem, touchpadem i prstem a po dojetí se dorovná na celou fotku.
  // V klidu je vidět jen aktuální fotka, sousední jsou mimo obrazovku.
  const TAU = 110; // jak měkce pás dojíždí (ms)

  let open = false;
  let closing = false;
  let pushed = false;
  let index = 0;
  let pos = 0;
  let target = 0;
  let raf = 0;
  let last = 0;
  let origin = null;
  let drag = null;
  let idleTimer = 0;
  let quiet = false; // při skoku na fotku (otevření, odkaz) se stránka pod pozadím nehýbe
  const slides = new Map();

  const W = () => el.clientWidth;
  const H = () => el.clientHeight;
  const total = () => state.photos.length;
  const clampIdx = (i) => Math.max(0, Math.min(total() - 1, i));

  function fit(p) {
    const w = W();
    const h = H();
    const small = w < 700;
    const px = small ? 0 : Math.max(72, w * 0.05);
    const top = small ? 0 : 60;
    const bottom = small ? 0 : 64;
    const aw = w - px * 2;
    const ah = h - top - bottom;
    const s = Math.min(aw / p.w, ah / p.h, 1);
    const fw = p.w * s;
    const fh = p.h * s;
    return { x: (w - fw) / 2, y: top + (ah - fh) / 2, w: fw, h: fh };
  }

  function originEl(i) {
    return view.querySelector(`.tile[data-i="${i}"]`);
  }

  function loadedThumb(i) {
    const img = originEl(i)?.querySelector('img');
    return img && img.complete && img.naturalWidth ? img : null;
  }

  function makeSlide(i) {
    const p = state.photos[i];
    const fig = document.createElement('figure');
    fig.className = 'lb-slide';
    fig.style.setProperty('--c', p.c);
    const lo = document.createElement('img');
    lo.className = 'lo';
    lo.alt = '';
    const thumb = loadedThumb(i);
    if (thumb) lo.src = thumb.currentSrc;
    else {
      lo.src = p.q;
      lo.classList.add('blur');
    }
    const hi = document.createElement('img');
    hi.className = 'hi';
    hi.alt = p.t || `${state.album.title}, photo ${i + 1} of ${total()}`;
    hi.decoding = 'async';
    hi.addEventListener('load', () => hi.classList.add('ok'), { once: true });
    fig.append(lo, hi);
    fig._i = i;
    fig._hi = hi;
    place(fig);
    return fig;
  }

  function place(fig) {
    const p = state.photos[fig._i];
    const r = fit(p);
    fig._r = r;
    fig.style.left = `${r.x}px`;
    fig.style.top = `${r.y}px`;
    fig.style.width = `${r.w}px`;
    fig.style.height = `${r.h}px`;
    const hi = fig._hi;
    const sizes = `${Math.ceil(r.w)}px`;
    if (hi.getAttribute('sizes') !== sizes) hi.sizes = sizes;
    if (!hi.srcset) {
      hi.srcset = srcsetOf(state.slug, p);
      if (hi.complete && hi.naturalWidth) hi.classList.add('ok', 'now');
    }
  }

  // Na pásu existují jen fotky kolem aktuální pozice, ostatní se uklidí.
  function ensure() {
    const from = clampIdx(Math.floor(pos) - 1);
    const to = clampIdx(Math.ceil(pos) + 1);
    for (const [i, fig] of slides) {
      if (i < from || i > to) {
        fig.remove();
        slides.delete(i);
      }
    }
    for (let i = from; i <= to; i++) {
      if (!slides.has(i)) {
        const fig = makeSlide(i);
        slides.set(i, fig);
        track.append(fig);
      }
    }
  }

  function render() {
    ensure();
    const slot = H();
    for (const [i, fig] of slides) {
      if (fig._flying) continue;
      fig.style.transform = `translateY(${((i - pos) * slot).toFixed(2)}px)`;
    }
    const now = clampIdx(Math.round(pos));
    if (now !== index) {
      index = now;
      updateUI();
      history.replaceState(history.state, '', hrefPhoto(state.slug, index));
      if (!quiet) follow(index);
    }
  }

  const cur = () => slides.get(index);

  function tick(t) {
    const dt = last ? Math.min(64, t - last) : 16;
    last = t;
    if (!drag) {
      pos += (target - pos) * (1 - Math.exp(-dt / TAU));
      if (Math.abs(target - pos) < 0.0006) pos = target;
    }
    render();
    if (open && (pos !== target || drag)) raf = requestAnimationFrame(tick);
    else {
      raf = 0;
      last = 0;
    }
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  // Na další/předchozí fotku (klávesy, tlačítka, klik). Na konci alba pás jen trochu pruží.
  function go(dir) {
    if (!open || closing) return;
    const base = Math.round(target);
    const to = clampIdx(base + dir);
    if (to === base) {
      target = base + dir * 0.06;
      setTimeout(() => {
        target = clampIdx(Math.round(target));
        kick();
      }, 140);
    } else {
      target = to;
    }
    kick();
    poke();
  }

  function jump(i) {
    for (const fig of slides.values()) fig.remove();
    slides.clear();
    pos = target = i;
    index = -1;
    quiet = true;
    render();
    quiet = false;
  }

  // Stránka pod rozmazaným pozadím jede s prohlížením, aktuální fotka je v mřížce uprostřed.
  function follow(i) {
    const tile = originEl(i);
    if (!tile || !open) return;
    const r = tile.getBoundingClientRect();
    const y = Math.max(0, window.scrollY + r.top + r.height / 2 - innerHeight / 2);
    if (lenis) lenis.scrollTo(y, { duration: 1.1, force: true });
    else window.scrollTo({ top: y, behavior: 'smooth' });
  }

  function updateUI() {
    const p = state.photos[index];
    countEl.textContent = `${index + 1} / ${total()}`;
    exifEl.textContent = state.site.zobrazitExif === false ? '' : p.x || '';
    btnPrev.disabled = index === 0;
    btnNext.disabled = index === total() - 1;
  }

  // Výchozí stav fotky tak, aby přesně překryla náhled v mřížce (i když je náhled oříznutý).
  function flipFrom(box, r) {
    const ar = r.w / r.h;
    let w = box.width;
    let h = w / ar;
    if (h < box.height) {
      h = box.height;
      w = h * ar;
    }
    const x = box.left + (box.width - w) / 2;
    const y = box.top + (box.height - h) / 2;
    const k = w / r.w;
    const inset = [box.top - y, x + w - box.right, y + h - box.bottom, box.left - x]
      .map((v) => `${Math.max(0, v / k).toFixed(2)}px`)
      .join(' ');
    return { transform: `translate(${x - r.x}px, ${y - r.y}px) scale(${k})`, clipPath: `inset(${inset})` };
  }

  const canHover = matchMedia('(hover: hover)');

  // S myší se ovládání po chvíli klidu schová, ať nic neruší fotku. Na dotyku ho přepíná klepnutí.
  function poke() {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!canHover.matches) return;
    idleTimer = setTimeout(() => {
      if (open && !closing && !el.querySelector('.lb-btn:hover')) el.classList.add('idle');
    }, 2600);
  }

  function doOpen(i, { pushed: p = false, animate = true } = {}) {
    if (open) return show(i);
    open = true;
    closing = false;
    pushed = p;
    root.classList.add('lb-open');
    lenis?.stop();
    setInert(true);
    el.hidden = false;
    el.classList.remove('idle');
    jump(i);

    const from = originEl(i);
    origin = { i, el: from };
    const fig = cur();
    if (animate && !reduceMotion && from && inViewport(from)) {
      const start = flipFrom(from.getBoundingClientRect(), fig._r);
      from.classList.add('lb-hidden');
      fig
        .animate([start, { transform: 'translateY(0px)', clipPath: 'inset(0px 0px 0px 0px)' }], { duration: 760, easing: EASE_OUT })
        .finished.then(() => open && !closing && from.classList.remove('lb-hidden'), () => {});
      bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 520, easing: EASE_SOFT });
      ui.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 300, easing: EASE_SOFT, fill: 'backwards' });
    } else {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduceMotion ? 1 : 450, easing: EASE_SOFT });
    }
    el.focus({ preventScroll: true });
    poke();
  }

  function show(i) {
    if (i === index && pos === target) return;
    jump(i);
  }

  function close({ instant = false } = {}) {
    if (!open || closing) return;
    closing = true;
    pushed = false;
    drag = null;
    clearTimeout(idleTimer);
    cancelAnimationFrame(raf);
    raf = 0;
    // Rozjetý pás nejdřív srovnáme na aktuální fotku.
    pos = target = index;
    render();
    const i = index;
    const fig = cur();

    for (const t of view.querySelectorAll('.lb-hidden')) t.classList.remove('lb-hidden');

    let tile = null;
    if (!instant && !reduceMotion && fig) {
      tile = origin && origin.i === i && origin.el?.isConnected ? origin.el : originEl(i);
      if (tile) {
        let r = tile.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight) {
          jumpTo(Math.max(0, window.scrollY + r.top - (innerHeight - r.height) / 2));
          r = tile.getBoundingClientRect();
        }
        if (r.width === 0 || r.bottom <= 0 || r.top >= innerHeight) tile = null;
      }
    }

    const finish = () => {
      el.hidden = true;
      for (const a of el.getAnimations({ subtree: true })) a.cancel();
      for (const f of slides.values()) f.remove();
      slides.clear();
      bg.style.opacity = '';
      ui.style.opacity = '';
      root.classList.remove('lb-open');
      lenis?.start();
      setInert(false);
      tile?.classList.remove('lb-hidden');
      open = false;
      closing = false;
      const focusEl = tile || originEl(i);
      focusEl?.focus?.({ preventScroll: true });
    };

    if (instant) return finish();

    if (tile) {
      tile.classList.add('lb-hidden');
      fig._flying = true;
      const end = flipFrom(tile.getBoundingClientRect(), fig._r);
      fig.animate([{ transform: 'translateY(0px)', clipPath: 'inset(0px 0px 0px 0px)' }, end], {
        duration: 680,
        easing: EASE_OUT,
        fill: 'forwards',
      }).finished.then(finish, finish);
      bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 560, easing: EASE_SOFT, fill: 'forwards' });
      ui.animate([{ opacity: getComputedStyle(ui).opacity }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    } else {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduceMotion ? 1 : 380, easing: EASE_SOFT, fill: 'forwards' })
        .finished.then(finish, finish);
    }
  }

  function requestClose() {
    if (!open || closing) return;
    const wasPushed = pushed;
    close();
    if (wasPushed) {
      ignorePop++;
      history.back();
    } else {
      history.replaceState(null, '', hrefAlbum(state.slug));
    }
  }

  // --- Ovládání ---

  btnClose.addEventListener('click', requestClose);
  btnPrev.addEventListener('click', () => go(-1));
  btnNext.addEventListener('click', () => go(1));

  document.addEventListener('keydown', (e) => {
    if (!open || closing) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      requestClose();
    } else if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(k)) {
      e.preventDefault();
      go(1);
    } else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(k)) {
      e.preventDefault();
      go(-1);
    } else if (k === 'Tab') {
      const btns = [btnClose, btnPrev, btnNext].filter((b) => !b.disabled && b.offsetParent);
      if (!btns.length) return;
      e.preventDefault();
      const at = btns.indexOf(document.activeElement);
      btns[(at + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      poke();
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && !drag) poke();
  });

  // Kolečko a touchpad posouvají pás plynule, po zastavení se dorovná na nejbližší fotku.
  let wheelStart = null;
  let wheelTimer = 0;
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!open || closing) return;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const px = e.deltaMode === 1 ? d * 40 : e.deltaMode === 2 ? d * H() : d;
      if (wheelStart == null) wheelStart = Math.round(target);
      target = Math.max(-0.2, Math.min(total() - 1 + 0.2, target + px / H()));
      kick();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        const diff = target - wheelStart;
        target = Math.abs(diff) < 0.06 ? wheelStart : clampIdx(Math.round(target + Math.sign(diff) * 0.38));
        wheelStart = null;
        kick();
      }, 140);
      poke();
    },
    { passive: false }
  );

  // Tažení prstem nebo myší nahoru a dolů posouvá pás, švih do stran přepne fotku.
  stage.addEventListener('pointerdown', (e) => {
    if (!open || closing || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, p0: pos, i0: Math.round(pos), axis: null, dx: 0, dy: 0, type: e.pointerType, hist: [[e.timeStamp, e.clientX, e.clientY]] };
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      drag.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {}
    }
    drag.dx = dx;
    drag.dy = dy;
    drag.hist.push([e.timeStamp, e.clientX, e.clientY]);
    if (drag.hist.length > 6) drag.hist.shift();
    if (drag.axis === 'y') {
      let p = drag.p0 - dy / H();
      if (p < 0) p *= 0.3;
      if (p > total() - 1) p = total() - 1 + (p - total() + 1) * 0.3;
      pos = target = p;
      kick();
    }
  });

  function velocity(hist) {
    const a = hist[0];
    const b = hist[hist.length - 1];
    const dt = Math.max(1, b[0] - a[0]);
    return { vx: (b[1] - a[1]) / dt, vy: (b[2] - a[2]) / dt };
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.axis) {
      if (e.type === 'pointerup') tap(e, d);
      return;
    }
    const v = velocity(d.hist);
    if (d.axis === 'y') {
      let to = d.i0;
      if (d.dy < -H() * 0.12 || v.vy < -0.4) to = d.i0 + 1;
      else if (d.dy > H() * 0.12 || v.vy > 0.4) to = d.i0 - 1;
      target = clampIdx(to);
      kick();
    } else if (Math.abs(d.dx) > 60 || Math.abs(v.vx) > 0.4) {
      go(d.dx < 0 ? 1 : -1);
    }
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  function tap(e, d) {
    if (d.type === 'mouse') {
      const r = cur()?.getBoundingClientRect();
      const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) go(1);
      else requestClose();
    } else {
      el.classList.toggle('idle');
    }
  }

  window.addEventListener('resize', () => {
    if (!open || closing) return;
    for (const fig of slides.values()) place(fig);
    render();
  });

  return {
    open: doOpen,
    show,
    close,
    isOpen: () => open,
  };
})();

// ===== Menu s výběrem alb (přes celou obrazovku, vyjíždí zprava) =====

const menu = (() => {
  const el = document.getElementById('menu');
  const body = el.querySelector('.menu-body');
  const list = el.querySelector('.menu-list');
  const preview = el.querySelector('.menu-preview');
  const edge = el.querySelector('.menu-edge');
  const btn = header.querySelector('.menu-btn');
  const current = btn.querySelector('[data-current]');
  const EASE_PAGE = 'cubic-bezier(0.76, 0, 0.24, 1)';
  let open = false;
  let built = false;
  let anims = [];

  function build() {
    list.innerHTML = state.albums
      .map(
        (a, i) => `
        <li>
          <a class="menu-item" href="${hrefAlbum(a.slug)}" data-slug="${esc(a.slug)}">
            <span class="menu-num">${pad2(i + 1)}</span>
            <span class="menu-title">${typeset(a.title)}</span>
            <span class="meta menu-meta">${esc(a.date || '')}</span>
          </a>
        </li>`
      )
      .join('');
    // Obaly se přidají před kytičku, která v náhledu čeká, dokud myš nenajede na album.
    preview.insertAdjacentHTML('afterbegin', state.albums.map((a) => `<img alt="" data-slug="${esc(a.slug)}" decoding="async">`).join(''));
    built = true;
  }

  // Najetí na album ukáže vpravo jeho obal.
  function setActive(slug) {
    list.classList.toggle('hovering', !!slug);
    for (const it of list.querySelectorAll('.menu-item')) it.classList.toggle('active', it.dataset.slug === slug);
    for (const img of preview.querySelectorAll('img')) {
      const on = img.dataset.slug === slug;
      if (on && !img.src) {
        const a = state.albums.find((x) => x.slug === slug);
        img.src = srcOf(a.slug, a.cover, a.cover.v[Math.min(1, a.cover.v.length - 1)]);
      }
      if (!on) img.classList.remove('on');
      else if (img.complete && img.naturalWidth) img.classList.add('on');
      else
        img.addEventListener(
          'load',
          () => list.querySelector('.menu-item.active')?.dataset.slug === slug && img.classList.add('on'),
          { once: true }
        );
    }
  }

  function stopAnims() {
    for (const a of anims) a.cancel();
    anims = [];
  }

  function show() {
    if (open || lb.isOpen() || !state.albums.length) return;
    if (!built) build();
    for (const it of list.querySelectorAll('.menu-item')) {
      if (state.view === 'album' && it.dataset.slug === state.slug) it.setAttribute('aria-current', 'page');
      else it.removeAttribute('aria-current');
    }
    setActive(null);
    open = true;
    stopAnims();
    el.hidden = false;
    root.classList.add('menu-open');
    header.classList.remove('hide');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Close album menu');
    view.inert = true;
    footer.inert = true;
    lenis?.stop();
    body.scrollTop = 0;
    if (!reduceMotion) {
      anims.push(
        el.animate([{ transform: 'translateX(100%)' }, { transform: 'none' }], { duration: 950, easing: EASE_PAGE }),
        // Stín se objeví postupně, ne hned v prvním snímku.
        edge.animate([{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 1 }], { duration: 950, easing: 'linear' })
      );
      list.querySelectorAll('.menu-item').forEach((it, i) => {
        anims.push(
          it.animate([{ opacity: 0, transform: 'translateX(80px)' }, { opacity: 1, transform: 'none' }], {
            duration: 1100,
            delay: 380 + Math.min(i, 12) * 70,
            easing: EASE_OUT,
            fill: 'backwards',
          })
        );
      });
    }
    list.querySelector('.menu-item')?.focus({ preventScroll: true });
    setTimeout(() => open && el.querySelectorAll('canvas.ascii').forEach(decodeArt), reduceMotion ? 0 : 450);
  }

  function hide({ instant = false } = {}) {
    if (!open) return;
    open = false;
    stopAnims();
    root.classList.remove('menu-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open album menu');
    view.inert = false;
    footer.inert = false;
    lenis?.start();
    const finish = () => {
      stopAnims();
      el.hidden = true;
      setActive(null);
    };
    if (instant || reduceMotion) return finish();
    anims.push(
      el.animate([{ transform: 'none' }, { transform: 'translateX(100%)' }], { duration: 800, easing: EASE_PAGE, fill: 'forwards' }),
      // Na konci zajíždění stín plynule zmizí, ať u okraje obrazovky nezůstane viset.
      edge.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 800, easing: 'linear', fill: 'forwards' })
    );
    const mine = anims;
    Promise.all(mine.map((a) => a.finished))
      .then(() => {
        if (anims === mine) finish();
      })
      .catch(() => {});
  }

  // Vedle tří čárek je název alba, ve kterém návštěvník právě je.
  function setCurrent(title) {
    current.innerHTML = title ? typeset(title) : '';
  }

  btn.addEventListener('click', () => (open ? hide() : show()));

  const activate = (e) => {
    const it = e.target.closest?.('.menu-item');
    if (!it) return;
    setActive(it.dataset.slug);
    loadAlbum(it.dataset.slug).catch(() => {});
  };
  list.addEventListener('pointerover', activate);
  list.addEventListener('focusin', (e) => e.target.matches(':focus-visible') && activate(e));
  list.addEventListener('pointerleave', () => setActive(null));

  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      btn.focus({ preventScroll: true });
    } else if (e.key === 'Tab') {
      const items = [header.querySelector('.brand'), header.querySelector('.theme-btn'), btn, ...list.querySelectorAll('.menu-item')];
      e.preventDefault();
      const at = items.indexOf(document.activeElement);
      items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  });

  return { show, hide, setCurrent, isOpen: () => open };
})();

// ===== Světlý a tmavý režim (výchozí je světlý) =====

const themeBtn = header.querySelector('.theme-btn');
const themeMeta = document.querySelector('meta[name="theme-color"]');

function syncTheme() {
  const dark = root.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  themeMeta?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
}

themeBtn.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  const apply = () => {
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    syncTheme();
    redrawArt();
  };
  if (!canVT || root.dataset.vt) return apply();
  root.dataset.vt = 'theme';
  const vt = document.startViewTransition(apply);
  vt.ready.catch(() => {});
  vt.finished.catch(() => {}).finally(() => delete root.dataset.vt);
});

// ===== Hlavička a patička =====

let lastY = 0;
let ticking = false;
window.addEventListener(
  'scroll',
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (lb.isOpen() || menu.isOpen()) return;
      const y = window.scrollY;
      if (state.view === 'home') {
        header.classList.remove('hide', 'solid');
        lastY = y;
        return;
      }
      header.classList.toggle('solid', y > 40);
      if (y > 220 && y > lastY + 4) header.classList.add('hide');
      else if (y < lastY - 4 || y < 220) header.classList.remove('hide');
      lastY = y;
    });
  },
  { passive: true }
);

function renderChrome() {
  const s = state.site;
  const name = s.jmeno || '';
  const brand = header.querySelector('.brand');
  // Jméno je předem vyrobené logo (npm run logo), jinak se vypíše písmem.
  if (!brand.querySelector('.brand-logo')) {
    brand.innerHTML =
      typeset(name || 'Photography', brandInfo) + (s.symbol ? `<span class="rat" aria-hidden="true">${esc(s.symbol)}</span>` : '');
  }
  brand.setAttribute('aria-label', name || 'Photography');
  footer.querySelector('[data-copy]').textContent = `© ${new Date().getFullYear()} ${name}`.trim();
  const links = [];
  if (s.instagram) {
    const ig = /^https?:/.test(s.instagram) ? s.instagram : `https://www.instagram.com/${s.instagram.replace(/^@/, '')}/`;
    links.push(`<a href="${esc(ig)}" target="_blank" rel="noopener">Instagram</a>`);
  }
  if (s.email) links.push(`<a href="mailto:${esc(s.email)}">Email</a>`);
  footer.querySelector('[data-links]').innerHTML = links.join('');
}

// Písmo jména a názvů alb (site.json → pismo). Vlastní písma leží v assets/fonts/.
// scale vyrovnává, že některá písma jsou při stejné velikosti opticky menší nebo větší,
// ovrY posouvá uvozovky skládaného „ä“ nad písmeno.
const FONTS = {
  'rat-typewriter': { styl: 'stroj', family: 'Rat Typewriter', file: 'assets/fonts/rat-typewriter.ttf', overstrike: true, ovrY: '-0.14em', scale: 1 },
  'x-typewriter': { styl: 'stroj', family: 'X Typewriter', file: 'assets/fonts/XTypewriter-Regular.ttf', overstrike: true, scale: 1 },
  'orange-typewriter': { styl: 'stroj', family: 'Orange Typewriter', file: 'assets/fonts/nezverejnovat/orange-typewriter.ttf', scale: 1 },
  // text: písmo se použije na celý web, nejen na nadpisy.
  'tox-typewriter': { styl: 'stroj', family: 'Tox Typewriter', file: 'assets/fonts/tox-typewriter.ttf', text: true, scale: 1 },
  // Uncle Typewriter má z velkých písmen navržená jen D, E a M, proto nadpisy píšeme malými.
  'uncle-typewriter': { styl: 'stroj', family: 'Uncle Typewriter', file: 'assets/fonts/nezverejnovat/uncle-typewriter.ttf', overstrike: true, ovrY: '-0.3em', lowercase: true, scale: 1 },
  'psaci-stroj': { styl: 'stroj', family: 'Special Elite', scale: 1 },
  podpis: { styl: 'podpis', family: 'Pinyon Script', scale: 1 },
  klasicke: { styl: 'klasicke', family: 'Instrument Serif', scale: 1 },
};

function fontFace(info) {
  if (!info.file) return document.fonts.load(`32px "${info.family}"`, 'Aa');
  const face = new FontFace(info.family, `url("${info.file}")`, { display: 'swap' });
  document.fonts.add(face);
  return face.load().catch(() => console.warn(`Písmo ${info.file} se nepodařilo načíst.`));
}

// pismo: nadpisy a zbytek webu, pismoJmena: jen jméno v hlavičce.
function loadFonts() {
  const key = FONTS[state.site.pismo] ? state.site.pismo : 'rat-typewriter';
  const brandKey = FONTS[state.site.pismoJmena] ? state.site.pismoJmena : key;
  fontInfo = FONTS[key];
  brandInfo = FONTS[brandKey];
  const d = root.dataset;
  d.pismo = key;
  d.styl = fontInfo.styl;
  d.brandPismo = brandKey;
  for (const [attr, on] of [['case', fontInfo.lowercase], ['brandCase', brandInfo.lowercase], ['text', fontInfo.text]]) {
    if (on) d[attr] = attr === 'text' ? 'all' : 'lower';
    else delete d[attr];
  }
  root.style.setProperty('--title-font', `"${fontInfo.family}"`);
  root.style.setProperty('--brand-font', `"${brandInfo.family}", "Courier Prime", ui-monospace, monospace`);
  root.style.setProperty('--ts', fontInfo.scale);
  root.style.setProperty('--ovr-y', fontInfo.ovrY || '0em');
  root.style.setProperty('--brand-ovr-y', brandInfo.ovrY || '0em');
  if (!document.fonts) return Promise.resolve();
  const jobs = [document.fonts.load('16px "Courier Prime"', 'Aa'), fontFace(fontInfo)];
  // Písmo jména se stahuje, jen když jméno není předem vyrobené logo.
  if (brandKey !== key && !header.querySelector('.brand-logo')) jobs.push(fontFace(brandInfo));
  return Promise.all(jobs).catch(() => {});
}

function initSmoothScroll() {
  if (reduceMotion || state.site.plynuleScrollovani === false || typeof window.Lenis !== 'function') return;
  if (matchMedia('(pointer: coarse)').matches) return; // na mobilu necháme přirozený scroll
  lenis = new window.Lenis({ lerp: 0.085, autoRaf: true, anchors: false });
}

// ===== ASCII obrázky: Braillovo písmo kreslené po tečkách =====
// Každý znak Braillova písma je mřížka 2 × 4 teček. Kreslíme je sami, aby obrázek vypadal
// všude stejně (písma v systémech kreslí i prázdné tečky). Při zobrazení se obrázek „načte“
// zleva doprava a na čele vlny chvíli bliká digitální šum.

const DOTS = [
  [0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3],
];
const artCache = {};

function artCells(name) {
  if (!artCache[name]) {
    const lines = ART[name].split('\n');
    const cells = lines.map((l) => [...l].map((c) => c.charCodeAt(0) - 0x2800));
    artCache[name] = { cells, cols: cells[0].length, rows: cells.length };
  }
  return artCache[name];
}

function drawArt(canvas, valueAt) {
  const { cells, cols, rows } = artCells(canvas.dataset.art);
  const w = canvas.clientWidth;
  if (!w) return;
  const pitch = w / (cols * 2);
  const h = pitch * rows * 4;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).color;
  const r = pitch * 0.36;
  ctx.beginPath();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = valueAt ? valueAt(x, y, cells[y][x]) : cells[y][x];
      if (!v) continue;
      for (let k = 0; k < 8; k++) {
        if (!(v & (1 << k))) continue;
        const cx = (x * 2 + DOTS[k][0] + 0.5) * pitch;
        const cy = (y * 4 + DOTS[k][1] + 0.5) * pitch;
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }
    }
  }
  ctx.fill();
}

function decodeArt(canvas) {
  cancelAnimationFrame(canvas._raf);
  canvas._shown = true;
  if (reduceMotion) return drawArt(canvas);
  const { cols, rows } = artCells(canvas.dataset.art);
  // Kdy se která buňka ukáže: vlna zleva doprava s trochou náhody.
  const at = Array.from({ length: rows }, () => Array.from({ length: cols }, (_, x) => (x / cols) * 0.62 + Math.random() * 0.3));
  const start = performance.now();
  const frame = (now) => {
    const p = (now - start) / 1800;
    drawArt(canvas, (x, y, v) => {
      if (!v) return 0;
      const t = at[y][x];
      if (p >= t + 0.07) return v;
      if (p >= t - 0.05) return (Math.random() * 256) & (Math.random() * 256);
      return 0;
    });
    if (p < 1.05) canvas._raf = requestAnimationFrame(frame);
    else {
      canvas._raf = 0;
      drawArt(canvas);
    }
  };
  canvas._raf = requestAnimationFrame(frame);
}

const artIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) decodeArt(e.target);
  },
  { threshold: 0.4 }
);

// Před prvním odkrytím je plátno prázdné, ale už má správnou výšku (stránka neposkočí).
const artRO = new ResizeObserver((entries) => {
  for (const e of entries) if (!e.target._raf) drawArt(e.target, e.target._shown ? null : () => 0);
});

function redrawArt() {
  for (const c of document.querySelectorAll('canvas.ascii')) if (c._shown && !c._raf) drawArt(c);
}

function initArt() {
  for (const c of document.querySelectorAll('canvas.ascii[data-art]')) {
    if (!ART[c.dataset.art]) continue;
    const { cols, rows } = artCells(c.dataset.art);
    c.style.aspectRatio = `${cols * 2} / ${rows * 4}`;
    artRO.observe(c);
    if (!c.closest('.menu')) artIO.observe(c);
  }
}

// ===== Kurzor: bílá tečka a kroužek, který ji s mírným zpožděním dobíhá =====

function initCursor() {
  if (reduceMotion || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const el = document.querySelector('.cursor');
  const ring = el.querySelector('.cursor-ring');
  const dot = el.querySelector('.cursor-dot');
  root.classList.add('has-cursor');
  let x = 0;
  let y = 0;
  let rx = 0;
  let ry = 0;
  let last = 0;
  let raf = 0;
  let shown = false;

  const tick = (t) => {
    const dt = last ? Math.min(64, t - last) : 16;
    last = t;
    const k = 1 - Math.pow(1 - 0.16, dt / 16.7); // stejné zpoždění při 60 i 120 Hz
    rx += (x - rx) * k;
    ry += (y - ry) * k;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    if (Math.abs(x - rx) + Math.abs(y - ry) > 0.1) raf = requestAnimationFrame(tick);
    else raf = last = 0;
  };

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      x = e.clientX;
      y = e.clientY;
      dot.style.transform = `translate(${x}px, ${y}px)`;
      if (!shown) {
        shown = true;
        rx = x;
        ry = y;
        el.classList.add('on');
      }
      if (!raf) raf = requestAnimationFrame(tick);
    },
    { passive: true }
  );

  // Nad fotkou se kroužek zvětší, nad odkazem trochu méně.
  document.addEventListener('pointerover', (e) => {
    const t = e.target;
    el.classList.toggle('is-photo', !!t.closest?.('.tile, .vinyl-face'));
    el.classList.toggle('is-link', !!t.closest?.('a, button'));
  });
  document.addEventListener('pointerdown', () => el.classList.add('is-down'));
  document.addEventListener('pointerup', () => el.classList.remove('is-down'));
  root.addEventListener('mouseleave', () => {
    el.classList.remove('on');
    shown = false;
  });
}

// ===== Start =====

async function boot() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  try {
    const idx = await loadIndex();
    state.site = idx.site || {};
    state.albums = idx.albums || [];
  } catch (e) {
    view.innerHTML = '<p class="empty">The albums could not be loaded.</p>';
    console.error('Nepodařilo se načíst data/index.json. Běží web přes „npm run nahled“?', e);
    return;
  }
  await Promise.race([loadFonts(), new Promise((r) => setTimeout(r, 1500))]);
  renderChrome();
  initArt();
  syncTheme();
  initSmoothScroll();
  initCursor();
  route({ initial: true });
}

boot();
