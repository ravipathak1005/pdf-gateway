// PDF Gateway — bootstrap, home screen, file intake, shortcuts.
import { S, undo, redo, subscribe, clearAll, emit, curPage, uid } from './state.js';
import { loadFiles, hooks } from './pdfio.js';
import { initViewer, setTool, refresh, goto, zoomBy, setZoomMode, V, deleteSelected, duplicateSelected, nudge, selectedItem, insertImageFile } from './viewer.js';
import { initThumbs } from './thumbs.js';
import { initPanels, setTab, savePdf, fillFontSelect, syncStampInputs } from './panels.js';
import { initFonts, addFontFile } from './fonts.js';
import { initScanner, showScanner, addPhotos } from './scanner.js';
import { initProjects, newProject, openProject, flushSave, P as PROJ } from './projects.js';
import { initProjectsUI, refreshProjects } from './projects-ui.js';
import { $, $$, h, hydrateIcons, icon, toast, busy, modal, baseName } from './ui.js';

const VERSION = '1.1';
let view = 'home';
let pendingAct = null;
let freshNext = false;   // next picked files start a brand-new project (true when chosen from the home screen)

// ------------------------------------------------------------------ home tiles
const TILES = [
  ['Organize', [
    ['merge', 'merge', 'Merge PDFs', 'Combine PDFs and images into one file'],
    ['split', 'split', 'Split PDF', 'By page ranges, every N pages, or each page'],
    ['organize', 'grid', 'Organize pages', 'Reorder, rotate, delete, insert blank pages'],
    ['extract', 'copy', 'Extract pages', 'Pick pages and save them as a new PDF'],
    ['crop', 'crop', 'Crop pages', 'Trim margins of scanned pages'],
  ]],
  ['Edit & sign', [
    ['edit', 'pen', 'Edit & annotate', 'Text, shapes, highlight, draw, images'],
    ['edittext', 'edittext', 'Edit existing text', 'Click a line of text to replace it'],
    ['sign', 'sign', 'Sign PDF', 'Draw or upload your signature'],
    ['form', 'form', 'Fill form', 'Type into form fields — Hindi works too'],
    ['redact', 'redact', 'Redact', 'Permanently black out sensitive text'],
    ['watermark', 'drop', 'Watermark', 'Text or logo on every page'],
    ['numbers', 'hash', 'Page numbers & header', 'Numbering, headers and footers'],
  ]],
  ['Convert & scan', [
    ['img2pdf', 'images', 'Images → PDF', 'Turn photos into a single PDF'],
    ['scan', 'scan', 'Scan to PDF', 'Camera or photos → crop, straighten, enhance'],
    ['pdf2img', 'image', 'PDF → Images', 'PNG / JPG for every page (ZIP)'],
    ['pdf2txt', 'filetext', 'PDF → Text', 'Extract selectable text to .txt'],
    ['ocr', 'ocr', 'OCR — searchable PDF', 'Make scanned pages searchable (Hindi + English)'],
  ]],
  ['Optimize & protect', [
    ['compress', 'compress', 'Compress to a size', 'Get under 100 KB / 200 KB / 1 MB for portals'],
    ['protect', 'lock', 'Protect with password', 'AES encryption, printing/copy limits'],
    ['unlock', 'unlock', 'Unlock PDF', 'Open with password, save a copy without one'],
    ['meta', 'meta', 'Document properties', 'Title, author — or strip all metadata'],
  ]],
];
const ACTS = {
  merge: { tab: 'pages', hint: 'Add more PDFs or images with “Add files”, drag pages into order, then Save PDF.' },
  split: { tab: 'pages', hint: 'Choose how to split in the “Extract & split” section.' },
  organize: { tab: 'pages', hint: 'Drag thumbnails to reorder; use the buttons to rotate, delete or insert pages.' },
  extract: { tab: 'pages', hint: 'Tick the pages you want, then “Save selected pages as new PDF”.' },
  crop: { tab: 'edit', tool: 'crop' }, edit: { tab: 'edit', tool: 'select' }, edittext: { tab: 'edit', tool: 'edittext' },
  sign: { tab: 'edit', tool: 'sign' }, form: { tab: 'edit', tool: 'form' }, redact: { tab: 'edit', tool: 'redact' },
  watermark: { tab: 'stamp', open: '#wmOn' }, numbers: { tab: 'stamp', open: '#nmOn' },
  img2pdf: { tab: 'pages', accept: 'image', hint: 'Add images, drag them into order, then Save PDF.' },
  pdf2img: { tab: 'export', focus: '#btnSaveImg' }, pdf2txt: { tab: 'export', focus: '#btnSaveTxt' },
  ocr: { tab: 'export', open: '#exOcr', check: '#exOcr', hint: 'Tick “Make text searchable”, then Save PDF.' },
  compress: { tab: 'export', size: 'target', hint: 'Pick a target size, then Save PDF.' },
  protect: { tab: 'export', open: '#exPw', focus: '#exPw' },
  unlock: { tab: 'export', hint: 'The PDF opened with its password — Save PDF now gives a copy without one (leave the password fields empty).' },
  meta: { tab: 'export', open: '#mdTitle', focus: '#mdTitle' },
};

function buildTiles() {
  const root = $('#tiles');
  for (const [group, items] of TILES) {
    root.append(h('div', { class: 'tgroup' }, h('h2', {}, group), h('div', { class: 'tgrid' },
      items.map(([act, ic, title, desc]) => h('button', { class: 'tile', 'data-act': act, onclick: () => startAct(act) },
        h('span', { class: 'ti', html: icon(ic, 20) }), h('b', {}, title), h('small', {}, desc))))));
  }
}

function startAct(act) {
  if (act === 'scan') { newScan(); return; }
  const a = ACTS[act];
  pendingAct = act; freshNext = view === 'home';
  const fi = $('#fileIn'); fi.accept = a.accept === 'image' ? 'image/*' : '.pdf,application/pdf,image/*'; fi.click();
}
function applyAct(act) {
  const a = ACTS[act]; if (!a) return;
  showStudio();
  setTab(a.tab);
  if (a.tool) setTool(a.tool); else if (a.tab === 'edit') setTool('select');
  if (a.open) { const d = $(a.open)?.closest('details'); if (d) d.open = true; }
  if (a.check) { const c = $(a.check); if (c) c.checked = true; }
  if (a.size === 'target') { const r = $('input[name=size][value=target]'); r.checked = true; r.dispatchEvent(new Event('change')); }
  if (a.focus) setTimeout(() => $(a.focus)?.focus(), 50);
  if (a.hint) toast(a.hint, 'info', 6500);
}

// ------------------------------------------------------------------ views
function setView(v) {
  view = v;
  $('#home').hidden = v !== 'home'; $('#studio').hidden = v !== 'studio'; $('#scanner').hidden = v !== 'scanner';
  const ed = v === 'studio';
  $('#btnSave').hidden = !ed; $('#btnUndo').hidden = $('#btnRedo').hidden = !ed; $('#btnHome').hidden = v === 'home'; $('#btnAdd').hidden = !ed;
  document.querySelector('.top-actions .sep').hidden = !ed;
  window.scrollTo(0, 0);
}
async function showHome() { await flushSave(); setView('home'); refreshProjects(); }
function showStudio() {
  if (!S.pages.length) { showHome(); return; }
  setView('studio'); refresh(true);
}
async function newScan() {
  await newProject('scan'); setView('scanner'); showScanner();
}
async function openProj(id) {
  if (id === PROJ.id && S.pages.length) { PROJ.kind === 'scan' ? (setView('scanner'), showScanner()) : showStudio(); return; }
  busy('Opening project…');
  try {
    const kind = await openProject(id);
    if (kind === 'scan') { setView('scanner'); showScanner(); } else { showStudio(); setTab('edit'); }
  } catch (e) { console.error(e); toast('Could not open this project: ' + (e?.message || e), 'error', 7000); } finally { busy(false); }
}
const updateHomeHint = () => {};

// ------------------------------------------------------------------ file intake
async function intake(files, { fresh = false } = {}) {
  files = [...files].filter(f => f && f.size >= 0);
  if (!files.length) return;
  if (view === 'scanner') { await addPhotos(files); return; }
  busy('Opening files…');
  try {
    if (fresh) await newProject('edit');
    const before = S.pages.length;
    const { added, errors } = await loadFiles(files);
    if (errors.length) toast(errors.join('\n'), 'error', 8000);
    if (!added) return;
    if (!$('#exName').dataset.touched || fresh) { $('#exName').value = baseName(files[0].name) + (before ? '' : '-edited'); delete $('#exName').dataset.touched; }
    showStudio();
    if (pendingAct) { const a = pendingAct; pendingAct = null; applyAct(a); }
  } finally { busy(false); }
}

hooks.progress = m => busy(m);
hooks.askPassword = async (name, wrong) => {
  busy(false);
  const inp = h('input', { type: 'password', style: { width: '100%' }, autocomplete: 'off' });
  const r = await modal({
    title: 'Password required', body: h('div', {}, h('p', {}, `“${name}” is protected.${wrong ? ' That password was incorrect.' : ''}`), h('label', { class: 'field' }, 'Password', inp)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Open', value: true, primary: true }], cancelValue: false,
    onOpen: d => { inp.focus(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') d.querySelector('.primary').click(); }); },
  });
  busy('Opening…');
  return r ? inp.value : null;
};

// ------------------------------------------------------------------ shortcuts
const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
const TOOL_KEYS = { v: 'select', t: 'text', h: 'hl', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', p: 'pen', s: 'sign' };
function onKey(e) {
  if (view !== 'studio' || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); savePdf(); return; }
  if (typing(e)) return;
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedItem()) { e.preventDefault(); deleteSelected(); } return; }
  if (e.key === 'Escape') { S.selItem = null; setTool('select'); return; }
  if (e.key.startsWith('Arrow') && selectedItem()) { e.preventDefault(); const d = e.shiftKey ? 10 : 1; nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0); return; }
  if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !selectedItem())) { goto(S.cur + 1); return; }
  if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !selectedItem())) { goto(S.cur - 1); return; }
  if (e.key === '+' || e.key === '=') { zoomBy(1.15); return; }
  if (e.key === '-') { zoomBy(1 / 1.15); return; }
  if (!mod && TOOL_KEYS[e.key.toLowerCase()]) setTool(TOOL_KEYS[e.key.toLowerCase()]);
}

// ------------------------------------------------------------------ init
async function init() {
  hydrateIcons();
  $('#verLabel').textContent = 'v' + VERSION;
  if (location.protocol === 'file:') $('#fileBanner').hidden = false;
  buildTiles();
  initViewer(); initThumbs(); initPanels();
  initFonts().then(() => { fillFontSelect(); }).catch(() => {});

  // file inputs
  $('#fileIn').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; e.target.accept = '.pdf,application/pdf,image/*'; const fr = freshNext; freshNext = false; if (f.length) intake(f, { fresh: fr }); else pendingAct = null; });
  $('#fontIn').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const n = await addFontFile(f); fillFontSelect(); toast('Font added: ' + n + ' — saved in this browser.', 'ok'); } catch { toast('That file is not a usable font.', 'error'); } });
  $('#exName').addEventListener('input', () => { $('#exName').dataset.touched = 1; });
  const choose = () => { freshNext = view === 'home'; $('#fileIn').accept = '.pdf,application/pdf,image/*'; $('#fileIn').click(); };
  $('#btnChoose').onclick = e => { e.stopPropagation(); choose(); };
  $('#btnCamHome').onclick = e => { e.stopPropagation(); newScan(); };
  $('#dropZone').addEventListener('click', choose);
  $('#dropZone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  $('#btnAdd').onclick = choose; $('#btnAdd2').onclick = choose;
  $('#btnFontsHome').onclick = () => $('#fontIn').click();

  // drag & drop anywhere
  let depth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; $('#dropZone').classList.add('over'); } });
  window.addEventListener('dragleave', e => { if (e.dataTransfer?.types?.includes('Files') && --depth <= 0) { depth = 0; $('#dropZone').classList.remove('over'); } });
  window.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); depth = 0; $('#dropZone').classList.remove('over'); intake(e.dataTransfer.files, { fresh: view === 'home' }); } });
  // paste images
  window.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])]; if (f.length && !typing(e)) intake(f, { fresh: view === 'home' }); });

  // top bar
  $('#brandHome').onclick = e => { e.preventDefault(); showHome(); };
  $('#btnHome').onclick = showHome;
  $('#btnSave').onclick = () => savePdf();
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  // stage bar
  $('#pgPrev').onclick = () => goto(S.cur - 1); $('#pgNext').onclick = () => goto(S.cur + 1);
  $('#pageNum').addEventListener('change', e => goto((+e.target.value || 1) - 1));
  $('#zIn').onclick = () => zoomBy(1.2); $('#zOut').onclick = () => zoomBy(1 / 1.2);
  $('#zFitW').onclick = () => setZoomMode('width'); $('#zFitP').onclick = () => setZoomMode('page');

  document.addEventListener('keydown', onKey);

  subscribe(() => {
    $('#btnUndo').disabled = !S.hist.length; $('#btnRedo').disabled = !S.fut.length;
    if (!S.pages.length && view === 'studio') showHome();
  });
  await initProjects();
  initScanner({
    back: () => showHome(),
    toEditor: () => { PROJ.kind = 'edit'; showStudio(); setTab('edit'); },
  });
  initProjectsUI({ open: openProj, newScan });
  await showHome();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.PG = { S, V, intake, savePdf, setTab, setTool, showStudio, showHome, newScan, openProj, PROJ }; // handy for debugging/testing
}
init();
