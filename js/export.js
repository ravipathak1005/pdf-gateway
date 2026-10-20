// Building output PDFs / images / text from the page model.
import { S, fmtBytes } from './state.js';
import { allItems, textBitmap, frame } from './prims.js';
import { renderComposite, getPdfPage, jpegOrientation, dispSize, nat2disp } from './pdfio.js';
import { encryptDoc } from './protect.js';

const L = () => window.PDFLib;
const hexRgb = h => {
  const { rgb } = L();
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '#000000'); const n = parseInt(m ? m[1] : '000000', 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const toBlob = (canvas, type, q) => new Promise(r => canvas.toBlob(r, type, q));
const canvasBytes = async (canvas, type = 'image/png', q) => new Uint8Array(await (await toBlob(canvas, type, q)).arrayBuffer());
function dataUrlBytes(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out, mime: /data:([^;]+)/.exec(head)[1] };
}

/** natural-frame → raw page coords, for a pdf-lib page (honours CropBox + native /Rotate). */
function rawMap(pp) {
  const cb = pp.getCropBox();
  const n = ((pp.getRotation().angle % 360) + 360) % 360;
  const cw = cb.width, ch = cb.height;
  const toRaw = (X, Y) => {
    switch (n) {
      case 90: return [cb.x + Y, cb.y + X];
      case 180: return [cb.x + cw - X, cb.y + Y];
      case 270: return [cb.x + cw - Y, cb.y + ch - X];
      default: return [cb.x + X, cb.y + ch - Y];
    }
  };
  return { n, toRaw, cb };
}

/** Form fills are flattened overlays; drop the widgets they cover so the original appearance doesn't paint over them. */
function stripCoveredWidgets(page, items) {
  const fills = items.filter(i => i.formKey && i.t === 'white');
  if (!fills.length) return;
  const { PDFDict, PDFName, PDFArray, PDFNumber } = L();
  const ctx = page.node.context, annots = page.node.Annots();
  if (!annots) return;
  const map = rawMap(page);
  const pts = fills.map(f => map.toRaw(f.x + f.w / 2, f.y + f.h / 2));
  for (let i = annots.size() - 1; i >= 0; i--) {
    const d = ctx.lookup(annots.get(i));
    if (!(d instanceof PDFDict)) continue;
    const st = d.get(PDFName.of('Subtype')); if (!st || st.toString() !== '/Widget') continue;
    const r = ctx.lookup(d.get(PDFName.of('Rect')));
    if (!(r instanceof PDFArray)) continue;
    const v = [0, 1, 2, 3].map(k => ctx.lookup(r.get(k)).asNumber());
    const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2]), y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3]);
    if (pts.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) annots.remove(i);
  }
}

class Ctx {
  constructor(out) { this.out = out; this.imgCache = new Map(); this.libCache = new Map(); this.bmCache = new WeakMap(); }
}

async function embedBitmap(c, bm) {
  let img = c.bmCache.get(bm);
  if (!img) { img = await c.out.embedPng(await canvasBytes(bm.canvas)); c.bmCache.set(bm, img); }
  return img;
}
async function embedAsset(c, aid) {
  let img = c.imgCache.get('a' + aid);
  if (!img) {
    const a = S.assets.get(aid);
    const { bytes, mime } = dataUrlBytes(a.url);
    img = /jpe?g/.test(mime) ? await c.out.embedJpg(bytes) : await c.out.embedPng(bytes);
    c.imgCache.set('a' + aid, img);
  }
  return img;
}

function drawBoxImage(pp, map, img, f, opacity) {
  const { degrees } = L();
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const rho = (f.rot || 0) * Math.PI / 180;
  // bottom-left corner of the unrotated box, relative to centre, then rotated clockwise by rho (y-down frame)
  const vx = -f.w / 2, vy = f.h / 2;
  const bx = cx + vx * Math.cos(rho) - vy * Math.sin(rho), by = cy + vx * Math.sin(rho) + vy * Math.cos(rho);
  const [rx, ry] = map.toRaw(bx, by);
  pp.drawImage(img, { x: rx, y: ry, width: f.w, height: f.h, rotate: degrees(map.n - (f.rot || 0)), opacity });
}

function polyPath(map, pts, close = true) {
  return pts.map((p, i) => { const [x, y] = map.toRaw(p[0], p[1]); return (i ? 'L' : 'M') + x.toFixed(3) + ' ' + (-y).toFixed(3); }).join(' ') + (close ? ' Z' : '');
}

async function drawItemsPdf(c, pp, items) {
  const { BlendMode, LineCapStyle } = L();
  const map = rawMap(pp);
  for (const it of items) {
    const op = it.opacity ?? 1;
    switch (it.t) {
      case 'text': {
        const bm = textBitmap(it);
        drawBoxImage(pp, map, await embedBitmap(c, bm), frame(it), op);
        break;
      }
      case 'img': {
        if (!S.assets.get(it.aid)) break;
        drawBoxImage(pp, map, await embedAsset(c, it.aid), frame(it), op);
        break;
      }
      case 'rect': case 'hl': case 'white': case 'redact': {
        const corners = [[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]];
        const o = { x: 0, y: 0, opacity: op, borderOpacity: op };
        if (it.t === 'rect') {
          if (it.fill) o.color = hexRgb(it.fill);
          if (it.stroke && it.sw > 0) { o.borderColor = hexRgb(it.stroke); o.borderWidth = it.sw; if (it.dash) o.borderDashArray = [it.sw * 3, it.sw * 2]; }
          if (!o.color && !o.borderColor) break;
        } else if (it.t === 'hl') { o.color = hexRgb(it.fill || '#ffe600'); o.blendMode = BlendMode.Multiply; }
        else if (it.t === 'white') o.color = hexRgb(it.fill || '#ffffff');
        else o.color = hexRgb('#000000');
        pp.drawSvgPath(polyPath(map, corners), o);
        break;
      }
      case 'ellipse': {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2, rx = Math.abs(it.w / 2), ry = Math.abs(it.h / 2), k = 0.5522847498;
        const P = (x, y) => { const [a, b] = map.toRaw(x, y); return a.toFixed(3) + ' ' + (-b).toFixed(3); };
        const d = `M${P(cx + rx, cy)} C${P(cx + rx, cy + k * ry)} ${P(cx + k * rx, cy + ry)} ${P(cx, cy + ry)} C${P(cx - k * rx, cy + ry)} ${P(cx - rx, cy + k * ry)} ${P(cx - rx, cy)} C${P(cx - rx, cy - k * ry)} ${P(cx - k * rx, cy - ry)} ${P(cx, cy - ry)} C${P(cx + k * rx, cy - ry)} ${P(cx + rx, cy - k * ry)} ${P(cx + rx, cy)} Z`;
        const o = { x: 0, y: 0, opacity: op, borderOpacity: op };
        if (it.fill) o.color = hexRgb(it.fill);
        if (it.stroke && it.sw > 0) { o.borderColor = hexRgb(it.stroke); o.borderWidth = it.sw; if (it.dash) o.borderDashArray = [it.sw * 3, it.sw * 2]; }
        if (!o.color && !o.borderColor) break;
        pp.drawSvgPath(d, o);
        break;
      }
      case 'line': {
        const [x1, y1] = map.toRaw(it.x1, it.y1), [x2, y2] = map.toRaw(it.x2, it.y2);
        pp.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: it.sw, color: hexRgb(it.stroke), opacity: op, lineCap: LineCapStyle.Round });
        if (it.arrow) {
          const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1), Ln = Math.max(8, it.sw * 4.5);
          const tri = [[it.x2, it.y2], [it.x2 - Ln * Math.cos(a - 0.4), it.y2 - Ln * Math.sin(a - 0.4)], [it.x2 - Ln * Math.cos(a + 0.4), it.y2 - Ln * Math.sin(a + 0.4)]];
          pp.drawSvgPath(polyPath(map, tri), { x: 0, y: 0, color: hexRgb(it.stroke), opacity: op });
        }
        break;
      }
      case 'pen': {
        if (!it.pts.length) break;
        const pts = it.pts.length === 1 ? [it.pts[0], [it.pts[0][0] + 0.01, it.pts[0][1]]] : it.pts;
        pp.drawSvgPath(polyPath(map, pts, false), { x: 0, y: 0, borderColor: hexRgb(it.stroke), borderWidth: it.sw, borderOpacity: op, borderLineCap: LineCapStyle.Round });
        break;
      }
    }
  }
}

/** Apply the page's crop box (natural frame rect) to a pdf-lib page. */
function applyCrop(pp, crop) {
  if (!crop) return;
  const map = rawMap(pp);
  const a = map.toRaw(crop.x, crop.y), b = map.toRaw(crop.x + crop.w, crop.y + crop.h);
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  pp.setCropBox(x, y, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
}

async function rasterPage(c, pg, k, M, st) {
  const { degrees } = L();
  const dpi = st.dpi || 200;
  const canvas = await renderComposite(pg, k, M, dpi / 72, { gray: st.gray, bw: st.bw, bwThreshold: st.bwThreshold });
  const d = dispSize(pg);
  let page;
  if (st.ocr) { // searchable page produced by the OCR engine: image + invisible text layer
    const { PDFDocument } = L();
    const tmp = await PDFDocument.load(await st.ocr(canvas, k));
    [page] = await c.out.copyPages(tmp, [0]);
    page.scaleContent(d.w / page.getWidth(), d.h / page.getHeight());
    page.setSize(d.w, d.h); page.setMediaBox(0, 0, d.w, d.h); page.setCropBox(0, 0, d.w, d.h);
    c.out.addPage(page);
  } else {
    const img = await c.out.embedJpg(await canvasBytes(canvas, 'image/jpeg', st.quality ?? 0.92));
    page = c.out.addPage([d.w, d.h]);
    page.drawImage(img, { x: 0, y: 0, width: d.w, height: d.h });
  }
  if (pg.crop) { // crop is in natural frame → convert to display frame, then PDF y-up
    const m = nat2disp(pg);
    const tr = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const a = tr(pg.crop.x, pg.crop.y), b = tr(pg.crop.x + pg.crop.w, pg.crop.y + pg.crop.h);
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    page.setCropBox(x0, d.h - y1, x1 - x0, y1 - y0);
  }
  canvas.width = canvas.height = 1; // release memory
  return page;
}

/**
 * Build a PDF from the model.
 * opts: { pages:[indices], raster:{dpi,quality,gray,bw}|null, protect:{user,owner,perms}|null, progress(msg,frac) }
 */
export async function buildPdf(opts = {}) {
  const { PDFDocument, degrees } = L();
  const N = S.pages.length;
  const idxs = opts.pages ?? [...Array(N).keys()];
  const M = idxs.length;
  const out = await PDFDocument.create();
  const c = new Ctx(out);
  const st = opts.raster ? { ...opts.raster, ocr: opts.ocr } : opts.ocr ? { dpi: 200, quality: 0.9, ocr: opts.ocr } : null;
  const prog = opts.progress || (() => {});

  // ---- pre-copy PDF pages per source in one go so shared fonts/images are not duplicated
  const pre = new Map(); // `${sid}:${idx}` -> copied page (first use)
  const wantBySid = new Map();
  if (!st) {
    for (const i of idxs) {
      const pg = S.pages[i];
      if (!pg.src) continue;
      const src = S.sources.get(pg.src.sid);
      if (src.kind !== 'pdf' || src.encrypted) continue;
      if (allItems(pg, 0, M).some(x => x.t === 'redact')) continue;
      if (!wantBySid.has(src.id)) wantBySid.set(src.id, []);
      const arr = wantBySid.get(src.id); if (!arr.includes(pg.src.idx)) arr.push(pg.src.idx);
    }
    for (const [sid, arr] of wantBySid) {
      const src = S.sources.get(sid);
      let lib = null;
      try { lib = await PDFDocument.load(src.bytes, { updateMetadata: false, throwOnInvalidObject: false }); } catch (e) { console.warn('pdf-lib could not load', src.name, e); }
      c.libCache.set(sid, lib);
      if (lib) {
        arr.sort((a, b) => a - b);
        const copied = await out.copyPages(lib, arr);
        arr.forEach((ix, j) => pre.set(sid + ':' + ix, copied[j]));
      }
    }
  }

  for (let k = 0; k < M; k++) {
    const i = idxs[k], pg = S.pages[i];
    prog(`Building page ${k + 1} of ${M}`, k / M);
    const items = allItems(pg, k, M);
    const src = pg.src ? S.sources.get(pg.src.sid) : null;
    const hasRedact = items.some(x => x.t === 'redact');
    let page;

    if (st || hasRedact || (src && src.kind === 'pdf' && (src.encrypted || c.libCache.get(src.id) === null))) {
      page = await rasterPage(c, pg, k, M, st || { dpi: 200, quality: 0.92 });
    } else if (!src) {
      page = out.addPage([pg.w, pg.h]);
      await drawItemsPdf(c, page, items);
      applyCrop(page, pg.crop);
      if (pg.rot) page.setRotation(degrees(pg.rot % 360));
    } else if (src.kind === 'img') {
      let img = c.imgCache.get('s' + src.id);
      if (!img) {
        const isJpg = /jpe?g/i.test(src.mime), isPng = /png/i.test(src.mime);
        if (isJpg && jpegOrientation(src.bytes) === 1) img = await out.embedJpg(src.bytes);
        else if (isPng) img = await out.embedPng(src.bytes);
        else {
          const cv = document.createElement('canvas'); cv.width = src.img.naturalWidth; cv.height = src.img.naturalHeight;
          const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(src.img, 0, 0);
          img = await out.embedJpg(await canvasBytes(cv, 'image/jpeg', 0.92));
        }
        c.imgCache.set('s' + src.id, img);
      }
      page = out.addPage([pg.w, pg.h]);
      page.drawImage(img, { x: 0, y: 0, width: pg.w, height: pg.h });
      await drawItemsPdf(c, page, items);
      applyCrop(page, pg.crop);
      if (pg.rot) page.setRotation(degrees(pg.rot % 360));
    } else {
      const key = src.id + ':' + pg.src.idx;
      let cp = pre.get(key);
      if (cp) pre.delete(key);
      else {
        const lib = c.libCache.get(src.id);
        [cp] = await out.copyPages(lib, [pg.src.idx]);
      }
      page = out.addPage(cp);
      stripCoveredWidgets(page, items);
      await drawItemsPdf(c, page, items);
      applyCrop(page, pg.crop);   // crop is defined in the native-rotation frame, so apply before the extra rotation
      if (pg.rot) page.setRotation(degrees(((page.getRotation().angle + pg.rot) % 360 + 360) % 360));
    }
  }

  // ---- metadata
  const m = S.meta;
  if (m.strip) { out.setProducer(''); out.setCreator(''); out.setTitle(''); out.setAuthor(''); out.setSubject(''); out.setKeywords([]); }
  else {
    out.setProducer('PDF Gateway'); out.setCreator('PDF Gateway');
    if (m.title) out.setTitle(m.title);
    if (m.author) out.setAuthor(m.author);
    if (m.subject) out.setSubject(m.subject);
    if (m.keywords) out.setKeywords(m.keywords.split(/[,;]+/).map(s => s.trim()).filter(Boolean));
    out.setCreationDate(new Date()); out.setModificationDate(new Date());
  }

  let saveOpts = { useObjectStreams: true, updateFieldAppearances: false };
  if (opts.protect && (opts.protect.user || opts.protect.owner || opts.protect.perms)) {
    prog('Encrypting…', 0.97);
    saveOpts = (await encryptDoc(out, opts.protect)).saveOptions;
  }
  prog('Saving…', 0.99);
  return await out.save(saveOpts);
}

/** Re-render pages as JPEG until the file is below targetBytes. */
export async function buildToSize(targetBytes, opts = {}) {
  const idxs = opts.pages ?? [...Array(S.pages.length).keys()];
  const ladder = [[200, 0.82], [170, 0.74], [150, 0.68], [130, 0.6], [110, 0.52], [96, 0.46], [84, 0.4], [72, 0.34], [60, 0.28], [50, 0.24], [40, 0.2]];
  const perPage = targetBytes / Math.max(1, idxs.length);
  let start = perPage > 350e3 ? 0 : perPage > 220e3 ? 1 : perPage > 140e3 ? 2 : perPage > 90e3 ? 3 : perPage > 55e3 ? 4 : perPage > 35e3 ? 5 : perPage > 22e3 ? 6 : perPage > 14e3 ? 7 : perPage > 9e3 ? 8 : 9;
  const tried = [];
  let best = null;
  const run = async j => {
    const [dpi, quality] = ladder[j];
    const bytes = await buildPdf({ ...opts, pages: idxs, raster: { dpi, quality, gray: opts.gray, bw: opts.bw, bwThreshold: opts.bwThreshold }, progress: (m, f) => opts.progress?.(`Target ${fmtBytes(targetBytes)} · try ${tried.length + 1} (${dpi} dpi, q${Math.round(quality * 100)}) — ${m}`, f) });
    tried.push({ dpi, quality, size: bytes.length });
    return bytes;
  };
  let j = start;
  let bytes = await run(j);
  if (bytes.length <= targetBytes) {
    best = bytes;
    // result may be far smaller than needed → try one step up in quality
    if (bytes.length < targetBytes * 0.55 && j > 0) {
      const up = await run(j - 1);
      if (up.length <= targetBytes) best = up;
    }
  } else {
    while (j < ladder.length - 1) {
      j++;
      bytes = await run(j);
      if (bytes.length <= targetBytes) { best = bytes; break; }
    }
  }
  return { bytes: best || bytes, ok: !!best, tried };
}

export async function renderPagesToImages(idxs, { dpi = 150, fmt = 'png', quality = 0.9, progress } = {}) {
  const out = [];
  const M = idxs.length;
  for (let k = 0; k < idxs.length; k++) {
    const i = idxs[k];
    progress?.(`Rendering page ${k + 1}/${M}`, k / M);
    const cv = await renderComposite(S.pages[i], k, M, dpi / 72);
    const bytes = fmt === 'jpg' ? await canvasBytes(cv, 'image/jpeg', quality) : await canvasBytes(cv, 'image/png');
    out.push({ index: i, bytes });
    cv.width = cv.height = 1;
  }
  return out;
}

export async function extractTextOf(idxs) {
  const parts = [];
  for (const i of idxs) {
    const pg = S.pages[i];
    let txt = '';
    if (pg.src && S.sources.get(pg.src.sid).kind === 'pdf') {
      const pp = await getPdfPage(pg.src.sid, pg.src.idx);
      const tc = await pp.getTextContent();
      for (const it of tc.items) { if (!('str' in it)) continue; txt += it.str; txt += it.hasEOL ? '\n' : ''; }
    }
    for (const it of pg.items) if (it.t === 'text' && it.text) txt += (txt.endsWith('\n') || !txt ? '' : '\n') + it.text + '\n';
    parts.push(`----- Page ${idxs.indexOf(i) + 1} -----\n${txt.trim()}\n`);
  }
  return parts.join('\n');
}

export function download(bytes, name, mime = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function zipFiles(files) {
  const z = new window.JSZip();
  for (const f of files) z.file(f.name, f.bytes);
  return z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
