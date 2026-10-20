// Projects: every job (an edited PDF, a merge, a scan batch) is saved automatically in this browser
// (IndexedDB). Deleted projects go to Trash for 7 days. Optional "clear on exit" privacy switch.
import { S, subscribe, clearAll, emit } from './state.js';
import { addPdfSource, addImageSource, renderComposite } from './pdfio.js';

const DB = 'pdf-gateway-projects', TRASH_DAYS = 7;
export const P = { id: null, kind: 'edit', name: '' };   // the project currently loaded in S
let dbp = null, loading = false, lastSaved = '', thumbKey = '', saving = Promise.resolve();
const savedBlobs = new Set();          // `${projectId}:${sid}` already written
const assetBlobs = new Map();          // aid -> Blob

function db() {
  dbp ||= new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore('meta', { keyPath: 'id' }); d.createObjectStore('data', { keyPath: 'id' }); d.createObjectStore('blobs'); };
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const tx = async (stores, mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode); let out;
    out = fn(...[].concat(stores).map(n => t.objectStore(n)));
    t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
};
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

// ------------------------------------------------------------------ privacy switch
export const clearOnExit = () => { try { return localStorage.getItem('pgClearOnExit') === '1'; } catch { return false; } };
export function setClearOnExit(on) { try { on ? localStorage.setItem('pgClearOnExit', '1') : localStorage.removeItem('pgClearOnExit'); } catch {} }
export async function wipeAll() {
  try { const d = await db(); d.close(); } catch {}
  dbp = null;
  await new Promise(r => { try { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onerror = q.onblocked = () => r(); } catch { r(); } });
  savedBlobs.clear();
}

// ------------------------------------------------------------------ list / queries
export async function listProjects(trash = false) {
  const all = await tx('meta', 'readonly', m => m.getAll());
  return all.filter(x => !!x.deleted === trash).sort((a, b) => (trash ? b.deleted - a.deleted : b.updated - a.updated));
}
export async function storageInfo() {
  const all = await tx('meta', 'readonly', m => m.getAll()).catch(() => []);
  const used = all.reduce((n, m) => n + (m.bytes || 0), 0);
  let quota = 0; try { quota = (await navigator.storage.estimate()).quota || 0; } catch {}
  return { used, quota, count: all.filter(m => !m.deleted).length, trashed: all.filter(m => m.deleted).length };
}

// ------------------------------------------------------------------ saving
let timer = null;
export function scheduleSave() { if (loading) return; clearTimeout(timer); timer = setTimeout(() => { saveNow().catch(e => console.warn('autosave failed', e)); }, 1200); }
export function flushSave() { clearTimeout(timer); return saveNow().catch(e => console.warn('save failed', e)); }

function sig() { return JSON.stringify([S.pages, S.stamps, S.meta, P.name, P.kind]); }

async function makeThumb() {
  const pg = S.pages[0]; if (!pg) return '';
  try {
    const cv = await renderComposite(pg, 0, S.pages.length, 150 / Math.max(pg.w, pg.h));
    const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
    const g = out.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height); g.drawImage(cv, 0, 0);
    return out.toDataURL('image/jpeg', 0.6);
  } catch { return ''; }
}

function saveNow() {
  saving = saving.then(async () => {
    if (!S.pages.length || loading) return;
    const s = sig(); if (s === lastSaved && P.id) return;
    const created = !P.id;
    if (created) P.id = newId();
    const id = P.id;
    const old = created ? null : await tx('meta', 'readonly', m => m.get(id));
    if (!P.name) P.name = old?.name || [...S.sources.values()][0]?.name?.replace(/\.[^.]+$/, '') || (P.kind === 'scan' ? 'Scan' : 'Untitled');
    const tk = S.pages[0].id + '|' + S.pages[0].src?.sid + '|' + S.pages[0].rot + '|' + S.pages[0].items.length + '|' + (S.pages[0].crop ? 1 : 0);
    const thumb = tk !== thumbKey || !old?.thumb ? await makeThumb() : old.thumb; thumbKey = tk;
    // assets (signature / logo images)
    for (const [aid, a] of S.assets) if (!assetBlobs.has(aid)) { try { assetBlobs.set(aid, await (await fetch(a.url)).blob()); } catch {} }
    const srcs = [...S.sources.values()];
    const newBlobs = srcs.filter(x => !savedBlobs.has(id + ':' + x.id));
    const data = {
      id, pages: JSON.parse(JSON.stringify(S.pages)), stamps: S.stamps, meta: S.meta, nextId: S.nextId, cur: S.cur,
      sources: srcs.map(x => ({ id: x.id, name: x.name, kind: x.kind, mime: x.mime })),
      assets: [...S.assets].map(([aid, a]) => ({ aid, w: a.w, h: a.h })),
    };
    const bytes = srcs.reduce((n, x) => n + (x.bytes?.length || 0), 0);
    const meta = { id, name: P.name, kind: P.kind, created: old?.created || Date.now(), updated: Date.now(), pages: S.pages.length, bytes, thumb, deleted: null };
    await tx(['meta', 'data', 'blobs'], 'readwrite', (m, d, b) => {
      m.put(meta); d.put(data);
      for (const x of newBlobs) b.put(x.bytes, id + ':' + x.id);
      for (const k of [...savedBlobs]) { if (k.startsWith(id + ':') && !k.includes(':a') && !S.sources.has(+k.slice(id.length + 1))) { b.delete(k); savedBlobs.delete(k); } }
      for (const [aid, bl] of assetBlobs) if (S.assets.has(aid)) b.put(bl, id + ':a' + aid);
    });
    for (const x of newBlobs) savedBlobs.add(id + ':' + x.id);
    lastSaved = s;
  });
  return saving;
}

// ------------------------------------------------------------------ open / new / manage
export async function newProject(kind = 'edit') {
  await flushSave();
  loading = true; try { clearAll(); } finally { loading = false; }
  P.id = null; P.kind = kind; P.name = ''; lastSaved = ''; thumbKey = ''; assetBlobs.clear();
}

export async function openProject(id) {
  await flushSave();
  const [meta, data] = await Promise.all([tx('meta', 'readonly', m => m.get(id)), tx('data', 'readonly', d => d.get(id))]);
  if (!meta || !data) throw new Error('Project not found');
  loading = true;
  try {
    clearAll(); assetBlobs.clear();
    for (const sd of data.sources) {
      const bytes = await tx('blobs', 'readonly', b => b.get(id + ':' + sd.id));
      if (!bytes) throw new Error('A file of this project is missing');
      if (sd.kind === 'pdf') await addPdfSource(sd.name, bytes, sd.id); else await addImageSource(sd.name, bytes, sd.mime, sd.id);
      savedBlobs.add(id + ':' + sd.id);
    }
    for (const a of data.assets || []) {
      const bl = await tx('blobs', 'readonly', b => b.get(id + ':a' + a.aid)); if (!bl) continue;
      const url = URL.createObjectURL(bl);
      const img = new Image(); const rec = { url, img, w: a.w, h: a.h, ready: false };
      img.onload = () => { rec.ready = true; emit('items'); }; img.src = url;
      S.assets.set(a.aid, rec); assetBlobs.set(a.aid, bl);
    }
    S.pages = data.pages; S.stamps = data.stamps; S.meta = data.meta; S.nextId = Math.max(data.nextId, ...data.sources.map(x => x.id + 1), ...(data.assets || []).map(a => a.aid + 1));
    S.cur = Math.min(data.cur || 0, S.pages.length - 1); S.sel = new Set([S.pages[S.cur]?.id]);
    P.id = id; P.kind = meta.kind; P.name = meta.name; thumbKey = ''; lastSaved = sig();
  } finally { loading = false; }
  emit('all');
  return meta.kind;
}

async function patchMeta(id, fn) { const m = await tx('meta', 'readonly', x => x.get(id)); if (!m) return; fn(m); await tx('meta', 'readwrite', x => x.put(m)); }
export async function renameProject(id, name) { name = String(name).trim() || 'Untitled'; await patchMeta(id, m => { m.name = name; }); if (id === P.id) { P.name = name; } }

export async function duplicateProject(id) {
  if (id === P.id) await flushSave();
  const [m, d] = await Promise.all([tx('meta', 'readonly', x => x.get(id)), tx('data', 'readonly', x => x.get(id))]);
  const nid = newId();
  const keys = [...d.sources.map(s => String(s.id)), ...(d.assets || []).map(a => 'a' + a.aid)];
  const blobs = await Promise.all(keys.map(k => tx('blobs', 'readonly', b => b.get(id + ':' + k))));
  await tx(['meta', 'data', 'blobs'], 'readwrite', (mm, dd, bb) => {
    mm.put({ ...m, id: nid, name: m.name + ' (copy)', created: Date.now(), updated: Date.now() });
    dd.put({ ...d, id: nid });
    keys.forEach((k, i) => { if (blobs[i]) bb.put(blobs[i], nid + ':' + k); });
  });
  return nid;
}

export async function trashProjects(ids) {
  for (const id of ids) {
    if (id === P.id) { clearTimeout(timer); loading = true; try { clearAll(); } finally { loading = false; } P.id = null; P.name = ''; lastSaved = ''; }
    await patchMeta(id, m => { m.deleted = Date.now(); });
  }
}
export async function restoreProjects(ids) { for (const id of ids) await patchMeta(id, m => { m.deleted = null; m.updated = Date.now(); }); }
export async function purgeProjects(ids) {
  for (const id of ids) {
    const d = await tx('data', 'readonly', x => x.get(id));
    await tx(['meta', 'data', 'blobs'], 'readwrite', (m, dd, b) => {
      m.delete(id); dd.delete(id);
      for (const s of d?.sources || []) b.delete(id + ':' + s.id);
      for (const a of d?.assets || []) b.delete(id + ':a' + a.aid);
    });
    for (const k of [...savedBlobs]) if (k.startsWith(id + ':')) savedBlobs.delete(k);
  }
}
export async function emptyTrash() { await purgeProjects((await listProjects(true)).map(m => m.id)); }
export const daysLeft = m => Math.max(0, Math.ceil((m.deleted + TRASH_DAYS * 864e5 - Date.now()) / 864e5));

// ------------------------------------------------------------------ init
export async function initProjects() {
  try {
    if (clearOnExit() && !sessionStorage.getItem('pgSession')) await wipeAll();
    sessionStorage.setItem('pgSession', '1');
  } catch {}
  try {
    const now = Date.now();
    const old = (await listProjects(true)).filter(m => now - m.deleted > TRASH_DAYS * 864e5).map(m => m.id);
    if (old.length) await purgeProjects(old);
  } catch (e) { console.warn(e); }
  subscribe(() => scheduleSave());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flushSave(); } });
  window.addEventListener('pagehide', () => { if (clearOnExit()) wipeAll(); else flushSave(); });
  try { navigator.storage?.persist?.(); } catch {}
}
