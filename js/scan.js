// Scan enhancement: 4-corner perspective crop, auto edge detection, document filters.
import { addCanvasSource } from './pdfio.js';

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
function normalizeIllumination(id, k = 1) {
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
    for (let c = 0; c < 3; c++) { const v = d[i + c], n = Math.min(255, v * 255 / Math.max(70, bd[i + c])); d[i + c] = v + (n - v) * k; }
  }
}
function levels(d, lo, hi) { const k = 255 / (hi - lo); for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c] - lo) * k)); }

export const FILTERS = [['auto', 'Magic colour'], ['photo', 'Vivid photo'], ['orig', 'Original'], ['gray', 'Grayscale'], ['gray2', 'Clean grey'], ['bw', 'Black & white']];
export const SHADOW_DEF = { auto: 100, gray2: 100, bw: 100, photo: 45, gray: 0, orig: 0 };
export const shadowOf = p => p.shadow ?? SHADOW_DEF[p.filter || 'auto'] ?? 0;
export const defParams = (filter = 'auto') => ({ rot: 0, quad: null, filter, bright: 0, contrast: 0, thr: 0, shadow: undefined, sharp: 0 });

function sharpen(id, amount) {
  const { width: W, height: H, data: d } = id, a = amount / 100 * 0.9;
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      const v = src[o + c] * (1 + 4 * a) - a * (src[o + c - 4] + src[o + c + 4] + src[o + c - W * 4] + src[o + c + W * 4]);
      d[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

export function applyFilter(id, p = {}) {
  const { filter = 'auto', bright = 0, contrast = 0, thr = 0, sharp = 0 } = p;
  const d = id.data;
  const sh = shadowOf(p) / 100;
  if (sh > 0) normalizeIllumination(id, sh);
  if (filter === 'auto') levels(d, 25, 245);
  if (filter === 'photo') levels(d, 10, 250);
  if (filter === 'gray' || filter === 'bw' || filter === 'gray2') {
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }
  if (filter === 'gray2') levels(d, 30, 235);
  if (sharp > 0 && filter !== 'bw') sharpen(id, sharp);
  if (bright || contrast) {
    const k = 1 + contrast / 100, add = bright * 1.28;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c] - 128) * k + 128 + add));
  }
  if (filter === 'bw') {
    const t = 168 + thr;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] > t ? 255 : 0;
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


/** Process the original photo with P and store the result as a new image source. Returns {sid, w, h}. */
export async function buildScanSource(orig, P, quality) {
  const out = processScan(orig.img, P, 2400);
  const ns = await addCanvasSource(orig.name.replace(/\.[^.]+$/, '') + '-scan.jpg', out, quality ?? (P.filter === 'bw' ? 0.8 : 0.9));
  return { sid: ns[0].src.sid, w: out.width, h: out.height };
}
