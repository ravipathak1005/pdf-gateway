// Opening files (PDF / images), rendering pages, text-run discovery.
import { S, uid, newPage, edit, emit } from './state.js';
import '../vendor/polyfills.mjs';
import { allItems, drawItem } from './prims.js';

let pdfjs = null;
export async function getPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.shim.mjs', import.meta.url).href;
  return pdfjs;
}
const V = p => new URL('../vendor/' + p, import.meta.url).href;

export const A4 = { w: 595.28, h: 841.89 };
export function fitA4(w, h) {
  const box = w > h ? { w: A4.h, h: A4.w } : A4;
  const s = Math.min(box.w / w, box.h / h);
  return { w: +(w * s).toFixed(2), h: +(h * s).toFixed(2) };
}

const sniffPdf = b => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
function hasEncryptKey(bytes) {
  const pat = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = 0, n = bytes.length - pat.length; i < n; i++) {
    if (bytes[i] !== 0x2f) continue;
    for (let j = 1; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

/** Ask-for-password hook, set by the UI. */
export const hooks = { askPassword: async () => null, progress: () => {} };

export async function addPdfSource(name, bytes) {
  const lib = await getPdfjs();
  const encrypted = hasEncryptKey(bytes);
  let usedPw = '';
  const task = lib.getDocument({
    data: bytes.slice(), cMapUrl: V('cmaps/'), cMapPacked: true,
    standardFontDataUrl: V('standard_fonts/'), wasmUrl: V('wasm/'), iccUrl: V('iccs/'),
  });
  task.onPassword = async (update, reason) => {
    const pw = await hooks.askPassword(name, reason === 2);
    if (pw == null) { task.destroy(); return; }
    usedPw = pw; update(pw);
  };
  const pdf = await task.promise;
  const sid = uid();
  const src = { id: sid, name, kind: 'pdf', bytes, pdf, numPages: pdf.numPages, encrypted, password: usedPw, libDoc: undefined };
  S.sources.set(sid, src);
  const pages = [];
  const CH = 24;
  for (let i = 0; i < pdf.numPages; i += CH) {
    const batch = [];
    for (let j = i; j < Math.min(pdf.numPages, i + CH); j++) batch.push(getPdfPage(sid, j));
    const pps = await Promise.all(batch);
    pps.forEach((pp, k) => {
      const vp = pp.getViewport({ scale: 1, rotation: pp.rotate });
      pages.push(newPage({ src: { sid, idx: i + k }, w: +vp.width.toFixed(2), h: +vp.height.toFixed(2) }));
    });
    hooks.progress(`Reading ${name}: ${Math.min(pdf.numPages, i + CH)}/${pdf.numPages}`);
  }
  return pages;
}

export async function addImageSource(name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); throw new Error('Cannot read image ' + name); }
  const sid = uid();
  S.sources.set(sid, { id: sid, name, kind: 'img', bytes, mime, url, img, w: img.naturalWidth, h: img.naturalHeight });
  const f = fitA4(img.naturalWidth, img.naturalHeight);
  return [newPage({ src: { sid, idx: 0 }, w: f.w, h: f.h })];
}

/** Replace the image of a source-backed page (used by the scan editor). */
export async function addCanvasSource(name, canvas, quality = 0.92) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return addImageSource(name, bytes, 'image/jpeg');
}

export async function loadFiles(files) {
  const added = [];
  const errors = [];
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name) || sniffPdf(bytes)) {
        added.push(...await addPdfSource(f.name, bytes));
      } else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name)) {
        added.push(...await addImageSource(f.name, bytes, f.type || 'image/jpeg'));
      } else errors.push(`${f.name}: unsupported file type`);
    } catch (e) {
      console.error(e);
      errors.push(`${f.name}: ${e?.message || e}`);
    }
  }
  if (added.length) {
    edit(() => {
      const at = S.pages.length;
      S.pages.push(...added);
      if (at === 0) S.cur = 0;
      else S.cur = at;
      S.sel = new Set([S.pages[S.cur].id]);
    });
  }
  return { added: added.length, errors };
}

// ---------------------------------------------------------------- page proxies
const ppCache = new Map();
export function getPdfPage(sid, idx) {
  const k = sid + ':' + idx;
  let p = ppCache.get(k);
  if (!p) { p = S.sources.get(sid).pdf.getPage(idx + 1); ppCache.set(k, p); }
  return p;
}

// ---------------------------------------------------------------- geometry
export const dispSize = pg => (pg.rot % 180 ? { w: pg.h, h: pg.w } : { w: pg.w, h: pg.h });
/** natural → display matrix [a,b,c,d,e,f] */
export function nat2disp(pg) {
  const W = pg.w, H = pg.h;
  switch (((pg.rot % 360) + 360) % 360) {
    case 90: return [0, 1, -1, 0, H, 0];
    case 180: return [-1, 0, 0, -1, W, H];
    case 270: return [0, -1, 1, 0, 0, W];
    default: return [1, 0, 0, 1, 0, 0];
  }
}
export function disp2nat(pg, x, y) {
  const W = pg.w, H = pg.h;
  switch (((pg.rot % 360) + 360) % 360) {
    case 90: return [y, H - x];
    case 180: return [W - x, H - y];
    case 270: return [W - y, x];
    default: return [x, y];
  }
}

// ---------------------------------------------------------------- rendering
/**
 * Render the *base* page (no annotations) into a fresh canvas.
 * pxPerPt: canvas pixels per point. Returns {canvas, cancel()} wrapper promise via .done
 */
export function renderBase(pg, pxPerPt) {
  const d = dispSize(pg);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(d.w * pxPerPt));
  canvas.height = Math.max(1, Math.round(d.h * pxPerPt));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let cancel = () => {};
  const done = (async () => {
    if (!pg.src) return canvas;
    const src = S.sources.get(pg.src.sid);
    if (src.kind === 'pdf') {
      const pp = await getPdfPage(pg.src.sid, pg.src.idx);
      const vp = pp.getViewport({ scale: pxPerPt * (canvas.width / (d.w * pxPerPt)), rotation: (pp.rotate + pg.rot) % 360 });
      const rt = pp.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: 3, background: '#ffffff' });
      cancel = () => { try { rt.cancel(); } catch {} };
      try { await rt.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') throw e; }
    } else {
      ctx.save();
      const r = ((pg.rot % 360) + 360) % 360;
      const sx = canvas.width / d.w;
      if (r === 90) ctx.translate(canvas.width, 0); else if (r === 180) ctx.translate(canvas.width, canvas.height); else if (r === 270) ctx.translate(0, canvas.height);
      ctx.rotate(r * Math.PI / 180);
      ctx.scale(sx, sx);
      ctx.drawImage(src.img, 0, 0, pg.w, pg.h);
      ctx.restore();
    }
    return canvas;
  })();
  return { canvas, done, cancel: () => cancel() };
}

/** Base page + annotations + stamps, as a canvas (used for raster export). */
export async function renderComposite(pg, idx, N, pxPerPt, opts = {}) {
  const r = renderBase(pg, pxPerPt);
  const canvas = await r.done;
  const ctx = canvas.getContext('2d');
  const m = nat2disp(pg);
  const sx = canvas.width / dispSize(pg).w, sy = canvas.height / dispSize(pg).h;
  ctx.save();
  ctx.setTransform(sx * m[0], sy * m[1], sx * m[2], sy * m[3], sx * m[4], sy * m[5]);
  for (const it of allItems(pg, idx, N)) drawItem(ctx, it);
  ctx.restore();
  if (opts.gray || opts.bw) {
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      let g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (opts.bw) g = g > (opts.bwThreshold || 160) ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(id, 0, 0);
  }
  return canvas;
}

// ---------------------------------------------------------------- text runs (for "edit text")
const runCache = new Map();
export async function getTextRuns(pg) {
  if (!pg.src || S.sources.get(pg.src.sid).kind !== 'pdf') return [];
  const key = pg.src.sid + ':' + pg.src.idx;
  if (runCache.has(key)) return runCache.get(key);
  const lib = await getPdfjs();
  const pp = await getPdfPage(pg.src.sid, pg.src.idx);
  const vp = pp.getViewport({ scale: 1, rotation: pp.rotate });
  const tc = await pp.getTextContent();
  const raw = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str || !it.str.trim()) continue;
    const t = lib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    if (!size || Math.abs(t[1]) > 0.05 * size || t[0] < 0) continue; // upright text only
    raw.push({ str: it.str, x: t[4], base: t[5], w: it.width, size });
  }
  // merge neighbours on the same baseline into phrases
  raw.sort((a, b) => (Math.abs(a.base - b.base) < 0.3 * a.size ? a.x - b.x : a.base - b.base));
  const runs = [];
  for (const r of raw) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(last.base - r.base) < 0.3 * r.size && r.x - (last.x + last.w) < 0.55 * r.size && r.x - (last.x + last.w) > -0.5 * r.size && Math.abs(last.size - r.size) < 0.25 * r.size) {
      const gap = r.x - (last.x + last.w);
      const sp = gap > 0.12 * r.size && !/\s$/.test(last.str) && !/^\s/.test(r.str) ? ' ' : '';
      last.str += sp + r.str; last.w = r.x + r.w - last.x;
    } else runs.push({ ...r });
  }
  runCache.set(key, runs);
  return runs;
}

/** Median colour of pixels just outside a rect (page canvas coordinates in px). */
export function sampleBg(canvas, x, y, w, h) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pts = [];
  const o = 2;
  const xs = [x - o, x + w / 2, x + w + o], ys = [y - o, y + h / 2, y + h + o];
  for (const px of xs) for (const py of [ys[0], ys[2]]) pts.push([px, py]);
  for (const py of ys) for (const px of [xs[0], xs[2]]) pts.push([px, py]);
  const rs = [], gs = [], bs = [];
  for (const [px, py] of pts) {
    const ix = Math.max(0, Math.min(canvas.width - 1, Math.round(px))), iy = Math.max(0, Math.min(canvas.height - 1, Math.round(py)));
    const d = ctx.getImageData(ix, iy, 1, 1).data; rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
  }
  const med = a => a.sort((p, q) => p - q)[a.length >> 1];
  const h2 = v => v.toString(16).padStart(2, '0');
  return '#' + h2(med(rs)) + h2(med(gs)) + h2(med(bs));
}

/** EXIF orientation of a JPEG (1 if none). */
export function jpegOrientation(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let o = 2;
  while (o + 4 < b.length) {
    if (b[o] !== 0xff) break;
    const mk = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
    if (mk === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78) {
      const t = o + 10, le = b[t] === 0x49;
      const u16 = p => le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1];
      const u32 = p => le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) return u16(e + 8); }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}
