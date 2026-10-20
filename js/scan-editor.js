// Full-screen crop & colour editor for scanned photos: big touch handles (corners + edges), magnifier loupe,
// auto-detect, rotate, filter presets with previews, brightness / contrast / shadow removal / sharpen / B&W level.
import { workCanvas, processScan, detectQuad, FILTERS, shadowOf } from './scan.js';
import { h, debounce, toast } from './ui.js';

const FULL = () => [[0, 0], [1, 0], [1, 1], [0, 1]];
const INSET = () => [[0.03, 0.03], [0.97, 0.03], [0.97, 0.97], [0.03, 0.97]];

/**
 * orig: image source ({img,name}); params: scan params (cloned); opts.allowAll → show "apply colour to every page".
 * Resolves to {params, all} or null if cancelled.
 */
export function openCropEditor(orig, params, opts = {}) {
  return new Promise(resolve => {
    const P = JSON.parse(JSON.stringify(params));
    if (!P.quad) P.quad = detectQuad(orig.img, P.rot || 0) || INSET();
    let mode = opts.startColour ? 'colour' : 'crop';
    let wc = workCanvas(orig.img, P.rot, 1800);
    let result = null, drag = null, L = { x: 0, y: 0, w: 1, h: 1 };
    let applyAll = false;

    const cv = h('canvas', { class: 'sce-cv' }), loupe = h('canvas', { class: 'sce-loupe', width: 132, height: 132, hidden: true });
    const stage = h('div', { class: 'sce-stage' }, cv, loupe);
    const g = cv.getContext('2d');

    // ---------------------------------------------------------------- drawing
    const fit = (w, hh, W, H, m = 22) => { const s = Math.min((W - 2 * m) / w, (H - 2 * m) / hh); const ww = w * s, hh2 = hh * s; return { x: (W - ww) / 2, y: (H - hh2) / 2, w: ww, h: hh2 }; };
    const size = () => {
      const r = stage.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(10, Math.round(r.width * dpr)); cv.height = Math.max(10, Math.round(r.height * dpr));
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { W: r.width, H: r.height };
    };
    const pts = () => {
      const q = P.quad.map(([x, y]) => [L.x + x * L.w, L.y + y * L.h]);
      const mids = [0, 1, 2, 3].map(i => [(q[i][0] + q[(i + 1) % 4][0]) / 2, (q[i][1] + q[(i + 1) % 4][1]) / 2]);
      return [...q, ...mids];
    };
    const draw = () => {
      const { W, H } = size();
      g.clearRect(0, 0, W, H);
      if (mode === 'crop') {
        L = fit(wc.width, wc.height, W, H);
        g.drawImage(wc, L.x, L.y, L.w, L.h);
        const p = pts();
        g.fillStyle = 'rgba(8,12,20,.62)';
        g.beginPath(); g.rect(L.x, L.y, L.w, L.h); g.moveTo(...p[0]); for (let i = 3; i >= 0; i--) g.lineTo(...p[i]); g.closePath(); g.fill('evenodd');
        g.strokeStyle = '#2dd4bf'; g.lineWidth = 2; g.beginPath(); p.slice(0, 4).forEach((pt, i) => i ? g.lineTo(...pt) : g.moveTo(...pt)); g.closePath(); g.stroke();
        // thirds grid inside the quad
        g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1;
        for (const t of [1 / 3, 2 / 3]) {
          const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
          g.beginPath(); g.moveTo(...lerp(p[0], p[1], t)); g.lineTo(...lerp(p[3], p[2], t)); g.moveTo(...lerp(p[0], p[3], t)); g.lineTo(...lerp(p[1], p[2], t)); g.stroke();
        }
        p.forEach((pt, i) => {
          const corner = i < 4, r = corner ? 13 : 9;
          g.fillStyle = drag?.i === i ? '#0f766e' : '#fff'; g.strokeStyle = corner ? '#0f766e' : '#2dd4bf'; g.lineWidth = 3;
          g.beginPath(); g.arc(pt[0], pt[1], r, 0, 7); g.fill(); g.stroke();
        });
      } else {
        if (!result) return;
        L = fit(result.width, result.height, W, H, 14);
        g.fillStyle = '#fff'; g.fillRect(L.x, L.y, L.w, L.h);
        g.drawImage(result, L.x, L.y, L.w, L.h);
      }
    };
    const rebuild = debounce(() => { if (mode === 'colour') { result = processScan(orig.img, P, 1300); draw(); } }, 70);
    const refreshAll = () => { thumbsDirty = true; if (mode === 'colour') { result = processScan(orig.img, P, 1300); } draw(); if (mode === 'colour') fillChips(); };

    // ---------------------------------------------------------------- pointer handling
    const loc = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => {
      if (mode !== 'crop') return;
      const [x, y] = loc(e), p = pts(); let bi = -1, bd = e.pointerType === 'mouse' ? 24 : 38;
      p.forEach((pt, i) => { const d = Math.hypot(pt[0] - x, pt[1] - y) - (i < 4 ? 6 : 0); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0) return;
      cv.setPointerCapture(e.pointerId);
      drag = { i: bi, start: P.quad.map(q => [...q]), x0: x, y0: y };
      e.preventDefault(); move(e);
    });
    const clamp01 = v => Math.max(0, Math.min(1, v));
    function move(e) {
      if (!drag) return;
      const [x, y] = loc(e);
      const nx = (x - drag.x0) / L.w, ny = (y - drag.y0) / L.h, s = drag.start;
      if (drag.i < 4) P.quad[drag.i] = [clamp01(s[drag.i][0] + nx), clamp01(s[drag.i][1] + ny)];
      else { const a = drag.i - 4, b = (a + 1) % 4; for (const k of [a, b]) P.quad[k] = [clamp01(s[k][0] + nx), clamp01(s[k][1] + ny)]; }
      thumbsDirty = true; draw(); showLoupe(e);
    }
    cv.addEventListener('pointermove', move);
    const end = () => { drag = null; loupe.hidden = true; draw(); };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    function showLoupe(e) {
      const p = pts()[drag.i], sx = (drag.i < 4 ? P.quad[drag.i] : P.quad[drag.i - 4].map((v, k) => (v + P.quad[(drag.i - 3) % 4][k]) / 2));
      loupe.hidden = false;
      const r = stage.getBoundingClientRect(), [px, py] = [p[0], p[1]];
      let lx = px - 66, ly = py - 170; if (ly < 4) ly = py + 50;
      loupe.style.left = Math.max(4, Math.min(r.width - 136, lx)) + 'px'; loupe.style.top = Math.max(4, Math.min(r.height - 136, ly)) + 'px';
      const lg = loupe.getContext('2d'), span = 70; // source pixels shown
      const cx = sx[0] * wc.width, cy = sx[1] * wc.height;
      lg.fillStyle = '#000'; lg.fillRect(0, 0, 132, 132);
      lg.drawImage(wc, cx - span / 2, cy - span / 2, span, span, 0, 0, 132, 132);
      lg.strokeStyle = '#2dd4bf'; lg.lineWidth = 1.5; lg.beginPath(); lg.moveTo(66, 52); lg.lineTo(66, 80); lg.moveTo(52, 66); lg.lineTo(80, 66); lg.stroke();
    }

    // ---------------------------------------------------------------- crop actions
    const rotateQuad = cw => {
      const f = cw ? ([x, y]) => [1 - y, x] : ([x, y]) => [y, 1 - x];
      const q = P.quad.map(f);
      P.quad = cw ? [q[3], q[0], q[1], q[2]] : [q[1], q[2], q[3], q[0]];
      P.rot = (P.rot + (cw ? 1 : 3)) % 4; wc = workCanvas(orig.img, P.rot, 1800); refreshAll();
    };
    const auto = () => { const q = detectQuad(orig.img, P.rot); if (q) { P.quad = q; refreshAll(); } else toast('Could not find the page edges — drag the handles by hand.', 'warn'); };

    // ---------------------------------------------------------------- colour controls
    const chips = h('div', { class: 'sce-chips' });
    let thumbsDirty = true;
    const fillChips = () => {
      chips.innerHTML = '';
      for (const [v, label] of FILTERS) {
        const c = h('canvas', { width: 64, height: 64 });
        try { const o = processScan(orig.img, { ...P, filter: v, shadow: undefined, bright: 0, contrast: 0, sharp: 0 }, 96); const r = Math.min(64 / o.width, 64 / o.height); const gg = c.getContext('2d'); gg.fillStyle = '#fff'; gg.fillRect(0, 0, 64, 64); gg.drawImage(o, (64 - o.width * r) / 2, (64 - o.height * r) / 2, o.width * r, o.height * r); } catch {}
        chips.append(h('button', { class: 'sce-chip' + (P.filter === v ? ' on' : ''), onclick: () => { P.filter = v; P.shadow = undefined; syncSliders(); refreshAll(); } }, c, h('span', {}, label)));
      }
      thumbsDirty = false;
    };
    const sl = {};
    const slider = (key, label, min, max, get, set) => {
      const val = h('span', { class: 'val' }), inp = h('input', { type: 'range', min, max, step: 1 });
      const sync = () => { const v = get(); inp.value = v; val.textContent = v; };
      inp.oninput = () => { set(+inp.value); val.textContent = inp.value; rebuild(); };
      sl[key] = { sync, row: h('label', { class: 'sce-slider' }, h('span', {}, label), inp, val) };
      sync(); return sl[key].row;
    };
    const rows = [
      slider('bright', 'Brightness', -60, 60, () => P.bright, v => { P.bright = v; }),
      slider('contrast', 'Contrast', -60, 60, () => P.contrast, v => { P.contrast = v; }),
      slider('shadow', 'Shadow removal', 0, 100, () => shadowOf(P), v => { P.shadow = v; }),
      slider('sharp', 'Sharpen', 0, 100, () => P.sharp || 0, v => { P.sharp = v; }),
      slider('thr', 'Black & white level', -60, 60, () => P.thr, v => { P.thr = v; }),
    ];
    const syncSliders = () => { for (const k in sl) sl[k].sync(); sl.thr.row.hidden = P.filter !== 'bw'; };
    const resetBtn = h('button', { class: 'sce-mini', onclick: () => { Object.assign(P, { bright: 0, contrast: 0, thr: 0, shadow: undefined, sharp: 0 }); syncSliders(); refreshAll(); } }, 'Reset');

    // ---------------------------------------------------------------- layout
    const tabCrop = h('button', { class: 'on', onclick: () => setMode('crop') }, 'Crop'), tabCol = h('button', { onclick: () => setMode('colour') }, 'Colour');
    const paneCrop = h('div', { class: 'sce-pane sce-row' },
      h('button', { onclick: auto }, 'Auto-detect'), h('button', { onclick: () => { P.quad = FULL(); refreshAll(); } }, 'Full image'),
      h('button', { onclick: () => rotateQuad(false), title: 'Rotate left' }, '⟲ Left'), h('button', { onclick: () => rotateQuad(true), title: 'Rotate right' }, 'Right ⟳'));
    const allBox = opts.allowAll ? h('label', { class: 'sce-all' }, h('input', { type: 'checkbox', onchange: e => { applyAll = e.target.checked; } }), ' Use this colour setting for all pages') : null;
    const paneCol = h('div', { class: 'sce-pane', hidden: true }, chips, h('div', { class: 'sce-sliders' }, ...rows, resetBtn), allBox);
    function setMode(m) {
      mode = m; tabCrop.classList.toggle('on', m === 'crop'); tabCol.classList.toggle('on', m === 'colour');
      paneCrop.hidden = m !== 'crop'; paneCol.hidden = m !== 'colour';
      if (m === 'colour') { result = processScan(orig.img, P, 1300); syncSliders(); fillChips(); }
      requestAnimationFrame(draw);
    }
    const done = v => { window.removeEventListener('resize', draw); document.removeEventListener('keydown', onKey, true); root.remove(); document.body.classList.remove('sce-open'); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const root = h('div', { class: 'sce', role: 'dialog', 'aria-label': opts.title || 'Crop and colour' },
      h('div', { class: 'sce-head' }, h('button', { onclick: () => done(null) }, 'Cancel'), h('b', {}, opts.title || 'Crop & colour'),
        h('button', { class: 'primary', onclick: () => done({ params: P, all: applyAll }) }, opts.applyLabel || 'Apply')),
      stage, h('div', { class: 'sce-foot' }, h('div', { class: 'sce-tabs' }, tabCrop, tabCol), paneCrop, paneCol));
    document.body.append(root); document.body.classList.add('sce-open');
    window.addEventListener('resize', draw); document.addEventListener('keydown', onKey, true);
    syncSliders();
    requestAnimationFrame(() => { setMode(mode); draw(); });
  });
}
