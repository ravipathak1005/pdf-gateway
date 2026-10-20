// Small UI helpers: DOM, icons, toasts, dialogs, busy overlay, persistent storage.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

// ---------------------------------------------------------------- icons (24px, stroke)
const P = {
  plus: 'M12 5v14M5 12h14', undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3', redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14', open: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  cursor: 'M5 3l14 7-6 2-2 6z', text: 'M5 6V4h14v2M12 4v16M9 20h6', edittext: 'M4 5h12M10 5v10M7 15h6M19 11v9M17 20h4',
  highlight: 'M4 20l4-1 10-10-3-3L5 16zM13 6l3 3', rect: 'M4 6h16v12H4z', ellipse: 'M12 5c4.4 0 8 3 8 6.5S16.4 18 12 18s-8-3-8-6.5S7.6 5 12 5z',
  line: 'M5 19L19 5', arrow: 'M5 19L19 5M10 5h9v9', pen: 'M4 19c2-7 5 1 8-5s4-5 8-9', white: 'M7 20h10M5 14l8-8 6 6-6 6H9z',
  redact: 'M3 8h18v8H3zM6 12h8', image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01', sign: 'M4 16c3-7 5-7 6-3s3 1 5-3M4 20h16',
  stamp: 'M8 20h8M12 14v6M7 14h10a2 2 0 002-2 5 5 0 00-4-5 3 3 0 10-4 0 5 5 0 00-4 5 2 2 0 002 2z', check: 'M5 12l5 5 9-10',
  crop: 'M6 2v14h14M2 6h14v14', rotcw: 'M20 12a8 8 0 11-3-6.2M20 4v4h-4', rotccw: 'M4 12a8 8 0 103-6.2M4 4v4h4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6', copy: 'M8 8h11v12H8zM5 16V4h11', blank: 'M6 3h9l4 4v14H6zM15 3v4h4',
  split: 'M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4', merge: 'M4 4v5a4 4 0 004 4h8a4 4 0 004-4V4M12 13v8M9 18l3 3 3-3',
  compress: 'M12 3v7m0 0l-3-3m3 3l3-3M12 21v-7m0 0l-3 3m3-3l3 3M4 12h16', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 017-2.5', scan: 'M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16',
  ocr: 'M4 7V5h4M16 5h4v2M20 17v2h-4M8 19H4v-2M8 9h8M8 12h8M8 15h5', form: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h4',
  drop: 'M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z', hash: 'M9 4L7 20M17 4l-2 16M4 9h16M3 15h16', info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8h.01M11 12h1v5h1',
  zin: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6M11 8v6', zout: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6',
  left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7', close: 'M6 6l12 12M18 6L6 18', camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 100 7 3.5 3.5 0 000-7z',
  filetext: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3', images: 'M3 7h14v12H3zM7 7V5h14v12h-2', grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  share: 'M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.6 10.5l6.8-3.9M8.6 13.5l6.8 3.9',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', wand: 'M5 19L16 8M15 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3L21 14l-1.3.7L19 16l-.7-1.3L17 14l1.3-.7z',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', up: 'M12 19V5M6 11l6-6 6 6', down: 'M12 5v14M6 13l6 6 6-6', font: 'M4 20l6-15 6 15M6.5 14h7M18 7v6M15 10h6',
  meta: 'M5 4h14v16H5zM8 8h8M8 12h5M8 16h3', reverse: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4', zip: 'M6 3h9l4 4v14H6zM11 3v6M11 12h2M11 15h2M11 18h2',
};
export function icon(name, size = 18) {
  const d = P[name] || P.info;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
/** Replace <i data-ic="name"> placeholders with SVGs. */
export function hydrateIcons(root = document) {
  for (const el of $$('[data-ic]', root)) { el.insertAdjacentHTML('afterbegin', icon(el.dataset.ic, +el.dataset.size || 18)); el.removeAttribute('data-ic'); }
}

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = 'info', ms = 4200) {
  const box = $('#toasts');
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------------------------------------------------------------- busy overlay
let busyEl;
export function busy(msg, frac) {
  busyEl ||= $('#busy');
  if (msg === false) { busyEl.hidden = true; return; }
  busyEl.hidden = false;
  $('#busyMsg').textContent = msg || 'Working…';
  const bar = $('#busyBar');
  if (typeof frac === 'number') { bar.style.width = Math.round(frac * 100) + '%'; bar.parentElement.classList.remove('indeterminate'); }
  else bar.parentElement.classList.add('indeterminate');
}

// ---------------------------------------------------------------- dialogs
/**
 * Show a modal. body: Node. buttons: [{label, value, primary, danger}]. Returns clicked value or null.
 * opts.onOpen(dialogEl) is called after insertion; opts.validate(value) may veto close.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width = 480, onOpen, validate, cancelValue = null }) {
  return new Promise(resolve => {
    const dlg = h('dialog', { class: 'modal' });
    dlg.style.width = `min(${width}px, 96vw)`;
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(
      h('div', { class: 'modal-head' }, h('h2', {}, title || ''), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => done(cancelValue), html: icon('close') })),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, buttons.map(b => h('button', {
        class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: async () => {
          if (validate && b.value !== cancelValue && !(await validate(b.value))) return;
          done(b.value);
        },
      }, b.label))),
    );
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(cancelValue); });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg, done);
  });
}
export const confirmBox = (title, text, ok = 'OK') => modal({ title, body: h('p', {}, text), buttons: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true }], cancelValue: false });
export async function promptBox(title, label, value = '', type = 'text') {
  const inp = h('input', { type, value, style: { width: '100%' }, autocomplete: 'off' });
  const r = await modal({
    title, body: h('label', { class: 'field' }, label, inp),
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }], cancelValue: false,
    onOpen: d => { inp.focus(); inp.select(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') d.querySelector('.modal-foot .primary').click(); }); },
  });
  return r ? inp.value : null;
}

// ---------------------------------------------------------------- tiny IndexedDB key/value store
let dbp;
function db() {
  dbp ||= new Promise((res, rej) => {
    try {
      const rq = indexedDB.open('pdf-gateway', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
export async function kvGet(k, d = null) {
  try { const d0 = await db(); return await new Promise(r => { const q = d0.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result ?? d); q.onerror = () => r(d); }); } catch { return d; }
}
export async function kvSet(k, v) {
  try { const d0 = await db(); await new Promise((r, j) => { const t = d0.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = r; t.onerror = () => j(t.error); }); return true; } catch { return false; }
}

export const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const baseName = n => String(n || 'document').replace(/\.[^.]+$/, '');
