// Page viewer + all on-page tools.
import { S, edit, pushHist, emit, subscribe, uid, curPage, addAsset } from './state.js';
import { renderBase, dispSize, nat2disp, disp2nat, getTextRuns, sampleBg, getPdfPage } from './pdfio.js';
import { allItems, drawItem, frame, hit, move, textBitmap, BASE_FONTS, userFonts } from './prims.js';
import { $, h, modal, toast, clamp, icon } from './ui.js';
import { getSignatures, saveSignature, deleteSignature, addFontFile } from './fonts.js';

export const V = {
  mode: 'width', z: 1, token: 0, lastKey: '', draft: null, drag: null, tool: 'select',
  props: { color: '#d92d20', fillOn: false, fillColor: '#fff2a8', sw: 2, opacity: 1, font: 'auto', size: 16, bold: false, italic: false, align: 'left', hlColor: '#ffe600', textColor: '#0a1f8f', stamp: 'approved', stampText: '' },
  sig: null, onSelect: () => {}, onTool: () => {},
};
let scroller, pagebox, base, ov, formLayer, baseTask = null;
const dpr = () => Math.min(2, window.devicePixelRatio || 1);

export const STAMPS = {
  approved: { text: 'APPROVED', color: '#15803d' }, rejected: { text: 'REJECTED', color: '#b91c1c' },
  confidential: { text: 'CONFIDENTIAL', color: '#b91c1c' }, copy: { text: 'COPY', color: '#1d4ed8' },
  paid: { text: 'PAID', color: '#15803d' }, draft: { text: 'DRAFT', color: '#6b7280' }, received: { text: 'RECEIVED', color: '#1d4ed8' },
  satyapit: { text: 'सत्यापित', color: '#1d4ed8' }, pramanit: { text: 'प्रमाणित', color: '#15803d' }, praapt: { text: 'प्राप्त', color: '#1d4ed8' },
  date: { text: '{date}', color: '#111827', border: false }, tick: { text: '✓', color: '#15803d', border: false, size: 30 }, cross: { text: '✗', color: '#b91c1c', border: false, size: 30 },
  custom: { text: '', color: '#b91c1c' },
};
const today = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };

// ------------------------------------------------------------------ setup
export function initViewer() {
  scroller = $('#scroller'); pagebox = $('#pagebox'); base = $('#base'); ov = $('#ov'); formLayer = $('#formLayer');
  ov.addEventListener('pointerdown', onDown);
  ov.addEventListener('pointermove', onMove);
  ov.addEventListener('pointerup', onUp);
  ov.addEventListener('pointercancel', onUp);
  ov.addEventListener('dblclick', onDbl);
  scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
  new ResizeObserver(() => { if (V.mode !== 'custom') refresh(true); }).observe(scroller);
  subscribe(what => { if (what === 'items') { drawOverlay(); } else refresh(); });
}

export function setTool(t) {
  V.tool = t; V.draft = null; V.drag = null;
  if (t !== 'select') S.selItem = null;
  ov.style.cursor = t === 'select' ? 'default' : t === 'text' || t === 'edittext' ? 'text' : t === 'form' ? 'default' : 'crosshair';
  buildForm(); drawOverlay(); V.onTool(t); V.onSelect();
}

// ------------------------------------------------------------------ layout / render
function computeZoom(pg) {
  const d = dispSize(pg);
  const aw = Math.max(200, scroller.clientWidth - 36), ah = Math.max(200, scroller.clientHeight - 36);
  if (V.mode === 'width') return clamp(aw / d.w, 0.2, 4);
  if (V.mode === 'page') return clamp(Math.min(aw / d.w, ah / d.h), 0.2, 4);
  return V.z;
}
export function refresh(force = false) {
  const pg = curPage();
  if (!pg) return;
  const z = computeZoom(pg); V.z = z;
  const d = dispSize(pg);
  pagebox.style.width = d.w * z + 'px'; pagebox.style.height = d.h * z + 'px';
  const src = pg.src ? S.sources.get(pg.src.sid) : null;
  const key = [pg.id, pg.rot, pg.src?.sid, pg.src?.idx, z.toFixed(3), pg.w, pg.h].join('|');
  if (force || key !== V.lastKey) { V.lastKey = key; renderBaseNow(pg, z); buildForm(); }
  drawOverlay();
  $('#zoomLabel') && ($('#zoomLabel').textContent = Math.round(z * 100) + '%');
  $('#pageNum') && ($('#pageNum').value = S.cur + 1);
  $('#pageTotal') && ($('#pageTotal').textContent = '/ ' + S.pages.length);
}
function renderBaseNow(pg, z) {
  const my = ++V.token;
  if (baseTask) baseTask.cancel();
  const d = dispSize(pg);
  let px = z * dpr();
  const maxPx = 30e6; // keep canvas area sane
  if (d.w * d.h * px * px > maxPx) px = Math.sqrt(maxPx / (d.w * d.h));
  const t = renderBase(pg, px);
  baseTask = t;
  pagebox.classList.add('loading');
  t.done.then(c => {
    if (my !== V.token) return;
    base.width = c.width; base.height = c.height;
    base.getContext('2d').drawImage(c, 0, 0);
    pagebox.classList.remove('loading');
    drawOverlay();
  }).catch(e => { console.error(e); if (my === V.token) { pagebox.classList.remove('loading'); toast('Could not render this page: ' + (e?.message || e), 'error'); } });
}
export function goto(i) {
  if (!S.pages.length) return;
  i = clamp(i, 0, S.pages.length - 1);
  S.cur = i; S.selItem = null;
  if (!S.sel.has(S.pages[i].id) && S.sel.size <= 1) S.sel = new Set([S.pages[i].id]);
  emit('all'); scroller.scrollTo({ top: 0 });
}
export function zoomBy(f) { V.mode = 'custom'; V.z = clamp(V.z * f, 0.2, 5); refresh(true); }
export function setZoomMode(m) { V.mode = m; refresh(true); }

// ------------------------------------------------------------------ overlay drawing
function canvasMatrix(pg) {
  const m = nat2disp(pg), k = V.z * dpr();
  return [k * m[0], k * m[1], k * m[2], k * m[3], k * m[4], k * m[5]];
}
function rotPt(px, py, cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = px - cx, dy = py - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}
function handlesFor(it) {
  if (it.t === 'line') return [{ id: 'p1', x: it.x1, y: it.y1 }, { id: 'p2', x: it.x2, y: it.y2 }];
  if (it.t === 'pen') return [];
  const f = frame(it);
  if (f.rot) return [];
  const all = it.t === 'text' ? [['se', 1, 1]] : [['nw', 0, 0], ['ne', 1, 0], ['se', 1, 1], ['sw', 0, 1]];
  return all.map(([id, fx, fy]) => ({ id, x: f.x + fx * f.w, y: f.y + fy * f.h, fx, fy }));
}
export function selectedItem() {
  const pg = curPage();
  return pg && S.selItem != null ? pg.items.find(i => i.id === S.selItem) || null : null;
}

export function drawOverlay() {
  const pg = curPage();
  if (!pg || !ov) return;
  const d = dispSize(pg), k = V.z * dpr();
  const W = Math.round(d.w * k), H = Math.round(d.h * k);
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const g = ov.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  const cm = canvasMatrix(pg);
  g.setTransform(...cm);
  for (const it of allItems(pg, S.cur, S.pages.length)) drawItem(g, it);
  if (V.draft && V.draft.t !== 'crop') drawItem(g, V.draft);
  const px = 1 / V.z; // one CSS pixel in points
  // crop shade
  const crop = V.draft?.t === 'crop' ? V.draft : pg.crop;
  if (crop) {
    g.save(); g.fillStyle = 'rgba(15,23,42,.45)';
    g.beginPath(); g.rect(0, 0, pg.w, pg.h); g.rect(crop.x, crop.y, crop.w, crop.h); g.fill('evenodd');
    g.strokeStyle = '#2dd4bf'; g.lineWidth = 1.5 * px; g.setLineDash([6 * px, 4 * px]); g.strokeRect(crop.x, crop.y, crop.w, crop.h); g.restore();
  }
  // selection
  const it = selectedItem();
  if (it && V.tool === 'select') {
    const f = frame(it);
    g.save(); g.strokeStyle = '#0d9488'; g.lineWidth = 1.5 * px; g.setLineDash([5 * px, 3 * px]);
    if (f.rot) { g.translate(f.x + f.w / 2, f.y + f.h / 2); g.rotate(f.rot * Math.PI / 180); g.strokeRect(-f.w / 2 - 2 * px, -f.h / 2 - 2 * px, f.w + 4 * px, f.h + 4 * px); }
    else g.strokeRect(f.x - 2 * px, f.y - 2 * px, f.w + 4 * px, f.h + 4 * px);
    g.restore();
    g.save();
    for (const hd of handlesFor(it)) {
      g.fillStyle = '#fff'; g.strokeStyle = '#0d9488'; g.lineWidth = 1.5 * px;
      const r = 5 * px; g.beginPath(); g.rect(hd.x - r, hd.y - r, 2 * r, 2 * r); g.fill(); g.stroke();
    }
    g.restore();
  }
}

// ------------------------------------------------------------------ pointer helpers
function ptr(e) {
  const pg = curPage(), r = ov.getBoundingClientRect(), d = dispSize(pg);
  return disp2nat(pg, (e.clientX - r.left) * d.w / r.width, (e.clientY - r.top) * d.h / r.height);
}
function hitItem(pg, x, y) {
  const tol = 4 / V.z;
  for (let i = pg.items.length - 1; i >= 0; i--) if (hit(pg.items[i], x, y, tol)) return pg.items[i];
  return null;
}
function hitHandle(it, x, y) {
  const r = 9 / V.z;
  return handlesFor(it).find(hd => Math.abs(hd.x - x) <= r && Math.abs(hd.y - y) <= r) || null;
}
const clone = o => JSON.parse(JSON.stringify(o));

function newItem(tool, x, y) {
  const P = V.props;
  const common = { id: uid(), opacity: P.opacity };
  switch (tool) {
    case 'rect': case 'ellipse': return { ...common, t: tool, x, y, w: 0, h: 0, stroke: P.color, sw: P.sw, fill: P.fillOn ? P.fillColor : null };
    case 'hl': return { id: uid(), t: 'hl', x, y, w: 0, h: 0, fill: P.hlColor, opacity: 1 };
    case 'white': return { id: uid(), t: 'white', x, y, w: 0, h: 0, fill: '#ffffff' };
    case 'redact': return { id: uid(), t: 'redact', x, y, w: 0, h: 0 };
    case 'line': case 'arrow': return { ...common, t: 'line', x1: x, y1: y, x2: x, y2: y, stroke: P.color, sw: P.sw, arrow: tool === 'arrow' };
    case 'pen': return { ...common, t: 'pen', pts: [[x, y]], stroke: P.color, sw: P.sw };
    case 'crop': return { t: 'crop', x, y, w: 0, h: 0 };
  }
}
const BOX_TOOLS = new Set(['rect', 'ellipse', 'hl', 'white', 'redact', 'crop']);

function onDown(e) {
  const pg = curPage(); if (!pg) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const [x, y] = ptr(e);
  const tool = V.tool;
  if (tool === 'select') {
    const sel = selectedItem();
    if (sel) {
      const hd = hitHandle(sel, x, y);
      if (hd) { V.drag = { kind: 'resize', hd, orig: clone(sel), f: frame(sel), pushed: false }; ov.setPointerCapture(e.pointerId); return; }
    }
    const it = hitItem(pg, x, y);
    if (it) {
      S.selItem = it.id; V.onSelect();
      V.drag = { kind: 'move', start: [x, y], orig: clone(it), pushed: false };
      ov.setPointerCapture(e.pointerId);
    } else { S.selItem = null; V.onSelect(); }
    drawOverlay(); return;
  }
  if (BOX_TOOLS.has(tool) || tool === 'line' || tool === 'arrow' || tool === 'pen') {
    V.draft = newItem(tool, x, y); V.drag = { kind: 'create', start: [x, y] };
    ov.setPointerCapture(e.pointerId); return;
  }
  // click tools handled on pointerup to allow scrolling gestures; remember down point
  V.drag = { kind: 'click', start: [x, y], t: Date.now() };
}

function onMove(e) {
  const pg = curPage(); if (!pg) return;
  const [x, y] = ptr(e);
  const dg = V.drag;
  if (!dg) {
    if (V.tool === 'select') {
      const sel = selectedItem();
      ov.style.cursor = sel && hitHandle(sel, x, y) ? 'nwse-resize' : hitItem(pg, x, y) ? 'move' : 'default';
    }
    return;
  }
  if (dg.kind === 'create') {
    const d = V.draft, [sx, sy] = dg.start;
    if (d.t === 'line') {
      let ex = x, ey = y;
      if (e.shiftKey) { const a = Math.round(Math.atan2(y - sy, x - sx) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(x - sx, y - sy); ex = sx + L * Math.cos(a); ey = sy + L * Math.sin(a); }
      d.x2 = ex; d.y2 = ey;
    } else if (d.t === 'pen') {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) > 0.8) d.pts.push([x, y]);
    } else {
      let w = x - sx, hh = y - sy;
      if (e.shiftKey && (d.t === 'rect' || d.t === 'ellipse')) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
      d.x = Math.min(sx, sx + w); d.y = Math.min(sy, sy + hh); d.w = Math.abs(w); d.h = Math.abs(hh);
    }
    drawOverlay(); return;
  }
  const it = selectedItem();
  if (!it) return;
  if (dg.kind === 'move') {
    if (!dg.pushed) { if (Math.hypot(x - dg.start[0], y - dg.start[1]) * V.z < 3) return; pushHist(); dg.pushed = true; }
    Object.assign(it, clone(dg.orig));
    move(it, x - dg.start[0], y - dg.start[1]);
    drawOverlay();
  } else if (dg.kind === 'resize') {
    if (!dg.pushed) { pushHist(); dg.pushed = true; }
    const o = dg.orig, f = dg.f, hd = dg.hd;
    if (it.t === 'line') { if (hd.id === 'p1') { it.x1 = x; it.y1 = y; } else { it.x2 = x; it.y2 = y; } }
    else if (it.t === 'text') {
      const s = clamp(((x - f.x) / f.w + (y - f.y) / f.h) / 2, 0.15, 12);
      it.size = clamp(+(o.size * s).toFixed(1), 4, 300); if (o.wrap) it.wrap = o.wrap * s;
    } else {
      const ax = hd.fx ? f.x : f.x + f.w, ay = hd.fy ? f.y : f.y + f.h;
      let w = Math.abs(x - ax), hh = Math.abs(y - ay);
      if (it.t === 'img') { hh = w * f.h / f.w; }
      it.w = Math.max(2, w); it.h = Math.max(2, hh);
      it.x = (x >= ax || it.t === 'img' && hd.fx) ? ax : ax - it.w;
      it.y = (y >= ay || it.t === 'img' && hd.fy) ? ay : ay - it.h;
      if (it.t === 'img') { it.x = hd.fx ? ax : ax - it.w; it.y = hd.fy ? ay : ay - it.h; }
    }
    drawOverlay();
  }
}

async function onUp(e) {
  const pg = curPage(); if (!pg) return;
  const dg = V.drag; V.drag = null;
  if (!dg) return;
  const [x, y] = ptr(e);
  if (dg.kind === 'create') {
    const d = V.draft; V.draft = null;
    let ok = true;
    if (d.t === 'line') ok = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 3;
    else if (d.t === 'pen') ok = d.pts.length > 1 || true;
    else ok = d.w > 3 && d.h > 3;
    if (!ok) { drawOverlay(); return; }
    if (d.t === 'crop') { pushHist(); pg.crop = { x: d.x, y: d.y, w: d.w, h: d.h }; emit('all'); toast('Crop set. It is applied when you save. Use Pages → "Clear crop" to undo.', 'info'); return; }
    pushHist(); pg.items.push(d);
    if (V.tool !== 'pen') { S.selItem = d.id; }
    emit('items'); V.onSelect();
    if (V.tool !== 'pen' && V.tool !== 'redact' && V.tool !== 'white' && V.tool !== 'hl') { /* stay on tool for repeated drawing */ }
    return;
  }
  if (dg.kind === 'click') {
    if (Math.hypot(x - dg.start[0], y - dg.start[1]) * V.z > 6) return;
    await clickTool(V.tool, x, y);
    return;
  }
  if (dg.kind === 'move' || dg.kind === 'resize') { emit('items'); V.onSelect(); }
}

function onDbl(e) {
  const pg = curPage(); if (!pg || V.tool !== 'select') return;
  const [x, y] = ptr(e), it = hitItem(pg, x, y);
  if (it && it.t === 'text') editTextItem(it);
}

// ------------------------------------------------------------------ click-style tools
async function clickTool(tool, x, y) {
  const pg = curPage();
  if (tool === 'text') {
    const res = await textDialog({ text: '', size: V.props.size, color: V.props.textColor, font: V.props.font, bold: V.props.bold, italic: V.props.italic, align: V.props.align }, 'Add text');
    if (!res) return;
    rememberTextProps(res);
    pushHist();
    const it = { id: uid(), t: 'text', x, y: y - res.size * 0.2, ...res, opacity: 1 };
    pg.items.push(it); S.selItem = it.id; V.onSelect(); setTool('select'); emit('items'); V.onTool('select');
  } else if (tool === 'stamp') {
    const st = STAMPS[V.props.stamp] || STAMPS.approved;
    let text = st.text === '{date}' ? today() : st.text;
    if (V.props.stamp === 'custom') text = V.props.stampText || 'STAMP';
    const it = { id: uid(), t: 'text', text, size: st.size || 22, color: st.color, bold: true, border: st.border !== false, bw: 2, font: 'auto', opacity: 0.92, rot: st.border === false ? 0 : -8, x: 0, y: 0 };
    const b = textBitmap(it); it.x = x - b.w / 2; it.y = y - b.h / 2;
    pushHist(); pg.items.push(it); S.selItem = it.id; emit('items'); V.onSelect();
  } else if (tool === 'sign') {
    if (!V.sig) { const ok = await signatureDialog(); if (!ok) return; }
    placeSignature(x, y);
  } else if (tool === 'edittext') {
    await editExistingText(x, y);
  }
}

function placeSignature(x, y) {
  const pg = curPage(), a = S.assets.get(V.sig);
  const w = Math.min(160, pg.w * 0.35), hh = w * (a.h / a.w);
  const it = { id: uid(), t: 'img', aid: V.sig, x: x - w / 2, y: y - hh / 2, w, h: hh, opacity: 1, sig: 1 };
  pushHist(); pg.items.push(it); S.selItem = it.id; emit('items'); V.onSelect(); setTool('select');
}

async function editExistingText(x, y) {
  const pg = curPage();
  const runs = await getTextRuns(pg);
  const run = runs.find(r => x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.base - r.size * 0.95 && y <= r.base + r.size * 0.35);
  if (!run) {
    toast(pg.src && S.sources.get(pg.src.sid).kind === 'pdf' ? 'No editable text under the cursor. (Scanned pages have no text — use Text + Whiteout instead.)' : 'This page has no text layer. Use Whiteout + Text.', 'warn');
    return;
  }
  const rect = { x: run.x - 1.5, y: run.base - run.size * 0.95, w: run.w + 3, h: run.size * 1.3 };
  // sample the background colour from the rendered page
  const m = nat2disp(pg), k = base.width / dispSize(pg).w;
  const c1 = [m[0] * rect.x + m[2] * rect.y + m[4], m[1] * rect.x + m[3] * rect.y + m[5]], c2 = [m[0] * (rect.x + rect.w) + m[2] * (rect.y + rect.h) + m[4], m[1] * (rect.x + rect.w) + m[3] * (rect.y + rect.h) + m[5]];
  const bg = sampleBg(base, Math.min(c1[0], c2[0]) * k, Math.min(c1[1], c2[1]) * k, Math.abs(c2[0] - c1[0]) * k, Math.abs(c2[1] - c1[1]) * k);
  const res = await textDialog({ text: run.str, size: +run.size.toFixed(1), color: '#000000', font: V.props.font, bold: false, italic: false, align: 'left' }, 'Edit text (covers the original)');
  if (!res) return;
  const it = { id: uid(), t: 'text', ...res, pad: 0, opacity: 1, x: run.x, y: run.base - res.size };
  pushHist();
  pg.items.push({ id: uid(), t: 'white', ...rect, fill: bg, opacity: 1 }, it);
  S.selItem = it.id; emit('items'); V.onSelect();
}

export async function editTextItem(it) {
  const res = await textDialog({ text: it.text, size: it.size, color: it.color, font: it.font, bold: it.bold, italic: it.italic, align: it.align || 'left' }, 'Edit text');
  if (!res) return;
  pushHist(); Object.assign(it, res); emit('items'); V.onSelect();
}
function rememberTextProps(r) { Object.assign(V.props, { size: r.size, textColor: r.color, font: r.font, bold: r.bold, italic: r.italic, align: r.align }); }

// ------------------------------------------------------------------ item operations
export function deleteSelected() {
  const pg = curPage(), it = selectedItem(); if (!pg || !it) return false;
  pushHist(); pg.items = pg.items.filter(i => i.id !== it.id); S.selItem = null; emit('items'); V.onSelect(); return true;
}
export function duplicateSelected() {
  const pg = curPage(), it = selectedItem(); if (!pg || !it) return;
  pushHist(); const c = clone(it); c.id = uid(); move(c, 12, 12); delete c.formKey; pg.items.push(c); S.selItem = c.id; emit('items'); V.onSelect();
}
export function nudge(dx, dy) {
  const it = selectedItem(); if (!it) return;
  if (!V.nudgeAt || Date.now() - V.nudgeAt > 700) pushHist();
  V.nudgeAt = Date.now(); move(it, dx, dy); emit('items');
}
export function arrange(dir) { // 'front' | 'back'
  const pg = curPage(), it = selectedItem(); if (!pg || !it) return;
  pushHist(); pg.items = pg.items.filter(i => i !== it); dir === 'front' ? pg.items.push(it) : pg.items.unshift(it); emit('items');
}
/** Apply a property change to the selected item (and remember as default). */
export function setProp(key, value, itemKey) {
  V.props[key] = value;
  const it = selectedItem();
  if (!it) return;
  const map = { color: it.t === 'text' ? 'color' : 'stroke', textColor: 'color', sw: 'sw', opacity: 'opacity', size: 'size', font: 'font', bold: 'bold', italic: 'italic', align: 'align', fillColor: 'fill', hlColor: 'fill' };
  const k = itemKey || map[key]; if (!k) return;
  if (key === 'color' && it.t === 'text') return;
  if (key === 'textColor' && it.t !== 'text') return;
  if (key === 'size' && it.t !== 'text') return;
  if (!V.propAt || Date.now() - V.propAt > 800) pushHist();
  V.propAt = Date.now();
  it[k] = value; emit('items');
}
export function setFillOn(on) {
  V.props.fillOn = on;
  const it = selectedItem(); if (!it || !(it.t === 'rect' || it.t === 'ellipse')) return;
  pushHist(); it.fill = on ? V.props.fillColor : null; emit('items');
}

// ------------------------------------------------------------------ image insertion
export async function insertImageFile(file) {
  const pg = curPage(); if (!pg) return;
  const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  const img = new Image(); img.src = url; await img.decode();
  let use = url, w = img.naturalWidth, hh = img.naturalHeight;
  if (Math.max(w, hh) > 2000) { // downscale big photos
    const s = 2000 / Math.max(w, hh), c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(hh * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); use = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9); w = c.width; hh = c.height;
  }
  const aid = addAsset(use, w, hh);
  const pw = Math.min(pg.w * 0.4, 220), ph = pw * hh / w;
  const it = { id: uid(), t: 'img', aid, x: (pg.w - pw) / 2, y: (pg.h - ph) / 2, w: pw, h: ph, opacity: 1 };
  pushHist(); pg.items.push(it); S.selItem = it.id; emit('items'); setTool('select');
}

// ------------------------------------------------------------------ form filling
export async function buildForm() {
  formLayer.innerHTML = '';
  if (V.tool !== 'form') return;
  const pg = curPage(); if (!pg || !pg.src) return;
  const src = S.sources.get(pg.src.sid);
  if (src.kind !== 'pdf') { return; }
  const pp = await getPdfPage(pg.src.sid, pg.src.idx);
  const anns = (await pp.getAnnotations()).filter(a => a.subtype === 'Widget' && !a.readOnly && ['Tx', 'Btn', 'Ch'].includes(a.fieldType) && !a.pushButton);
  if (V.tool !== 'form' || curPage() !== pg) return;
  if (!anns.length) { toast('No fillable fields on this page. Use the Text tool to type anywhere.', 'info'); return; }
  const vp = pp.getViewport({ scale: 1, rotation: pp.rotate });
  const m = nat2disp(pg), z = V.z;
  const tr = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  for (const a of anns) {
    const tf = vp.transform, P = (x, y) => [tf[0] * x + tf[2] * y + tf[4], tf[1] * x + tf[3] * y + tf[5]];
    const q1 = P(a.rect[0], a.rect[1]), q2 = P(a.rect[2], a.rect[3]);
    const r = [q1[0], q1[1], q2[0], q2[1]];
    const nx = Math.min(r[0], r[2]), ny = Math.min(r[1], r[3]), nw = Math.abs(r[2] - r[0]), nh = Math.abs(r[3] - r[1]);
    const c1 = tr(nx, ny), c2 = tr(nx + nw, ny + nh);
    const box = { left: Math.min(c1[0], c2[0]) * z, top: Math.min(c1[1], c2[1]) * z, width: Math.abs(c2[0] - c1[0]) * z, height: Math.abs(c2[1] - c1[1]) * z };
    const key = 'f:' + a.id;
    const items = pg.items.filter(i => i.formKey === key);
    const curText = items.find(i => i.t === 'text');
    let el;
    const isCheck = a.fieldType === 'Btn' && (a.checkBox || a.radioButton);
    if (isCheck) {
      const orig = a.fieldValue && a.fieldValue !== 'Off' && a.fieldValue !== false;
      el = h('input', { type: 'checkbox', class: 'form-el', title: a.fieldName || '' });
      el.checked = items.length ? !!curText : !!orig;
      el.addEventListener('change', () => setFormItems(key, { nx, ny, nw, nh }, 'check', el.checked, orig));
    } else if (a.fieldType === 'Ch') {
      el = h('select', { class: 'form-el' }, h('option', { value: '' }, ''), (a.options || []).map(o => h('option', { value: o.displayValue ?? o.exportValue }, o.displayValue ?? o.exportValue)));
      const orig = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue || '';
      el.value = curText ? curText.text : orig;
      el.addEventListener('change', () => setFormItems(key, { nx, ny, nw, nh }, 'text', el.value, orig));
    } else {
      const orig = a.fieldValue || '';
      el = a.multiLine ? h('textarea', { class: 'form-el', rows: 2 }) : h('input', { type: 'text', class: 'form-el', lang: 'hi' });
      el.value = curText ? curText.text : orig;
      if (a.maxLen) el.maxLength = a.maxLen;
      el.title = a.fieldName || '';
      el.addEventListener('change', () => setFormItems(key, { nx, ny, nw, nh, multi: a.multiLine }, 'text', el.value, orig));
    }
    Object.assign(el.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px', fontSize: Math.max(9, Math.min(box.height * 0.62, 18)) + 'px' });
    formLayer.append(el);
  }
}
function setFormItems(key, r, kind, value, orig) {
  const pg = curPage();
  pushHist();
  pg.items = pg.items.filter(i => i.formKey !== key);
  const changed = kind === 'check' ? !!value !== !!orig : String(value) !== String(orig);
  if (changed) {
    pg.items.push({ id: uid(), t: 'white', formKey: key, x: r.nx, y: r.ny, w: r.nw, h: r.nh, fill: '#ffffff', opacity: 1 });
    if ((kind === 'check' && value) || (kind === 'text' && value)) {
      const it = { id: uid(), t: 'text', formKey: key, text: kind === 'check' ? '✓' : value, size: kind === 'check' ? Math.min(r.nh * 0.95, 22) : clamp(r.nh * 0.68, 7, r.multi ? 11 : 16), color: '#0a1f8f', font: 'auto', pad: 1.5, opacity: 1, x: r.nx + 1, y: r.ny, wrap: r.multi ? r.nw - 3 : 0 };
      const b = textBitmap(it);
      it.y = r.multi ? r.ny + 1 : r.ny + (r.nh - b.h) / 2;
      if (kind === 'check') it.x = r.nx + (r.nw - b.w) / 2;
      pg.items.push(it);
    }
  }
  emit('items');
}

// ------------------------------------------------------------------ text dialog
export async function textDialog(init, title = 'Text') {
  const o = { ...init };
  const ta = h('textarea', { rows: 4, lang: 'hi', spellcheck: 'false', placeholder: 'Type here — Hindi (देवनागरी) or English', style: { width: '100%', fontSize: '16px' } });
  ta.value = o.text || '';
  const fontSel = h('select', {});
  const fillFonts = () => {
    fontSel.innerHTML = '';
    for (const [v, l] of BASE_FONTS) fontSel.append(h('option', { value: v }, l));
    for (const f of userFonts) fontSel.append(h('option', { value: f }, f + '  (added)'));
    fontSel.value = o.font || 'auto';
  };
  fillFonts();
  const size = h('input', { type: 'number', min: 4, max: 300, step: 0.5, value: o.size, style: { width: '72px' } });
  const color = h('input', { type: 'color', value: o.color || '#000000' });
  const bold = h('input', { type: 'checkbox' }); bold.checked = !!o.bold;
  const ital = h('input', { type: 'checkbox' }); ital.checked = !!o.italic;
  const align = h('select', {}, ['left', 'center', 'right'].map(a => h('option', { value: a, selected: a === (o.align || 'left') }, a)));
  const prev = h('canvas', { class: 'text-preview' });
  const fontIn = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true, onchange: async e => { const f = e.target.files[0]; if (!f) return; try { o.font = await addFontFile(f); fillFonts(); update(); toast('Font added and saved in this browser: ' + o.font, 'ok'); } catch (err) { toast('Could not load that font file.', 'error'); } } });
  const get = () => ({ text: ta.value, size: Math.max(4, +size.value || 14), color: color.value, font: fontSel.value, bold: bold.checked, italic: ital.checked, align: align.value });
  const update = () => {
    const v = get(); const it = { t: 'text', ...v, pad: 4 };
    if (!v.text.trim()) { prev.width = 10; prev.height = 10; return; }
    const b = textBitmap(it);
    const s = Math.min(1, 520 / b.canvas.width, 160 / b.canvas.height);
    prev.width = Math.max(1, Math.round(b.canvas.width * s)); prev.height = Math.max(1, Math.round(b.canvas.height * s));
    prev.getContext('2d').drawImage(b.canvas, 0, 0, prev.width, prev.height);
  };
  for (const el of [ta, size, color, bold, ital, align, fontSel]) el.addEventListener('input', update);
  const body = h('div', { class: 'text-dlg' },
    ta,
    h('div', { class: 'row wrap' },
      h('label', { class: 'field inline' }, 'Font', fontSel), h('button', { class: 'small', onclick: () => fontIn.click(), type: 'button' }, '+ Add font file…'), fontIn),
    h('div', { class: 'row wrap' },
      h('label', { class: 'field inline' }, 'Size', size), h('label', { class: 'field inline' }, 'Colour', color),
      h('label', { class: 'check' }, bold, ' Bold'), h('label', { class: 'check' }, ital, ' Italic'), h('label', { class: 'field inline' }, 'Align', align)),
    h('div', { class: 'preview-wrap' }, h('div', { class: 'hint' }, 'Preview (exactly how it will appear):'), prev));
  const r = await modal({
    title, body, width: 560,
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }], cancelValue: false,
    validate: () => { if (!ta.value.trim()) { ta.focus(); return false; } return true; },
    onOpen: () => { ta.focus(); update(); setTimeout(update, 250); },
  });
  return r ? get() : null;
}

// ------------------------------------------------------------------ signature dialog
export async function signatureDialog() {
  let chosen = null;
  const saved = await getSignatures();
  const cv = h('canvas', { width: 640, height: 220, class: 'sig-canvas' });
  const g = cv.getContext('2d');
  g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0a1f8f';
  let drawing = false, drewAny = false;
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  cv.addEventListener('pointerdown', e => { drawing = true; drewAny = true; cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); g.beginPath(); g.moveTo(x, y); g.lineTo(x + 0.1, y); g.stroke(); });
  cv.addEventListener('pointermove', e => { if (!drawing) return; const [x, y] = pos(e); g.lineTo(x, y); g.stroke(); g.beginPath(); g.moveTo(x, y); });
  cv.addEventListener('pointerup', () => { drawing = false; });
  const inkSel = h('select', { onchange: e => { g.strokeStyle = e.target.value; } }, [['#0a1f8f', 'Blue ink'], ['#111111', 'Black ink']].map(([v, l]) => h('option', { value: v }, l)));
  const upPrev = h('canvas', { class: 'sig-up', width: 10, height: 10 });
  let upImg = null;
  const rmBg = h('input', { type: 'checkbox', checked: true });
  const redrawUp = () => {
    if (!upImg) return;
    const s = Math.min(1, 640 / upImg.naturalWidth); upPrev.width = Math.round(upImg.naturalWidth * s); upPrev.height = Math.round(upImg.naturalHeight * s);
    const x = upPrev.getContext('2d'); x.clearRect(0, 0, upPrev.width, upPrev.height); x.drawImage(upImg, 0, 0, upPrev.width, upPrev.height);
    if (rmBg.checked) {
      const id = x.getImageData(0, 0, upPrev.width, upPrev.height), d = id.data;
      for (let i = 0; i < d.length; i += 4) { const lum = (d[i] + d[i + 1] + d[i + 2]) / 3; d[i + 3] = lum > 205 ? 0 : Math.min(255, (205 - lum) * 255 / 120); }
      x.putImageData(id, 0, 0);
    }
  };
  rmBg.addEventListener('change', redrawUp);
  const fileIn = h('input', { type: 'file', accept: 'image/*', onchange: async e => { const f = e.target.files[0]; if (!f) return; const url = URL.createObjectURL(f); upImg = new Image(); upImg.src = url; await upImg.decode(); redrawUp(); } });
  const tabs = ['Draw', 'Upload image'];
  const paneDraw = h('div', {}, cv, h('div', { class: 'row' }, inkSel, h('button', { class: 'small', onclick: () => { g.clearRect(0, 0, cv.width, cv.height); drewAny = false; } }, 'Clear'), h('span', { class: 'hint' }, 'Sign with mouse, finger or stylus')));
  const paneUp = h('div', { hidden: true }, fileIn, h('label', { class: 'check' }, rmBg, ' Remove white background'), h('div', { class: 'sig-up-wrap' }, upPrev));
  let mode = 0;
  const tabBar = h('div', { class: 'seg' }, tabs.map((t, i) => h('button', { class: i === 0 ? 'on' : '', onclick: e => { mode = i; paneDraw.hidden = i !== 0; paneUp.hidden = i !== 1; [...tabBar.children].forEach((b, j) => b.classList.toggle('on', j === i)); } }, t)));
  const savedRow = h('div', { class: 'sig-saved' });
  const renderSaved = () => {
    savedRow.innerHTML = '';
    if (!saved.length) return;
    savedRow.append(h('div', { class: 'hint' }, 'Saved signatures (stored only in this browser):'));
    const wrap = h('div', { class: 'row wrap' });
    saved.forEach((u, i) => wrap.append(h('div', { class: 'sig-item' },
      h('img', { src: u, onclick: () => { chosen = u; document.querySelector('dialog.modal .modal-foot .primary').click(); } }),
      h('button', { class: 'icon small', title: 'Delete', onclick: async () => { await deleteSignature(i); saved.splice(i, 1); renderSaved(); }, html: icon('trash', 14) }))));
    savedRow.append(wrap);
  };
  renderSaved();
  const body = h('div', { class: 'sig-dlg' }, tabBar, paneDraw, paneUp, savedRow);
  const exportTrim = c => {
    const x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height), d = id.data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) if (d[(y * c.width + xx) * 4 + 3] > 12) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 <= x0 || y1 <= y0) return null;
    const out = document.createElement('canvas'); out.width = x1 - x0 + 1 + 8; out.height = y1 - y0 + 1 + 8;
    out.getContext('2d').drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 4, 4, x1 - x0 + 1, y1 - y0 + 1);
    return out.toDataURL('image/png');
  };
  const r = await modal({
    title: 'Your signature', body, width: 700, buttons: [{ label: 'Cancel', value: false }, { label: 'Use this signature', value: true, primary: true }], cancelValue: false,
    validate: () => {
      if (chosen) return true;
      const url = mode === 0 ? (drewAny ? exportTrim(cv) : null) : (upImg ? exportTrim(upPrev) : null);
      if (!url) { toast('Draw or upload a signature first.', 'warn'); return false; }
      chosen = url; return true;
    },
  });
  if (!r || !chosen) return false;
  if (!saved.includes(chosen)) await saveSignature(chosen);
  const img = new Image(); img.src = chosen; await img.decode();
  V.sig = addAsset(chosen, img.naturalWidth, img.naturalHeight);
  return true;
}
