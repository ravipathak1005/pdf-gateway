// Drawing primitives shared by the on-screen overlay and raster export.
// All item coordinates are in the page's "natural frame": points (1/72 in),
// origin top-left, before any extra user rotation.
import { S, assetImg, parseRanges } from './state.js';

// ---------------------------------------------------------------- fonts
const AUTO = '"Utsaah","Mangal","Nirmala UI","Noto Sans Devanagari","Noto Serif Devanagari","Kohinoor Devanagari","Lohit Devanagari","FreeSerif","Arial Unicode MS"';
export const BASE_FONTS = [
  ['auto', 'Auto  (Utsaah → Mangal → Nirmala UI …)'],
  ['Utsaah', 'Utsaah'],
  ['Mangal', 'Mangal'],
  ['Nirmala UI', 'Nirmala UI'],
  ['Noto Sans Devanagari', 'Noto Sans Devanagari'],
  ['Arial', 'Arial'],
  ['Times New Roman', 'Times New Roman'],
  ['Calibri', 'Calibri'],
  ['Courier New', 'Courier New'],
];
export const userFonts = [];            // family names added via "Add font"
export function fontStack(name) {
  if (!name || name === 'auto') return AUTO + ',serif';
  return `"${name}",${AUTO},serif`;
}

// ---------------------------------------------------------------- text bitmaps
// Text is shaped by the browser (correct matras / conjuncts for Devanagari) and
// rasterised at high resolution, then used identically on screen and in the PDF.
const bmCache = new Map();
const K = 4; // bitmap pixels per point

export function textBitmap(it) {
  const key = JSON.stringify([it.text, it.size, it.color, it.font, it.bold, it.italic, it.align, it.bg, it.border, it.bw, it.wrap, it.pad, K]);
  let b = bmCache.get(key);
  if (b) return b;
  const s = Math.max(1, +it.size || 14);
  const fam = fontStack(it.font);
  const fontStr = `${it.italic ? 'italic ' : ''}${it.bold ? '700 ' : '400 '}${s * K}px ${fam}`;
  const m = document.createElement('canvas').getContext('2d');
  m.font = fontStr;
  let lines = String(it.text ?? '').replace(/\r/g, '').split('\n');
  const maxW = it.wrap > 0 ? it.wrap * K : Infinity;
  if (isFinite(maxW)) {
    const out = [];
    for (const ln of lines) {
      if (!ln) { out.push(''); continue; }
      let cur = '';
      for (const w of ln.split(/(\s+)/)) {
        const t = cur + w;
        if (cur && m.measureText(t).width > maxW) { out.push(cur.trimEnd()); cur = w.trimStart(); } else cur = t;
      }
      out.push(cur);
    }
    lines = out;
  }
  const lh = s * K * 1.45;
  const pad = (it.pad ?? (it.border ? s * 0.45 : s * 0.12)) * K;
  const widths = lines.map(l => m.measureText(l).width);
  const innerW = Math.max(s * K * 0.5, ...widths);
  const cw = Math.ceil(innerW + pad * 2), ch = Math.ceil(lines.length * lh + pad * 2);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  if (it.bg) { g.fillStyle = it.bg; g.fillRect(0, 0, cw, ch); }
  g.font = fontStr;
  g.fillStyle = it.color || '#000';
  g.textBaseline = 'alphabetic';
  lines.forEach((ln, i) => {
    let x = pad;
    if (it.align === 'center') x = pad + (innerW - widths[i]) / 2;
    else if (it.align === 'right') x = pad + (innerW - widths[i]);
    g.fillText(ln, x, pad + i * lh + s * K * 1.0);
  });
  if (it.border) {
    const bw = (it.bw || 2) * K;
    g.strokeStyle = it.color || '#000'; g.lineWidth = bw;
    const r = Math.min(cw, ch) * 0.12;
    g.beginPath(); g.roundRect(bw / 2, bw / 2, cw - bw, ch - bw, r); g.stroke();
  }
  b = { canvas: c, w: cw / K, h: ch / K, base: (pad + s * K) / K, lines: lines.length };
  if (bmCache.size > 400) bmCache.delete(bmCache.keys().next().value);
  bmCache.set(key, b);
  return b;
}
export const clearTextCache = () => bmCache.clear();

// ---------------------------------------------------------------- geometry
/** Unrotated frame of an item {x,y,w,h,rot}. */
export function frame(it) {
  switch (it.t) {
    case 'text': { const b = textBitmap(it); return { x: it.x, y: it.y, w: b.w, h: b.h, rot: it.rot || 0 }; }
    case 'line': { const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2); return { x, y, w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1), rot: 0 }; }
    case 'pen': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of it.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot: 0 };
    }
    default: return { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0 };
  }
}
export function move(it, dx, dy) {
  if (it.t === 'line') { it.x1 += dx; it.x2 += dx; it.y1 += dy; it.y2 += dy; }
  else if (it.t === 'pen') it.pts = it.pts.map(([x, y]) => [x + dx, y + dy]);
  else { it.x += dx; it.y += dy; }
}
function rotPt(px, py, cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = px - cx, dy = py - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
export function hit(it, x, y, tol = 4) {
  if (it.t === 'line') return segDist(x, y, it.x1, it.y1, it.x2, it.y2) <= tol + (it.sw || 1) / 2;
  if (it.t === 'pen') {
    for (let i = 1; i < it.pts.length; i++) if (segDist(x, y, it.pts[i - 1][0], it.pts[i - 1][1], it.pts[i][0], it.pts[i][1]) <= tol + (it.sw || 1) / 2) return true;
    return it.pts.length === 1 && Math.hypot(x - it.pts[0][0], y - it.pts[0][1]) <= tol;
  }
  const f = frame(it);
  let px = x, py = y;
  if (f.rot) [px, py] = rotPt(x, y, f.x + f.w / 2, f.y + f.h / 2, -f.rot);
  return px >= f.x - tol && px <= f.x + f.w + tol && py >= f.y - tol && py <= f.y + f.h + tol;
}

// ---------------------------------------------------------------- canvas drawing
function withRot(ctx, f, fn) {
  if (!f.rot) return fn();
  ctx.save();
  ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
  ctx.rotate(f.rot * Math.PI / 180);
  ctx.translate(-(f.x + f.w / 2), -(f.y + f.h / 2));
  fn();
  ctx.restore();
}

/** Draw one item. ctx must already map natural-frame points to canvas pixels. */
export function drawItem(ctx, it) {
  ctx.save();
  ctx.globalAlpha = it.opacity ?? 1;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (it.t) {
    case 'text': {
      const b = textBitmap(it), f = frame(it);
      withRot(ctx, f, () => ctx.drawImage(b.canvas, it.x, it.y, b.w, b.h));
      break;
    }
    case 'img': {
      const img = assetImg(it.aid);
      if (img) withRot(ctx, frame(it), () => ctx.drawImage(img, it.x, it.y, it.w, it.h));
      break;
    }
    case 'rect': case 'ellipse': {
      ctx.beginPath();
      if (it.t === 'rect') ctx.rect(it.x, it.y, it.w, it.h);
      else ctx.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.abs(it.w / 2), Math.abs(it.h / 2), 0, 0, Math.PI * 2);
      if (it.fill) { ctx.fillStyle = it.fill; ctx.fill(); }
      if (it.stroke && it.sw > 0) {
        ctx.strokeStyle = it.stroke; ctx.lineWidth = it.sw;
        if (it.dash) ctx.setLineDash([it.sw * 3, it.sw * 2]);
        ctx.stroke();
      }
      break;
    }
    case 'hl': // highlighter
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = it.fill || '#ffe600'; ctx.fillRect(it.x, it.y, it.w, it.h);
      break;
    case 'white':
      ctx.fillStyle = it.fill || '#ffffff'; ctx.fillRect(it.x, it.y, it.w, it.h);
      break;
    case 'redact':
      ctx.fillStyle = '#000'; ctx.fillRect(it.x, it.y, it.w, it.h);
      break;
    case 'line': {
      ctx.strokeStyle = it.stroke; ctx.lineWidth = it.sw;
      ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke();
      if (it.arrow) {
        const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1), L = Math.max(8, it.sw * 4.5);
        ctx.fillStyle = it.stroke; ctx.beginPath();
        ctx.moveTo(it.x2, it.y2);
        ctx.lineTo(it.x2 - L * Math.cos(a - 0.4), it.y2 - L * Math.sin(a - 0.4));
        ctx.lineTo(it.x2 - L * Math.cos(a + 0.4), it.y2 - L * Math.sin(a + 0.4));
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'pen': {
      if (!it.pts.length) break;
      ctx.strokeStyle = it.stroke; ctx.lineWidth = it.sw;
      ctx.beginPath(); ctx.moveTo(it.pts[0][0], it.pts[0][1]);
      if (it.pts.length === 1) ctx.lineTo(it.pts[0][0] + 0.01, it.pts[0][1]);
      for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i][0], it.pts[i][1]);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- stamps (watermark, numbers, header/footer)
const DEV = '०१२३४५६७८९';
const toDev = s => String(s).replace(/\d/g, d => DEV[d]);
function place(pos, w, h, W, H, m) {
  const [v, hh] = pos.split('-');
  const x = hh === 'left' ? m : hh === 'right' ? W - w - m : (W - w) / 2;
  const y = v === 'top' ? m : v === 'bottom' ? H - h - m : (H - h) / 2;
  return { x, y };
}
const rangeCache = new Map();
function inRange(spec, i, total) {
  const k = spec + '|' + total;
  let r = rangeCache.get(k);
  if (!r) { r = new Set(parseRanges(spec, total)); if (rangeCache.size > 50) rangeCache.clear(); rangeCache.set(k, r); }
  return r.has(i);
}
function tokens(str, n, N, devnum) {
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  let out = String(str).replace(/\{n\}/g, n).replace(/\{N\}/g, N).replace(/\{date\}/g, date);
  return devnum ? toDev(out) : out;
}

/** Items generated from document-level settings for page index i of N. */
export function stampItems(page, i, N) {
  const out = [];
  const st = S.stamps, W = page.w, H = page.h;
  const w = st.watermark;
  if (w.on && inRange(w.range, i, N)) {
    if (w.kind === 'text' && w.text) {
      const it = { t: 'text', gen: 1, text: w.text, size: w.size, color: w.color, font: w.font, bold: true, opacity: w.opacity, pad: 0 };
      const b = textBitmap(it);
      const put = (cx, cy) => out.push({ ...it, x: cx - b.w / 2, y: cy - b.h / 2, rot: w.angle });
      if (w.tile) {
        const gx = Math.max(b.w * 1.3, 120), gy = Math.max(b.h * 3, 140);
        let row = 0;
        for (let y = gy / 2; y < H + gy; y += gy, row++) for (let x = (row % 2 ? gx / 2 : 0); x < W + gx; x += gx) put(x, y);
      } else {
        const q = place(w.pos, b.w, b.h, W, H, w.pos === 'middle-center' ? 0 : 30);
        out.push({ ...it, x: q.x, y: q.y, rot: w.angle });
      }
    } else if (w.kind === 'image' && w.aid) {
      const a = S.assets.get(w.aid);
      if (a && a.w) {
        const iw = W * w.scale / 100, ih = iw * a.h / a.w;
        const it = { t: 'img', gen: 1, aid: w.aid, w: iw, h: ih, opacity: w.opacity, rot: w.angle };
        if (w.tile) {
          const gx = iw * 1.5, gy = ih * 1.8; let row = 0;
          for (let y = gy / 2; y < H + gy; y += gy, row++) for (let x = (row % 2 ? gx / 2 : 0); x < W + gx; x += gx) out.push({ ...it, x: x - iw / 2, y: y - ih / 2 });
        } else { const q = place(w.pos, iw, ih, W, H, 30); out.push({ ...it, x: q.x, y: q.y }); }
      }
    }
  }
  const lab = (cfg, text, n) => {
    if (!cfg.on || !text || !inRange(cfg.range, i, N)) return;
    const it = { t: 'text', gen: 1, text: tokens(text, n, N, cfg.devnum), size: cfg.size, color: cfg.color, font: cfg.font, pad: 0 };
    const b = textBitmap(it), p = place(cfg.pos, b.w, b.h, W, H, cfg.margin);
    out.push({ ...it, x: p.x, y: p.y });
  };
  const nm = st.numbers;
  lab(nm, nm.fmt, i + (+nm.start || 1));
  lab(st.header, st.header.text, i + 1);
  lab(st.footer, st.footer.text, i + 1);
  return out;
}

export const allItems = (page, i, N) => [...page.items, ...stampItems(page, i, N)];
