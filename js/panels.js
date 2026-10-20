// Right-hand panel: tools & properties, page operations, stamps, scan, export.
import { S, edit, pushHist, emit, subscribe, uid, newPage, parseRanges, curPage, addAsset, fmtBytes } from './state.js';
import { V, STAMPS, setTool, selectedItem, setProp, setFillOn, deleteSelected, duplicateSelected, arrange, editTextItem, signatureDialog, insertImageFile, goto } from './viewer.js';
import { BASE_FONTS, userFonts } from './prims.js';
import { buildPdf, buildToSize, renderPagesToImages, extractTextOf, download, zipFiles } from './export.js';
import { openScanEditor, autoScanAll } from './scan.js';
import { createOcr } from './ocr.js';
import { removePages } from './thumbs.js';
import { addFontFile, removeFont } from './fonts.js';
import { $, $$, h, toast, busy, modal, confirmBox, baseName } from './ui.js';

const POS = [['top-left', 'Top left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['middle-center', 'Centre'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right']];
export const HINTS = {
  select: 'Click an item to select it. Drag to move, drag a corner to resize, double-click text to edit, Delete to remove.',
  text: 'Click on the page where the text should go. Hindi and English both work.',
  edittext: 'Click a line of existing text to replace it. The original is covered with the page colour — for confidential data use Redact instead.',
  form: 'Type into the highlighted fields (Hindi works too). Your entries are written onto the page when you save.',
  hl: 'Drag over text to highlight it.', rect: 'Drag to draw a rectangle (Shift = square).', ellipse: 'Drag to draw an ellipse (Shift = circle).',
  line: 'Drag to draw a line (Shift = straight angles).', arrow: 'Drag to draw an arrow.', pen: 'Draw freehand with mouse, finger or stylus.',
  white: 'Drag over anything to cover it with white.', redact: 'Drag over sensitive text. When you save, that page is flattened so the covered text is permanently removed.',
  sign: 'Click where the signature should go. You can move and resize it afterwards.', stamp: 'Choose a stamp below, then click on the page.', crop: 'Drag the area to keep. It is applied when you save (Pages tab → Clear crop to undo).',
};
const TOOL_PROPS = {
  select: [], text: ['text'], edittext: ['text'], hl: ['hl'], rect: ['stroke', 'fill', 'opacity'], ellipse: ['stroke', 'fill', 'opacity'],
  line: ['stroke', 'opacity'], arrow: ['stroke', 'opacity'], pen: ['stroke', 'opacity'], sign: ['sign'], stamp: ['stamp'], white: [], redact: [], crop: [], form: [],
};
const ITEM_PROPS = { text: ['text', 'opacity'], rect: ['stroke', 'fill', 'opacity'], ellipse: ['stroke', 'fill', 'opacity'], line: ['stroke', 'opacity'], pen: ['stroke', 'opacity'], hl: ['hl'], img: ['opacity'], white: [], redact: [] };

const ids = () => S.pages.filter(p => S.sel.has(p.id)).map(p => p.id);
const targets = () => { const a = ids(); return a.length ? a : (curPage() ? [curPage().id] : []); };
const idxOf = idl => idl.map(id => S.pages.findIndex(p => p.id === id)).filter(i => i >= 0).sort((a, b) => a - b);
let stampAt = 0;

export function initPanels() {
  // ---------------------------------------------------------------- tabs
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

  // ---------------------------------------------------------------- tools palette
  $('#tools').addEventListener('click', e => { const b = e.target.closest('button[data-tool]'); if (b) setTool(b.dataset.tool); });
  V.onTool = () => { updateTools(); updateProps(); };
  V.onSelect = () => updateProps();
  $('#btnInsertImg').onclick = () => $('#imgIn').click();
  $('#imgIn').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (S.pages.length === 0) return;
    if (f.type.startsWith('image/')) await insertImageFile(f);
  });
  // property controls
  const P = V.props;
  $('#pColor').addEventListener('input', e => setProp('color', e.target.value));
  $('#pSw').addEventListener('input', e => setProp('sw', +e.target.value));
  $('#pFillOn').addEventListener('change', e => setFillOn(e.target.checked));
  $('#pFill').addEventListener('input', e => { P.fillColor = e.target.value; const it = selectedItem(); if (it && (it.t === 'rect' || it.t === 'ellipse')) { setProp('fillColor', e.target.value); if (!P.fillOn) { P.fillOn = true; $('#pFillOn').checked = true; it.fill = e.target.value; emit('items'); } } else if (!it) { P.fillOn = true; $('#pFillOn').checked = true; } });
  $('#pHl').addEventListener('input', e => setProp('hlColor', e.target.value));
  const sw = $('#hlSwatches');
  for (const c of ['#ffe600', '#7CFC00', '#ff9ecb', '#7fd4ff', '#ffb347']) sw.append(h('i', { style: { background: c }, title: c, onclick: () => { setProp('hlColor', c); $('#pHl').value = c; } }));
  $('#pFont').addEventListener('change', e => setProp('font', e.target.value));
  $('#pSize').addEventListener('input', e => setProp('size', Math.max(4, +e.target.value || 12)));
  $('#pTextColor').addEventListener('input', e => setProp('textColor', e.target.value));
  $('#pBold').addEventListener('change', e => setProp('bold', e.target.checked));
  $('#pItalic').addEventListener('change', e => setProp('italic', e.target.checked));
  $('#pOpacity').addEventListener('input', e => setProp('opacity', +e.target.value));
  for (const [k, v] of Object.entries(STAMPS)) $('#pStamp').append(h('option', { value: k }, k === 'custom' ? 'Custom text…' : (v.text === '{date}' ? "Today's date" : v.text)));
  $('#pStamp').addEventListener('change', e => { P.stamp = e.target.value; $('#pStampText').style.display = P.stamp === 'custom' ? '' : 'none'; });
  $('#pStampText').addEventListener('input', e => { P.stampText = e.target.value; });
  $('#btnSig').onclick = async () => { await signatureDialog(); };
  $('#btnDel').onclick = deleteSelected; $('#btnDup').onclick = duplicateSelected;
  $('#btnFront').onclick = () => arrange('front'); $('#btnBack').onclick = () => arrange('back');
  $('#btnEditText').onclick = () => { const it = selectedItem(); if (it) editTextItem(it); };
  $('#btnAddFont').onclick = () => $('#fontIn').click();
  fillFontSelect();

  // ---------------------------------------------------------------- pages pane
  const selectIdx = fn => { S.sel = new Set(S.pages.filter((p, i) => fn(i)).map(p => p.id)); emit('sel'); };
  $('#btnSelAll').onclick = () => selectIdx(() => true); $('#btnSelNone').onclick = () => selectIdx(() => false);
  $('#btnSelOdd').onclick = () => selectIdx(i => i % 2 === 0); $('#btnSelEven').onclick = () => selectIdx(i => i % 2 === 1);
  $('#btnSelRange').onclick = () => { const r = new Set(parseRanges($('#selRange').value, S.pages.length)); selectIdx(i => r.has(i)); };
  $('#btnRotL').onclick = () => rotate(-90); $('#btnRotR').onclick = () => rotate(90);
  $('#btnDelPage').onclick = async () => {
    const t = targets();
    if (t.length >= S.pages.length && !(await confirmBox('Delete all pages?', 'This removes every page from the workspace (you can still undo).', 'Delete'))) return;
    removePages(t);
  };
  $('#btnMoveUp').onclick = () => shift(-1); $('#btnMoveDown').onclick = () => shift(1);
  $('#btnDupPage').onclick = duplicatePages; $('#btnBlank').onclick = insertBlank; $('#btnReverse').onclick = reversePages;
  $('#btnExtract').onclick = () => savePdf({ pages: idxOf(ids().length ? ids() : targets()), suffix: '-extract' });
  $('#btnSplit').onclick = splitPdf;
  $('#splitMode').addEventListener('change', e => { const m = e.target.value; $('#splitVal').style.display = m === 'each' || m === 'sel' ? 'none' : ''; $('#splitVal').placeholder = m === 'every' ? 'pages per file, e.g. 2' : '1-3, 4-6, 7-'; });
  $('#btnCropAll').onclick = () => {
    const c = curPage(); if (!c?.crop) { toast('Draw a crop on this page first (Edit tab → Crop).', 'warn'); return; }
    edit(() => { for (const p of S.pages) { const sx = p.w / c.w, sy = p.h / c.h; p.crop = { x: c.crop.x * sx, y: c.crop.y * sy, w: c.crop.w * sx, h: c.crop.h * sy }; } });
    toast('Crop copied to all pages.', 'ok');
  };
  $('#btnCropClear').onclick = () => edit(() => { for (const id of targets()) { const p = S.pages.find(x => x.id === id); if (p) p.crop = null; } });

  // ---------------------------------------------------------------- stamp pane
  initStampPane();

  // ---------------------------------------------------------------- scan pane
  $('#btnCamera').onclick = () => $('#camIn').click();
  $('#btnAddImgs').onclick = () => $('#fileIn').click();
  $('#btnScanEdit').onclick = () => openScanEditor(S.cur);
  $('#btnScanAuto').onclick = async () => {
    busy('Enhancing…', 0);
    try { const n = await autoScanAll($('#scanFilter').value, (m, f) => busy(m, f)); toast(n ? `Enhanced ${n} page(s).` : 'No image pages to enhance.', n ? 'ok' : 'warn'); }
    catch (e) { console.error(e); toast('Enhance failed: ' + e.message, 'error'); } finally { busy(false); }
  };

  // ---------------------------------------------------------------- export pane
  $$('input[name=size]').forEach(r => r.addEventListener('change', () => { $('#targetBox').hidden = $('input[name=size]:checked').value !== 'target'; }));
  $('#exTarget').addEventListener('change', e => { $('#exCustomWrap').hidden = e.target.value !== 'custom'; });
  $('#btnSavePdf').onclick = () => savePdf();
  $('#btnSaveImg').onclick = saveImages; $('#btnSaveTxt').onclick = saveText;
  const md = { mdTitle: 'title', mdAuthor: 'author', mdSubject: 'subject', mdKeywords: 'keywords' };
  for (const [id, k] of Object.entries(md)) $('#' + id).addEventListener('input', e => { S.meta[k] = e.target.value; });
  $('#mdStrip').addEventListener('change', e => { S.meta.strip = e.target.checked; });

  subscribe(w => { updateTools(); updateProps(); if (w === 'all') syncStampInputs(); updateExInfo(); });
  updateTools(); updateProps(); syncStampInputs();
}

export function setTab(name) {
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of $$('.pane')) p.hidden = p.dataset.pane !== name;
  updateExInfo();
}

// ------------------------------------------------------------------ tool / props UI
function updateTools() {
  for (const b of $$('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === V.tool);
  $('#toolHint').textContent = HINTS[V.tool] || '';
  $('#toolBadge').textContent = V.tool === 'select' ? '' : ({ edittext: 'Edit text', hl: 'Highlight', pen: 'Draw', white: 'Whiteout' }[V.tool] || V.tool[0].toUpperCase() + V.tool.slice(1));
}
function fillFontSelect() {
  const sel = $('#pFont'); sel.innerHTML = '';
  for (const [v, l] of BASE_FONTS) sel.append(h('option', { value: v }, l.replace(/\s+\(.*$/, '').replace(/\s{2,}.*$/, '')));
  for (const f of userFonts) sel.append(h('option', { value: f }, f));
  sel.value = V.props.font;
  const list = $('#fontList'); list.innerHTML = '';
  for (const f of userFonts) list.append(h('span', {}, f + ' ', h('button', { class: 'link', title: 'Remove', onclick: async () => { await removeFont(f); fillFontSelect(); } }, '×')));
}
export { fillFontSelect };

function updateProps() {
  const it = selectedItem();
  const show = new Set(it && V.tool === 'select' ? [...(ITEM_PROPS[it.t] || []), 'item'] : (TOOL_PROPS[V.tool] || []));
  for (const g of $$('.pg[data-for]')) g.hidden = !show.has(g.dataset.for);
  $('#btnEditText').hidden = !(it && it.t === 'text');
  const P = V.props;
  const src = it && V.tool === 'select' ? it : null;
  const val = (itemKey, propKey) => (src && src[itemKey] !== undefined ? src[itemKey] : P[propKey]);
  const set = (id, v, chk) => { const el = $('#' + id); if (!el || document.activeElement === el) return; chk ? (el.checked = !!v) : (el.value = v); };
  set('pColor', src ? (src.stroke || P.color) : P.color);
  set('pSw', val('sw', 'sw'));
  set('pFillOn', src && (src.t === 'rect' || src.t === 'ellipse') ? !!src.fill : P.fillOn, true);
  set('pFill', src && src.fill && src.t !== 'hl' ? src.fill : P.fillColor);
  set('pHl', src && src.t === 'hl' ? src.fill : P.hlColor);
  set('pFont', src && src.t === 'text' ? (src.font || 'auto') : P.font);
  set('pSize', src && src.t === 'text' ? src.size : P.size);
  set('pTextColor', src && src.t === 'text' ? src.color : P.textColor);
  set('pBold', src && src.t === 'text' ? src.bold : P.bold, true);
  set('pItalic', src && src.t === 'text' ? src.italic : P.italic, true);
  set('pOpacity', val('opacity', 'opacity'));
  set('pStamp', P.stamp);
  $('#pStampText').style.display = P.stamp === 'custom' ? '' : 'none';
}

// ------------------------------------------------------------------ page operations
function rotate(d) {
  edit(() => { for (const id of targets()) { const p = S.pages.find(x => x.id === id); if (p) p.rot = (((p.rot + d) % 360) + 360) % 360; } });
}
function shift(dir) {
  const sel = new Set(targets());
  edit(() => {
    const a = S.pages, curId = a[S.cur]?.id;
    if (dir < 0) { for (let i = 1; i < a.length; i++) if (sel.has(a[i].id) && !sel.has(a[i - 1].id)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
    else { for (let i = a.length - 2; i >= 0; i--) if (sel.has(a[i].id) && !sel.has(a[i + 1].id)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
    S.cur = Math.max(0, a.findIndex(p => p.id === curId));
  });
}
function duplicatePages() {
  const sel = new Set(targets());
  edit(() => {
    const out = [];
    for (const p of S.pages) {
      out.push(p);
      if (sel.has(p.id)) { const c = JSON.parse(JSON.stringify(p)); c.id = uid(); c.items.forEach(i => { i.id = uid(); }); out.push(c); }
    }
    S.pages = out;
  });
}
function insertBlank() {
  const c = curPage(); if (!c) return;
  edit(() => {
    const d = c.rot % 180 ? { w: c.h, h: c.w } : { w: c.w, h: c.h };
    const p = newPage({ src: null, w: d.w, h: d.h });
    S.pages.splice(S.cur + 1, 0, p); S.cur += 1; S.sel = new Set([p.id]);
  });
}
function reversePages() {
  const sel = idxOf(ids());
  edit(() => {
    if (sel.length >= 2) { const items = sel.map(i => S.pages[i]).reverse(); sel.forEach((i, k) => { S.pages[i] = items[k]; }); }
    else S.pages.reverse();
    S.cur = Math.min(S.cur, S.pages.length - 1);
  });
}

async function splitPdf() {
  const N = S.pages.length, mode = $('#splitMode').value, val = $('#splitVal').value.trim();
  let groups = [];
  if (mode === 'ranges') groups = val.split(',').map(g => parseRanges(g, N)).filter(g => g.length);
  else if (mode === 'every') { const n = Math.max(1, parseInt(val || '1', 10) || 1); for (let i = 0; i < N; i += n) groups.push([...Array(Math.min(n, N - i)).keys()].map(k => i + k)); }
  else if (mode === 'each') groups = [...Array(N).keys()].map(i => [i]);
  else { const s = idxOf(ids()), rest = [...Array(N).keys()].filter(i => !s.includes(i)); groups = [s, rest].filter(g => g.length); }
  if (!groups.length) { toast('Nothing to split — check the page ranges.', 'warn'); return; }
  const base = baseName($('#exName').value || 'document');
  const o = readExport();
  busy('Splitting…', 0);
  try {
    const files = [];
    for (let g = 0; g < groups.length; g++) {
      const gi = groups[g];
      const bytes = await buildPdf({ pages: gi, protect: o.protect, progress: (m, f) => busy(`File ${g + 1}/${groups.length}: ${m}`, (g + f) / groups.length) });
      files.push({ name: `${base}_part${String(g + 1).padStart(2, '0')}_p${gi[0] + 1}${gi.length > 1 ? '-' + (gi[gi.length - 1] + 1) : ''}.pdf`, bytes });
    }
    if (files.length === 1) download(files[0].bytes, files[0].name);
    else download(await zipFiles(files), base + '_split.zip', 'application/zip');
    toast(`Created ${files.length} file${files.length > 1 ? 's' : ''}.`, 'ok');
  } catch (e) { console.error(e); toast('Split failed: ' + e.message, 'error'); } finally { busy(false); }
}

// ------------------------------------------------------------------ stamp pane
function initStampPane() {
  for (const id of ['wmPos', 'nmPos', 'hdPos', 'ftPos']) {
    const sel = $('#' + id);
    for (const [v, l] of POS) { if (v === 'middle-center' && id !== 'wmPos') continue; if (id === 'hdPos' && v.startsWith('bottom')) continue; if (id === 'ftPos' && v.startsWith('top')) continue; sel.append(h('option', { value: v }, l)); }
  }
  const set = (obj, key, val) => { if (Date.now() - stampAt > 900) pushHist(); stampAt = Date.now(); obj[key] = val; emit('items'); };
  const num = (id, grp, key, def) => $('#' + id).addEventListener('input', e => { const v = parseFloat(e.target.value); set(S.stamps[grp], key, isNaN(v) ? def : v); });
  const txt = (id, grp, key) => $('#' + id).addEventListener('input', e => set(S.stamps[grp], key, e.target.value));
  const chk = (id, grp, key) => $('#' + id).addEventListener('change', e => set(S.stamps[grp], key, e.target.checked));
  chk('wmOn', 'watermark', 'on'); txt('wmText', 'watermark', 'text'); num('wmSize', 'watermark', 'size', 64); txt('wmColor', 'watermark', 'color'); num('wmOpacity', 'watermark', 'opacity', 0.2);
  num('wmAngle', 'watermark', 'angle', 0); txt('wmPos', 'watermark', 'pos'); chk('wmTile', 'watermark', 'tile'); txt('wmRange', 'watermark', 'range'); num('wmScale', 'watermark', 'scale', 50);
  $('#wmKind').addEventListener('change', e => { set(S.stamps.watermark, 'kind', e.target.value); syncStampInputs(); });
  $('#wmImgBtn').onclick = () => $('#wmImgIn').click();
  $('#wmImgIn').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    const img = new Image(); img.src = url; await img.decode();
    pushHist(); S.stamps.watermark.aid = addAsset(url, img.naturalWidth, img.naturalHeight); S.stamps.watermark.kind = 'image'; S.stamps.watermark.on = true; emit('all');
  });
  chk('nmOn', 'numbers', 'on'); txt('nmFmt', 'numbers', 'fmt'); txt('nmPos', 'numbers', 'pos'); num('nmSize', 'numbers', 'size', 10); num('nmStart', 'numbers', 'start', 1); txt('nmRange', 'numbers', 'range'); chk('nmDev', 'numbers', 'devnum');
  chk('hdOn', 'header', 'on'); txt('hdText', 'header', 'text'); txt('hdPos', 'header', 'pos'); num('hdSize', 'header', 'size', 10);
  chk('ftOn', 'footer', 'on'); txt('ftText', 'footer', 'text'); txt('ftPos', 'footer', 'pos'); num('ftSize', 'footer', 'size', 10);
  // turning on an empty/placeholder section when the user types
  for (const [id, grp] of [['wmText', 'watermark'], ['hdText', 'header'], ['ftText', 'footer']]) $('#' + id).addEventListener('input', () => { if (!S.stamps[grp].on) { S.stamps[grp].on = true; syncStampInputs(); } });
}
function syncStampInputs() {
  const s = S.stamps, v = (id, val, chk) => { const el = $('#' + id); if (!el || document.activeElement === el) return; chk ? (el.checked = !!val) : (el.value = val ?? ''); };
  const w = s.watermark; v('wmOn', w.on, 1); v('wmKind', w.kind); v('wmText', w.text); v('wmSize', w.size); v('wmColor', w.color); v('wmOpacity', w.opacity); v('wmAngle', w.angle); v('wmPos', w.pos); v('wmTile', w.tile, 1); v('wmRange', w.range); v('wmScale', w.scale);
  $('#wmTextWrap').hidden = $('#wmSizeWrap').hidden = w.kind !== 'text'; $('#wmImgBtn').hidden = $('#wmScaleWrap').hidden = w.kind !== 'image';
  const n = s.numbers; v('nmOn', n.on, 1); v('nmFmt', n.fmt); v('nmPos', n.pos); v('nmSize', n.size); v('nmStart', n.start); v('nmRange', n.range); v('nmDev', n.devnum, 1);
  v('hdOn', s.header.on, 1); v('hdText', s.header.text); v('hdPos', s.header.pos); v('hdSize', s.header.size);
  v('ftOn', s.footer.on, 1); v('ftText', s.footer.text); v('ftPos', s.footer.pos); v('ftSize', s.footer.size);
  v('mdTitle', S.meta.title); v('mdAuthor', S.meta.author); v('mdSubject', S.meta.subject); v('mdKeywords', S.meta.keywords); v('mdStrip', S.meta.strip, 1);
}
export { syncStampInputs };

// ------------------------------------------------------------------ export
export function readExport() {
  const which = $('input[name=which]:checked').value;
  let pages;
  if (which === 'sel') pages = idxOf(ids()); else if (which === 'range') pages = parseRanges($('#exRange').value, S.pages.length); else pages = [...Array(S.pages.length).keys()];
  const sizeMode = $('input[name=size]:checked').value;
  let target = null;
  if (sizeMode === 'target') { const t = $('#exTarget').value; target = t === 'custom' ? Math.max(10, +$('#exCustom').value || 150) : +t; }
  const pw = $('#exPw').value, owner = $('#exOwner').value;
  const perms = { print: $('#exPrint').checked, copy: $('#exCopy').checked, modify: $('#exModify').checked, annotate: $('#exAnnot').checked, fill: $('#exAnnot').checked, assemble: $('#exModify').checked };
  const restricted = Object.values(perms).some(x => !x);
  const protect = pw || owner || restricted ? { user: pw, owner, perms } : null;
  return { pages, target, gray: $('#exGray').checked, bw: $('#exBW').checked, protect, ocr: $('#exOcr').checked, lang: $('#exOcrLang').value, name: ($('#exName').value || 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_') };
}
function updateExInfo() {
  const el = $('#exInfo'); if (!el) return;
  const o = readExport();
  el.textContent = S.pages.length ? `${o.pages.length} of ${S.pages.length} page${S.pages.length > 1 ? 's' : ''} will be saved.` : '';
}

export async function savePdf(extra = {}) {
  if (!S.pages.length) { toast('Add a PDF or image first.', 'warn'); return; }
  const o = readExport();
  const idxs = extra.pages ?? o.pages;
  if (!idxs.length) { toast('No pages selected to save.', 'warn'); return; }
  const name = o.name + (extra.suffix || '');
  busy('Preparing…', 0);
  let engine = null;
  try {
    let bytes, note = '';
    const common = { pages: idxs, protect: o.protect, progress: (m, f) => busy(m, f) };
    let ocr = null;
    if (o.ocr) {
      busy('Loading OCR engine… (first time needs internet)');
      engine = await createOcr(o.lang, (s, p) => busy('OCR: ' + s, typeof p === 'number' ? p : undefined));
      ocr = (cv, k) => { busy(`OCR page ${k + 1}/${idxs.length}…`, k / idxs.length); return engine.recognize(cv, name); };
      if (o.target) toast('OCR output is not size-compressed; saving at 200 dpi.', 'warn');
    }
    if (o.target && !ocr) {
      const r = await buildToSize(o.target * 1024, { ...common, gray: o.gray, bw: o.bw });
      bytes = r.bytes; note = r.ok ? '' : ' — could not reach the target; this is the smallest possible';
    } else bytes = await buildPdf({ ...common, ocr, raster: !ocr && (o.gray || o.bw) ? { dpi: 200, quality: 0.9, gray: o.gray, bw: o.bw } : null });
    download(bytes, name + '.pdf');
    toast(`Saved ${name}.pdf — ${fmtBytes(bytes.length)}${note}${o.protect ? ' · password protected' : ''}`, note ? 'warn' : 'ok', 6000);
    return bytes;
  } catch (e) {
    console.error(e);
    toast('Could not build the PDF: ' + (e?.message || e), 'error', 8000);
  } finally { engine?.close(); busy(false); }
}

async function saveImages() {
  if (!S.pages.length) return;
  const o = readExport(), fmt = $('#exImgFmt').value, dpi = +$('#exImgDpi').value;
  busy('Rendering…', 0);
  try {
    const out = await renderPagesToImages(o.pages, { dpi, fmt, progress: (m, f) => busy(m, f) });
    const ext = fmt === 'jpg' ? 'jpg' : 'png';
    if (out.length === 1) download(out[0].bytes, `${o.name}_page${out[0].index + 1}.${ext}`, 'image/' + (fmt === 'jpg' ? 'jpeg' : 'png'));
    else download(await zipFiles(out.map(f => ({ name: `${o.name}_page${String(f.index + 1).padStart(3, '0')}.${ext}`, bytes: f.bytes }))), o.name + '_images.zip', 'application/zip');
    toast(`Saved ${out.length} image${out.length > 1 ? 's' : ''}.`, 'ok');
  } catch (e) { console.error(e); toast('Failed: ' + e.message, 'error'); } finally { busy(false); }
}
async function saveText() {
  if (!S.pages.length) return;
  const o = readExport();
  busy('Extracting text…');
  try {
    const t = await extractTextOf(o.pages);
    if (!t.replace(/-----.*-----/g, '').trim()) toast('No selectable text found (scanned pages need OCR first).', 'warn');
    download(new Blob(['﻿' + t], { type: 'text/plain;charset=utf-8' }), o.name + '.txt', 'text/plain');
  } catch (e) { toast('Failed: ' + e.message, 'error'); } finally { busy(false); }
}
