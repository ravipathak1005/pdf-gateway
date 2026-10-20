// Scanner mode — a deliberately small, separate flow: capture/import → crop → colour → review → save.
// No text, stamps, forms or redaction here; "Open in editor" hands the pages over to the full editor.
import { S, edit, pushHist, emit, undo, subscribe, newPage } from './state.js';
import { addImageSource, fitA4 } from './pdfio.js';
import { defParams, buildScanSource, detectQuad, FILTERS } from './scan.js';
import { openCropEditor } from './scan-editor.js';
import { buildPdf, renderPagesToImages, zipFiles, download } from './export.js';
import { createOcr } from './ocr.js';
import { offerShare } from './share.js';
import { P as PROJ, renameProject } from './projects.js';
import { $, h, toast, busy, confirmBox, baseName } from './ui.js';

const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const cfg = () => (S.meta.scan ||= { size: 'a4', quality: 'high', filter: 'auto', ocr: false });
let hooks = { back() {}, toEditor() {} };

export function initScanner(h2) {
  hooks = h2;
  $('#scBack').onclick = () => hooks.back();
  $('#scCam').onclick = () => $('#scCamIn').click();
  $('#scAdd').onclick = () => $('#scFileIn').click();
  $('#scCamIn').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addPhotos(f, true); });
  $('#scFileIn').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addPhotos(f); });
  $('#scUndo').onclick = () => { undo(); };
  $('#scSize').onchange = e => { cfg().size = e.target.value; applyPageSize(); emit('all'); };
  $('#scQual').onchange = e => { cfg().quality = e.target.value; };
  $('#scOcr').onchange = e => { cfg().ocr = e.target.checked; };
  $('#scSavePdf').onclick = () => savePdf(); $('#scShare').onclick = () => savePdf(true); $('#scSaveImg').onclick = saveImages; $('#scEditor').onclick = () => hooks.toEditor();
  $('#scName').addEventListener('change', async e => { const v = e.target.value.trim() || 'Scan'; PROJ.name = v; if (PROJ.id) renameProject(PROJ.id, v); emit('meta'); });
  const fl = $('#scFilters');
  for (const [v, l] of FILTERS) fl.append(h('button', { 'data-f': v, onclick: () => filterAll(v) }, l));
  $('#scCropAll').onclick = () => cropAll();
  subscribe(() => { if (!$('#scanner').hidden) render(); });
  initDock();
}

// The options panel can be dragged anywhere (position remembered) and collapsed.
function initDock() {
  const dock = $('#scDock'), grip = $('#scGrip');
  let pos = { x: 0, y: 0 }, collapsed = false;
  try { Object.assign(pos, JSON.parse(localStorage.getItem('pgDock') || '{}')); collapsed = localStorage.getItem('pgDockC') === '1'; } catch {}
  const apply = () => {
    const r = dock.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    // keep the panel on screen: x moves horizontally (limited by its width), y is an upward offset from the bottom
    const minY = -(H - r.height - 60) , maxY = 0;
    pos.y = Math.max(minY, Math.min(maxY, pos.y)); pos.x = Math.max(-(W - Math.min(r.width, W)) , Math.min(W - Math.min(r.width, W), pos.x));
    dock.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    dock.classList.toggle('collapsed', collapsed);
  };
  const save = () => { try { localStorage.setItem('pgDock', JSON.stringify(pos)); localStorage.setItem('pgDockC', collapsed ? '1' : '0'); } catch {} };
  let d = null;
  grip.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; d = { x: e.clientX - pos.x, y: e.clientY - pos.y }; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
  grip.addEventListener('pointermove', e => { if (!d) return; pos.x = e.clientX - d.x; pos.y = e.clientY - d.y; apply(); });
  const end = () => { if (d) { d = null; save(); } };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => { pos = { x: 0, y: 0 }; apply(); save(); });
  $('#scCollapse').onclick = () => { collapsed = !collapsed; apply(); save(); };
  window.addEventListener('resize', apply);
  window._dockApply = apply; apply();
}

export function showScanner() {
  $('#scName').value = PROJ.name || 'Scan';
  const c = cfg(); $('#scSize').value = c.size; $('#scQual').value = c.quality; $('#scOcr').checked = !!c.ocr;
  render();
  window._dockApply?.();
}

// ---------------------------------------------------------------- page building
const isImg = pg => pg.src && S.sources.get(pg.src.sid)?.kind === 'img';
function applyPageSize() {
  const a4 = cfg().size === 'a4';
  for (const pg of S.pages) {
    if (!isImg(pg)) continue;
    const s = S.sources.get(pg.src.sid), q = pg.scan?.params?.quad, f = a4 ? fitA4(s.w, s.h) : { w: +(s.w * 72 / 200).toFixed(2), h: +(s.h * 72 / 200).toFixed(2) };
    pg.w = f.w; pg.h = f.h;
  }
}
function dropUnusedSource(sid) {
  if (S.pages.some(p => p.src?.sid === sid || p.scan?.orig === sid)) return;
  const s = S.sources.get(sid); if (!s) return;
  if (s.url) URL.revokeObjectURL(s.url); S.sources.delete(sid);
}

export async function addPhotos(files, camera = false) {
  busy('Adding photos…', 0);
  try {
    const made = []; let k = 0;
    for (const f of files) {
      busy(`Straightening ${++k}/${files.length}…`, (k - 1) / files.length);
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|bmp)$/i.test(f.name)) { toast(`${f.name}: not an image — the scanner takes photos only.`, 'warn'); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const op = (await addImageSource(f.name, bytes, f.type || 'image/jpeg'))[0];
      const orig = S.sources.get(op.src.sid);
      const P = defParams(cfg().filter); P.quad = detectQuad(orig.img, 0) || FULL.map(p => [...p]);
      const r = await buildScanSource(orig, P);
      made.push(newPage({ src: { sid: r.sid, idx: 0 }, w: 595, h: 842, scan: { orig: orig.id, params: P } }));
      await new Promise(r2 => setTimeout(r2));
    }
    if (!made.length) return;
    edit(() => { S.pages.push(...made); applyPageSize(); S.cur = S.pages.length - 1; });
    if (camera) toast('Added. Tap “Crop & colour” on a page to fine-tune it.', 'ok');
  } catch (e) { console.error(e); toast('Could not add photos: ' + (e?.message || e), 'error'); } finally { busy(false); }
}

async function rebuild(pg, P) {
  const orig = S.sources.get(pg.scan?.orig ?? pg.src.sid), old = pg.src.sid;
  const r = await buildScanSource(orig, P);
  pg.src = { sid: r.sid, idx: 0 }; pg.scan = { orig: orig.id, params: P };
  if (old !== orig.id) dropUnusedSource(old);
}

async function editPage(i, startColour = false) {
  const pg = S.pages[i]; if (!pg || !isImg(pg)) return;
  const origId = pg.scan?.orig ?? pg.src.sid, orig = S.sources.get(origId);
  const P0 = pg.scan?.params ? JSON.parse(JSON.stringify(pg.scan.params)) : defParams('orig');
  const res = await openCropEditor(orig, P0, { allowAll: S.pages.length > 1, title: `Page ${i + 1} · crop & colour`, applyLabel: 'Apply', startColour });
  if (!res) return;
  busy('Applying…', 0);
  try {
    pushHist();
    await rebuild(pg, res.params);
    if (res.all) {
      const { filter, bright, contrast, shadow, sharp, thr } = res.params;
      for (const p of S.pages) if (p !== pg && isImg(p)) { const q = p.scan?.params ? JSON.parse(JSON.stringify(p.scan.params)) : { ...defParams(filter), quad: FULL.map(x => [...x]) }; Object.assign(q, { filter, bright, contrast, shadow, sharp, thr }); await rebuild(p, q); }
    }
    applyPageSize(); emit('all');
  } catch (e) { console.error(e); toast('Failed: ' + e.message, 'error'); } finally { busy(false); }
}

async function filterAll(f) {
  if (!S.pages.length) return;
  busy('Applying colour…', 0);
  try {
    pushHist(); cfg().filter = f; let k = 0;
    for (const p of S.pages) {
      if (!isImg(p)) continue;
      busy(`Page ${++k}/${S.pages.length}`, k / S.pages.length);
      const q = p.scan?.params ? JSON.parse(JSON.stringify(p.scan.params)) : { ...defParams(f), quad: FULL.map(x => [...x]) };
      Object.assign(q, { filter: f, shadow: undefined, bright: 0, contrast: 0, sharp: 0, thr: 0 });
      await rebuild(p, q); await new Promise(r => setTimeout(r));
    }
    applyPageSize(); emit('all');
  } catch (e) { console.error(e); toast('Failed: ' + e.message, 'error'); } finally { busy(false); }
}

async function cropAll() {
  if (!S.pages.length) return;
  busy('Detecting edges…', 0);
  try {
    pushHist(); let k = 0;
    for (const p of S.pages) {
      if (!isImg(p)) continue;
      busy(`Page ${++k}/${S.pages.length}`, k / S.pages.length);
      const orig = S.sources.get(p.scan?.orig ?? p.src.sid);
      const q = p.scan?.params ? JSON.parse(JSON.stringify(p.scan.params)) : defParams(cfg().filter);
      q.quad = detectQuad(orig.img, q.rot || 0) || FULL.map(x => [...x]);
      await rebuild(p, q); await new Promise(r => setTimeout(r));
    }
    applyPageSize(); emit('all');
  } catch (e) { console.error(e); toast('Failed: ' + e.message, 'error'); } finally { busy(false); }
}

// ---------------------------------------------------------------- grid
function render() {
  const grid = $('#scGrid'); grid.innerHTML = '';
  const n = S.pages.length;
  $('#scCount').textContent = n ? `${n} page${n > 1 ? 's' : ''}` : '';
  $('#scEmpty').hidden = n > 0; $('#scUndo').disabled = !S.hist.length;
  for (const b of $('#scFilters').children) b.classList.toggle('on', b.dataset.f === cfg().filter);
  for (const id of ['scSavePdf', 'scShare', 'scSaveImg', 'scEditor', 'scCropAll']) $('#' + id).disabled = !n;
  S.pages.forEach((pg, i) => {
    const src = S.sources.get(pg.src?.sid);
    const rot = ((pg.rot % 360) + 360) % 360, swap = rot % 180;
    const img = h('img', { src: src?.url || '', alt: `Page ${i + 1}`, draggable: false });
    img.style.transform = `rotate(${rot}deg)` + (swap ? ' scale(.72)' : '');
    grid.append(h('div', { class: 'sc-card' + (i === S.cur ? ' cur' : '') },
      h('div', { class: 'sc-thumb', onclick: () => editPage(i) }, img, h('span', { class: 'sc-no' }, String(i + 1))),
      h('div', { class: 'sc-acts' },
        h('button', { title: 'Crop & colour', onclick: () => editPage(i), class: 'prim' }, 'Crop & colour'),
        h('button', { title: 'Rotate 90°', onclick: () => edit(() => { pg.rot = (pg.rot + 90) % 360; }) }, '⟳'),
        h('button', { title: 'Move earlier', disabled: i === 0, onclick: () => edit(() => { [S.pages[i - 1], S.pages[i]] = [S.pages[i], S.pages[i - 1]]; }) }, '◀'),
        h('button', { title: 'Move later', disabled: i === n - 1, onclick: () => edit(() => { [S.pages[i + 1], S.pages[i]] = [S.pages[i], S.pages[i + 1]]; }) }, '▶'),
        h('button', { title: 'Delete page', class: 'del', onclick: () => { edit(() => { S.pages.splice(i, 1); S.cur = Math.min(S.cur, S.pages.length - 1); }); } }, '🗑'))));
  });
}

// ---------------------------------------------------------------- saving
const QUAL = { high: null, bal: { dpi: 150, quality: 0.72 }, small: { dpi: 110, quality: 0.5 } };
async function savePdf(share = false) {
  if (!S.pages.length) return;
  const name = (PROJ.name || 'scan').replace(/[\\/:*?"<>|]+/g, '_'), c = cfg();
  let engine = null; busy('Preparing…', 0);
  try {
    const idxs = S.pages.map((_, i) => i);
    let ocr = null;
    if (c.ocr) {
      busy('Loading OCR engine… (first time needs internet)');
      engine = await createOcr('eng+hin', (s, p) => busy('OCR: ' + s, typeof p === 'number' ? p : undefined));
      ocr = (cv, k) => { busy(`OCR page ${k + 1}/${idxs.length}…`, k / idxs.length); return engine.recognize(cv, name); };
    }
    const bytes = await buildPdf({ pages: idxs, raster: ocr ? null : QUAL[c.quality], ocr, progress: (m, f) => busy(m, f) });
    if (share) { busy(false); await offerShare(bytes, name + '.pdf'); return; }
    download(bytes, name + '.pdf');
    toast(`Saved ${name}.pdf — ${(bytes.length / 1024).toFixed(bytes.length < 1e6 ? 0 : 0)} KB`, 'ok', 5000);
  } catch (e) { console.error(e); toast('Could not build the PDF: ' + (e?.message || e), 'error', 8000); } finally { engine?.close(); busy(false); }
}
async function saveImages() {
  if (!S.pages.length) return;
  const name = (PROJ.name || 'scan').replace(/[\\/:*?"<>|]+/g, '_');
  busy('Rendering…', 0);
  try {
    const out = await renderPagesToImages(S.pages.map((_, i) => i), { dpi: 150, fmt: 'jpg', quality: 0.9, progress: (m, f) => busy(m, f) });
    if (out.length === 1) download(out[0].bytes, `${name}.jpg`, 'image/jpeg');
    else download(await zipFiles(out.map(f => ({ name: `${name}_${String(f.index + 1).padStart(3, '0')}.jpg`, bytes: f.bytes }))), name + '_images.zip', 'application/zip');
  } catch (e) { toast('Failed: ' + e.message, 'error'); } finally { busy(false); }
}
