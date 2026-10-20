// Devanagari / custom fonts. System fonts (Utsaah, Mangal, Nirmala UI…) are used automatically
// when installed; any .ttf/.otf/.woff you add here is stored in this browser (IndexedDB) and
// reused every time — no re-uploading.
import { userFonts, clearTextCache } from './prims.js';
import { kvGet, kvSet } from './ui.js';

async function register(name, data) {
  const face = new FontFace(name, data);
  await face.load();
  document.fonts.add(face);
  if (!userFonts.includes(name)) userFonts.push(name);
  clearTextCache();
}

export async function initFonts() {
  const list = await kvGet('fonts', []);
  for (const f of list) { try { await register(f.name, f.data.slice(0)); } catch (e) { console.warn('font failed', f.name, e); } }
  return userFonts;
}

export async function addFontFile(file) {
  const data = await file.arrayBuffer();
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, ' ').trim() || 'Custom font';
  await register(name, data.slice(0));
  const list = await kvGet('fonts', []);
  const i = list.findIndex(f => f.name === name);
  const rec = { name, data };
  if (i >= 0) list[i] = rec; else list.push(rec);
  await kvSet('fonts', list);
  return name;
}

export async function removeFont(name) {
  const list = (await kvGet('fonts', [])).filter(f => f.name !== name);
  await kvSet('fonts', list);
  const i = userFonts.indexOf(name); if (i >= 0) userFonts.splice(i, 1);
}

// ---- saved signatures
export const getSignatures = () => kvGet('signatures', []);
export async function saveSignature(url) {
  const list = await getSignatures();
  list.unshift(url);
  await kvSet('signatures', list.slice(0, 8));
}
export async function deleteSignature(i) {
  const list = await getSignatures(); list.splice(i, 1); await kvSet('signatures', list);
}
