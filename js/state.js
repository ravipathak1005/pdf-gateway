// Central document model for PDF Gateway.
// Pages reference *sources* (opened PDFs / images) and carry their own rotation,
// crop and annotation items. Everything (merge, split, annotate, stamp, export)
// operates on this one model.

export const S = {
  sources: new Map(),   // sid -> source
  assets: new Map(),    // aid -> {url, img, w, h}
  pages: [],            // page objects (see newPage)
  cur: 0,               // current page index
  sel: new Set(),       // selected page ids
  tool: 'select',
  selItem: null,        // item id (on current page)
  nextId: 1,
  stamps: defaultStamps(),
  meta: { title: '', author: '', subject: '', keywords: '', strip: false },
  hist: [],
  fut: [],
  subs: new Set(),
};

export function defaultStamps() {
  return {
    watermark: { on: false, kind: 'text', text: 'CONFIDENTIAL', size: 64, color: '#b00020', opacity: 0.18, angle: -35, pos: 'middle-center', tile: false, aid: null, scale: 50, range: 'all', font: 'auto' },
    numbers: { on: false, fmt: 'Page {n} of {N}', pos: 'bottom-center', size: 10, color: '#333333', start: 1, margin: 22, range: 'all', devnum: false, font: 'auto' },
    header: { on: false, text: '', pos: 'top-center', size: 10, color: '#333333', margin: 22, range: 'all', font: 'auto' },
    footer: { on: false, text: '', pos: 'bottom-left', size: 10, color: '#333333', margin: 22, range: 'all', font: 'auto' },
  };
}

export const uid = () => S.nextId++;

export function subscribe(fn) { S.subs.add(fn); return () => S.subs.delete(fn); }
export function emit(what = 'all') { for (const fn of S.subs) { try { fn(what); } catch (e) { console.error(e); } } }

export function newPage(over) {
  return Object.assign({ id: uid(), src: null, w: 595, h: 842, rot: 0, crop: null, items: [], scan: null }, over);
}

export const curPage = () => S.pages[S.cur] || null;

// ---- history (snapshots of everything except heavy binary sources) ----
function snap() {
  return JSON.stringify({ pages: S.pages, stamps: S.stamps, meta: S.meta, cur: S.cur });
}
function restore(str) {
  const o = JSON.parse(str);
  S.pages = o.pages; S.stamps = o.stamps; S.meta = o.meta;
  S.cur = Math.min(o.cur, Math.max(0, S.pages.length - 1));
  const ids = new Set(S.pages.map(p => p.id));
  S.sel = new Set([...S.sel].filter(i => ids.has(i)));
  if (!S.sel.size && S.pages[S.cur]) S.sel.add(S.pages[S.cur].id);
  S.selItem = null;
}
export function pushHist() {
  S.hist.push(snap());
  if (S.hist.length > 100) S.hist.shift();
  S.fut.length = 0;
}
/** Run a mutation with undo support. */
export function edit(fn, what = 'all') {
  pushHist();
  const r = fn();
  emit(what);
  return r;
}
export function undo() {
  if (!S.hist.length) return;
  S.fut.push(snap()); restore(S.hist.pop()); emit('all');
}
export function redo() {
  if (!S.fut.length) return;
  S.hist.push(snap()); restore(S.fut.pop()); emit('all');
}

export function clearAll() {
  for (const s of S.sources.values()) { try { s.pdf?.destroy?.(); } catch {} if (s.url) URL.revokeObjectURL(s.url); }
  S.sources.clear(); S.assets.clear(); S.pages = []; S.cur = 0; S.sel.clear(); S.selItem = null;
  S.hist.length = 0; S.fut.length = 0; S.stamps = defaultStamps();
  S.meta = { title: '', author: '', subject: '', keywords: '', strip: false };
  emit('all');
}

// ---- assets (images used by items; kept out of history snapshots) ----
export function addAsset(url, w, h) {
  const aid = uid();
  const img = new Image();
  const a = { url, img, w, h, ready: false };
  img.onload = () => { a.ready = true; if (!a.w) { a.w = img.naturalWidth; a.h = img.naturalHeight; } emit('items'); };
  img.src = url;
  S.assets.set(aid, a);
  return aid;
}
export const assetImg = aid => { const a = S.assets.get(aid); return a && a.ready ? a.img : null; };

// ---- helpers ----
export function parseRanges(spec, total) {
  spec = String(spec ?? '').trim().toLowerCase();
  if (!spec || spec === 'all') return [...Array(total).keys()];
  if (spec === 'odd') return [...Array(total).keys()].filter(i => i % 2 === 0);
  if (spec === 'even') return [...Array(total).keys()].filter(i => i % 2 === 1);
  const out = new Set();
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : total;
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = +part; if (n >= 1 && n <= total) out.add(n - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
