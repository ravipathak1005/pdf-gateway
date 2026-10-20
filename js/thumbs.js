// Page thumbnail strip: lazy rendering, multi-select, drag & drop reordering.
import { S, edit, subscribe, emit } from './state.js';
import { renderComposite, dispSize } from './pdfio.js';
import { h, $, icon } from './ui.js';
import { goto } from './viewer.js';

const recs = new Map(); // page id -> {el, canvas, key, dirty, visible, id}
let root, io, active = 0;
const queue = [];
let anchor = 0;

export function initThumbs() {
  root = $('#thumbs');
  io = new IntersectionObserver(es => {
    for (const e of es) {
      const rec = e.target._rec; if (!rec) continue;
      rec.visible = e.isIntersecting;
      if (rec.visible && rec.dirty) enqueue(rec);
    }
  }, { root: $('#thumbsCol'), rootMargin: '300px' });
  subscribe(render);
}

const pageKey = p => [p.src?.sid, p.src?.idx, p.rot, p.w, p.h, p.crop ? JSON.stringify(p.crop) : '', JSON.stringify(p.items), JSON.stringify(S.stamps)].join('|');

function create(p) {
  const canvas = h('canvas', { width: 10, height: 14 });
  const num = h('span', { class: 'tnum' });
  const chk = h('input', { type: 'checkbox', 'aria-label': 'Select page' });
  const el = h('div', { class: 'thumb', draggable: 'true', 'data-id': p.id },
    h('label', { class: 'tchk' }, chk), canvas, num,
    h('div', { class: 'tact' },
      h('button', { class: 'icon xs', title: 'Rotate', html: icon('rotcw', 14), onclick: ev => { ev.stopPropagation(); edit(() => { const q = S.pages.find(x => x.id === p.id); q.rot = (q.rot + 90) % 360; }); } }),
      h('button', { class: 'icon xs', title: 'Delete page', html: icon('trash', 14), onclick: ev => { ev.stopPropagation(); removePages([p.id]); } })));
  const rec = { id: p.id, el, canvas, num, chk, key: '', dirty: true, visible: false };
  el._rec = rec;
  chk.addEventListener('click', ev => ev.stopPropagation());
  chk.addEventListener('change', () => { chk.checked ? S.sel.add(p.id) : S.sel.delete(p.id); emit('sel'); render(); });
  el.addEventListener('click', ev => {
    const i = S.pages.findIndex(x => x.id === p.id);
    if (ev.ctrlKey || ev.metaKey) { S.sel.has(p.id) ? S.sel.delete(p.id) : S.sel.add(p.id); anchor = i; render(); return; }
    if (ev.shiftKey) { const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]; S.sel = new Set(S.pages.slice(a, b + 1).map(x => x.id)); render(); return; }
    anchor = i; S.sel = new Set([p.id]); goto(i);
  });
  el.addEventListener('dragstart', ev => {
    const ids = S.sel.has(p.id) ? S.pages.filter(x => S.sel.has(x.id)).map(x => x.id) : [p.id];
    root._drag = ids; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'pages');
    requestAnimationFrame(() => ids.forEach(id => recs.get(id)?.el.classList.add('dragging')));
  });
  el.addEventListener('dragend', () => { root._drag = null; for (const r of recs.values()) r.el.classList.remove('dragging', 'drop-before', 'drop-after'); });
  el.addEventListener('dragover', ev => {
    if (!root._drag) return; ev.preventDefault();
    const r = el.getBoundingClientRect(), horiz = matchMedia('(max-width: 980px)').matches;
    const after = horiz ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
    for (const x of recs.values()) x.el.classList.remove('drop-before', 'drop-after');
    el.classList.add(after ? 'drop-after' : 'drop-before'); el._after = after;
  });
  el.addEventListener('drop', ev => {
    ev.preventDefault();
    const ids = root._drag; if (!ids || ids.includes(p.id)) return;
    const after = el._after;
    edit(() => {
      const curId = S.pages[S.cur]?.id;
      const moving = S.pages.filter(x => ids.includes(x.id)), rest = S.pages.filter(x => !ids.includes(x.id));
      let at = rest.findIndex(x => x.id === p.id) + (after ? 1 : 0);
      rest.splice(at, 0, ...moving); S.pages = rest;
      S.cur = Math.max(0, S.pages.findIndex(x => x.id === curId));
    });
  });
  io.observe(el);
  return rec;
}

export function removePages(ids) {
  if (!ids.length) return;
  edit(() => {
    const curId = S.pages[S.cur]?.id;
    S.pages = S.pages.filter(p => !ids.includes(p.id));
    for (const id of ids) S.sel.delete(id);
    const ni = S.pages.findIndex(p => p.id === curId);
    S.cur = ni >= 0 ? ni : Math.min(S.cur, Math.max(0, S.pages.length - 1));
    if (S.pages.length && !S.sel.size) S.sel.add(S.pages[S.cur].id);
    S.selItem = null;
  });
}

function render() {
  if (!root) return;
  const ids = new Set(S.pages.map(p => p.id));
  for (const [id, rec] of recs) if (!ids.has(id)) { io.unobserve(rec.el); rec.el.remove(); recs.delete(id); }
  S.pages.forEach((p, i) => {
    let rec = recs.get(p.id) || (recs.set(p.id, create(p)), recs.get(p.id));
    if (root.children[i] !== rec.el) root.insertBefore(rec.el, root.children[i] || null);
    rec.el.classList.toggle('active', i === S.cur);
    rec.el.classList.toggle('selected', S.sel.has(p.id));
    rec.chk.checked = S.sel.has(p.id);
    rec.num.textContent = i + 1;
    const key = pageKey(p);
    if (key !== rec.key) { rec.key = key; rec.dirty = true; if (rec.visible) enqueue(rec); }
  });
  const cur = recs.get(S.pages[S.cur]?.id);
  if (cur && !cur._scrolled) cur.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  $('#pageCount').textContent = `${S.pages.length} page${S.pages.length === 1 ? '' : 's'} · ${S.sel.size} selected`;
}

function enqueue(rec) { if (!queue.includes(rec)) queue.push(rec); pump(); }
async function pump() {
  while (active < 2 && queue.length) {
    const rec = queue.shift();
    if (!rec.dirty || !recs.has(rec.id)) continue;
    active++;
    drawThumb(rec).catch(e => console.warn('thumb', e)).finally(() => { active--; pump(); });
  }
}
async function drawThumb(rec) {
  const idx = S.pages.findIndex(p => p.id === rec.id); if (idx < 0) return;
  const p = S.pages[idx], key = rec.key; rec.dirty = false;
  const d = dispSize(p), dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = await renderComposite(p, idx, S.pages.length, (132 * dpr) / d.w);
  if (!recs.has(rec.id)) return;
  rec.canvas.width = cv.width; rec.canvas.height = cv.height;
  rec.canvas.getContext('2d').drawImage(cv, 0, 0);
  rec.canvas.style.aspectRatio = `${cv.width} / ${cv.height}`;
  if (rec.key !== key) { rec.dirty = true; enqueue(rec); }
}
