// Scan enhancement: 4-corner perspective crop, auto edge detection, document filters.
import { S, edit, pushHist, emit } from './state.js';
import { fitA4, addCanvasSource } from './pdfio.js';
import { h, modal, toast, debounce } from './ui.js';

const mk = (w, hh) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c; };

/** Image drawn (and rotated by rot*90° clockwise) onto a working canvas ≤ maxDim px. */
export function workCanvas(img, rot = 0, maxDim = 3000) {
  const nw = img.naturalWidth, nh = img.naturalHeight, s = Math.min(1, maxDim / Math.max(nw, nh));
  const w = Math.round(nw * s), hh = Math.round(nh * s), swap = rot % 2 === 1;
  const c = mk(swap ? hh : w, swap ? w : hh), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  if (rot === 1) g.translate(c.width, 0); else if (rot === 2) g.translate(c.width, c.height); else if (rot === 3) g.translate(0, c.height);
  g.rotate(rot * Math.PI / 2);
  g.drawImage(img, 0, 0, w, hh);
  return c;
}

// ---- homography (dest rect → source quad) -------------------------------------------
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i], [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  const n = 8;
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}

function warp(srcC, q, W, H) {
  const sw = srcC.width, sh = srcC.height;
  const sd = srcC.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const m = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
  const out = new ImageData(W, H), od = out.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = m[6] * x + m[7] * y + 1;
      let sx = (m[0] * x + m[1] * y + m[2]) / den, sy = (m[3] * x + m[4] * y + m[5]) / den;
      sx = Math.min(sw - 1.001, Math.max(0, sx)); sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        od[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

// ---- filters ----------------------------------------------------------------------------
function normalizeIllumination(id) {
  // estimate paper colour by block-max pooling, smooth by upscaling, then divide it out
  const { width: W, height: H, data: d } = id;
  const B = Math.max(12, Math.round(Math.max(W, H) / 48));
  const gw = Math.ceil(W / B), gh = Math.ceil(H / B);
  const bg = new Uint8ClampedArray(gw * gh * 4);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    let mr = 0, mg = 0, mb = 0;
    for (let y = by * B; y < Math.min(H, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x += 2) {
      const i = (y * W + x) * 4; if (d[i] > mr) mr = d[i]; if (d[i + 1] > mg) mg = d[i + 1]; if (d[i + 2] > mb) mb = d[i + 2];
    }
    const o = (by * gw + bx) * 4; bg[o] = mr; bg[o + 1] = mg; bg[o + 2] = mb; bg[o + 3] = 255;
  }
  const small = mk(gw, gh); small.getContext('2d').putImageData(new ImageData(bg, gw, gh), 0, 0);
  const big = mk(W, H), bgc = big.getContext('2d', { willReadFrequently: true });
  bgc.imageSmoothingEnabled = true; bgc.imageSmoothingQuality = 'high';
  bgc.drawImage(small, 0, 0, W, H);
  const bd = bgc.getImageData(0, 0, W, H).data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] * 255 / Math.max(70, bd[i + c]));
  }
}
function levels(d, lo, hi) { const k = 255 / (hi - lo); for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c] - lo) * k)); }

export function applyFilter(id, { filter = 'auto', bright = 0, contrast = 0, thr = 0 } = {}) {
  const d = id.data;
  if (filter === 'auto' || filter === 'bw' || filter === 'gray2') { normalizeIllumination(id); }
  if (filter === 'auto') levels(d, 25, 245);
  if (filter === 'gray' || filter === 'bw' || filter === 'gray2') {
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }
  if (filter === 'gray2') levels(d, 30, 235);
  if (filter === 'bw') {
    const t = 168 + thr;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] > t ? 255 : 0;
  }
  if (bright || contrast) {
    const k = 1 + contrast / 100, add = bright * 1.28;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c] - 128) * k + 128 + add));
  }
  return id;
}

/** Full pipeline. quad is 4 normalised points TL,TR,BR,BL on the *rotated* image. */
export function processScan(img, p, outMax = 2400) {
  const wc = workCanvas(img, p.rot || 0, 3200);
  const q = (p.quad || [[0, 0], [1, 0], [1, 1], [0, 1]]).map(([x, y]) => [x * wc.width, y * wc.height]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, outMax / Math.max(W, H));
  W = Math.max(16, Math.round(W * s)); H = Math.max(16, Math.round(H * s));
  const id = applyFilter(warp(wc, q, W, H), p);
  const out = mk(W, H); out.getContext('2d').putImageData(id, 0, 0);
  return out;
}

// ---- automatic document detection --------------------------------------------------------
export function detectQuad(img, rot = 0) {
  const wc = workCanvas(img, rot, 360);
  const W = wc.width, H = wc.height;
  const d = wc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const g = new Uint8Array(W * H), hist = new Array(256).fill(0);
  for (let i = 0; i < W * H; i++) { g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000; hist[g[i]]++; }
  // Otsu
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128; const tot = W * H;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } }
  // paper is usually brighter than the surface; if the bright side is the minority-of-border, keep it, else invert
  let brightBorder = 0, nb = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { nb++; if (g[y * W + x] > thr) brightBorder++; }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { nb++; if (g[y * W + x] > thr) brightBorder++; }
  const invert = brightBorder / nb > 0.5;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = (g[i] > thr) !== invert ? 1 : 0;
  // largest connected component
  const lab = new Int32Array(W * H); let bestL = 0, bestN = 0, L = 0; const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i]) continue;
    L++; let n = 0; stack.push(i); lab[i] = L;
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = L; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = L; stack.push(p + 1); }
      if (y > 0 && mask[p - W] && !lab[p - W]) { lab[p - W] = L; stack.push(p - W); }
      if (y < H - 1 && mask[p + W] && !lab[p + W]) { lab[p + W] = L; stack.push(p + W); }
    }
    if (n > bestN) { bestN = n; bestL = L; }
  }
  if (bestN < W * H * 0.12) return null;
  let tl = null, tr = null, br = null, bl = null, a = Infinity, b = -Infinity, c = -Infinity, e = Infinity;
  for (let i = 0; i < W * H; i++) {
    if (lab[i] !== bestL) continue;
    const x = i % W, y = (i / W) | 0, s = x + y, df = x - y;
    if (s < a) { a = s; tl = [x, y]; } if (df > b) { b = df; tr = [x, y]; } if (s > c) { c = s; br = [x, y]; } if (df < e) { e = df; bl = [x, y]; }
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [x / W, y / H]);
  // pull corners 0.6% inwards to avoid dark edge pixels
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return q.map(([x, y]) => [x + (cx - x) * 0.012, y + (cy - y) * 0.012]);
}

// ---- editor dialog ------------------------------------------------------------------------
const FILTERS = [['auto', 'Magic colour'], ['orig', 'Original'], ['gray', 'Grayscale'], ['gray2', 'Clean grey'], ['bw', 'Black & white']];

export async function openScanEditor(pageIdx) {
  const pg = S.pages[pageIdx];
  if (!pg?.src) return;
  const cur = S.sources.get(pg.src.sid);
  if (cur.kind !== 'img') { toast('Scan tools work on image pages (photos / scans). Convert this page to an image first.', 'warn'); return; }
  const origSid = pg.scan?.orig ?? pg.src.sid;
  const orig = S.sources.get(origSid);
  const P = pg.scan?.params ? JSON.parse(JSON.stringify(pg.scan.params)) : { rot: 0, quad: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]], filter: 'auto', bright: 0, contrast: 0, thr: 0 };

  const MAXV = 520;
  const srcCv = h('canvas', { class: 'scan-src' }), resCv = h('canvas', { class: 'scan-res' });
  let wc = workCanvas(orig.img, P.rot, 1400);
  let drag = -1;
  const layout = () => {
    wc = workCanvas(orig.img, P.rot, 1400);
    const s = Math.min(MAXV / wc.width, MAXV / wc.height, 1);
    srcCv.width = Math.round(wc.width * s); srcCv.height = Math.round(wc.height * s);
    drawSrc(); updatePreview();
  };
  const drawSrc = () => {
    const g = srcCv.getContext('2d');
    g.clearRect(0, 0, srcCv.width, srcCv.height);
    g.drawImage(wc, 0, 0, srcCv.width, srcCv.height);
    const pts = P.quad.map(([x, y]) => [x * srcCv.width, y * srcCv.height]);
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath(); g.rect(0, 0, srcCv.width, srcCv.height); g.moveTo(...pts[0]); for (let i = 3; i >= 0; i--) g.lineTo(...pts[i]); g.closePath(); g.fill('evenodd');
    g.strokeStyle = '#2dd4bf'; g.lineWidth = 2; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.closePath(); g.stroke();
    pts.forEach(p => { g.fillStyle = '#fff'; g.beginPath(); g.arc(p[0], p[1], 9, 0, 7); g.fill(); g.strokeStyle = '#0f766e'; g.lineWidth = 3; g.stroke(); });
  };
  const updatePreview = debounce(() => {
    const out = processScan(orig.img, P, 700);
    resCv.width = out.width; resCv.height = out.height;
    resCv.getContext('2d').drawImage(out, 0, 0);
  }, 60);
  const ptr = e => { const r = srcCv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  srcCv.addEventListener('pointerdown', e => {
    const [x, y] = ptr(e); let bi = -1, bd = 0.06;
    P.quad.forEach((q, i) => { const dd = Math.hypot(q[0] - x, q[1] - y); if (dd < bd) { bd = dd; bi = i; } });
    drag = bi; if (bi >= 0) srcCv.setPointerCapture(e.pointerId);
  });
  srcCv.addEventListener('pointermove', e => { if (drag < 0) return; const [x, y] = ptr(e); P.quad[drag] = [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]; drawSrc(); updatePreview(); });
  srcCv.addEventListener('pointerup', () => { drag = -1; });

  const auto = () => { const q = detectQuad(orig.img, P.rot); if (q) { P.quad = q; drawSrc(); updatePreview(); } else toast('Could not find the page edges — drag the corners by hand.', 'warn'); };
  const reset = () => { P.quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; drawSrc(); updatePreview(); };

  const slider = (label, key, min, max) => {
    const out = h('span', { class: 'val' }, String(P[key]));
    const inp = h('input', { type: 'range', min, max, value: P[key], oninput: () => { P[key] = +inp.value; out.textContent = inp.value; updatePreview(); } });
    return h('label', { class: 'field row-slider' }, h('span', {}, label), inp, out);
  };
  const filterSel = h('select', { onchange: e => { P.filter = e.target.value; updatePreview(); } }, FILTERS.map(([v, l]) => h('option', { value: v, selected: v === P.filter }, l)));
  const body = h('div', { class: 'scan-modal' },
    h('div', { class: 'scan-views' },
      h('figure', {}, srcCv, h('figcaption', {}, 'Drag the four corners onto the page edges')),
      h('figure', {}, resCv, h('figcaption', {}, 'Result preview'))),
    h('div', { class: 'scan-controls' },
      h('div', { class: 'btn-row' },
        h('button', { onclick: auto }, 'Auto-detect edges'), h('button', { onclick: reset }, 'Whole image'),
        h('button', { onclick: () => { P.rot = (P.rot + 1) % 4; P.quad = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]; layout(); } }, 'Rotate 90°')),
      h('label', { class: 'field' }, h('span', {}, 'Filter'), filterSel),
      slider('Brightness', 'bright', -60, 60), slider('Contrast', 'contrast', -60, 60), slider('B&W threshold', 'thr', -60, 60)));
  setTimeout(() => { layout(); if (!pg.scan?.params) { const q = detectQuad(orig.img, P.rot); if (q) { P.quad = q; drawSrc(); updatePreview(); } } }, 0);
  const r = await modal({ title: 'Crop & enhance scan', body, width: 1040, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply to this page', value: true, primary: true }], cancelValue: false });
  if (!r) return false;
  const out = processScan(orig.img, P, 2400);
  const ns = await addCanvasSource(orig.name.replace(/\.[^.]+$/, '') + '-scan.jpg', out, P.filter === 'bw' ? 0.8 : 0.9);
  edit(() => {
    const f = fitA4(out.width, out.height);
    const page = S.pages[pageIdx];
    page.src = { sid: ns[0].src.sid, idx: 0 }; page.w = f.w; page.h = f.h; page.scan = { orig: origSid, params: P };
  });
  return true;
}

/** Auto-crop (edge detection) + enhance every image page. */
export async function autoScanAll(filter = 'auto', progress) {
  let n = 0;
  pushHist(); // one undo step for the whole batch
  const idxs = S.pages.map((p, i) => i).filter(i => S.pages[i].src && S.sources.get(S.pages[i].src.sid).kind === 'img');
  for (let k = 0; k < idxs.length; k++) {
    const i = idxs[k], pg = S.pages[i];
    progress?.(`Enhancing ${k + 1}/${idxs.length}`, k / idxs.length);
    const origSid = pg.scan?.orig ?? pg.src.sid, orig = S.sources.get(origSid);
    const quad = detectQuad(orig.img, 0) || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const P = { rot: 0, quad, filter, bright: 0, contrast: 0, thr: 0 };
    const out = processScan(orig.img, P, 2400);
    const ns = await addCanvasSource(orig.name.replace(/\.[^.]+$/, '') + '-scan.jpg', out, 0.88);
    const f = fitA4(out.width, out.height);
    { const page = S.pages[i]; page.src = { sid: ns[0].src.sid, idx: 0 }; page.w = f.w; page.h = f.h; page.scan = { orig: origSid, params: P }; }
    emit('all');
    n++;
    await new Promise(r => setTimeout(r));
  }
  return n;
}
