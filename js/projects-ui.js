// Projects list on the home screen + Trash dialog.
import { $, h, toast, modal, confirmBox, promptBox, busy } from './ui.js';
import { listProjects, trashProjects, restoreProjects, purgeProjects, emptyTrash, renameProject, duplicateProject, storageInfo, daysLeft, clearOnExit, setClearOnExit, P } from './projects.js';
import { fmtBytes } from './state.js';

let openFn = () => {}, sel = new Set();

const ago = t => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const hr = Math.round(m / 60); if (hr < 24) return hr + ' h ago';
  const d = Math.round(hr / 24); return d === 1 ? 'yesterday' : d + ' days ago';
};

export function initProjectsUI({ open, newScan }) {
  openFn = open;
  $('#btnTrash').onclick = showTrash;
  $('#btnNewScan').onclick = newScan;
  const cb = $('#clearExit'); cb.checked = clearOnExit();
  cb.onchange = () => { setClearOnExit(cb.checked); toast(cb.checked ? 'Saved projects will be erased when you close the app.' : 'Projects will be kept between visits.', 'info'); };
}

export async function refreshProjects() {
  const box = $('#projectsBox');
  let list = [], info = { used: 0, quota: 0, count: 0, trashed: 0 };
  try { list = await listProjects(false); info = await storageInfo(); } catch (e) { console.warn(e); }
  box.hidden = !list.length && !info.trashed;
  $('#trashN').textContent = info.trashed ? `(${info.trashed})` : '';
  $('#projInfo').textContent = list.length ? `${list.length} saved · ${fmtBytes(info.used)}${info.quota ? ' of ' + fmtBytes(info.quota) + ' available' : ''} · stored only in this browser` : '';
  sel = new Set([...sel].filter(id => list.some(m => m.id === id)));
  const grid = $('#projList'); grid.innerHTML = '';
  if (list.length) grid.append(selectBar(list));
  for (const m of list) {
    const c = h('input', { type: 'checkbox', class: 'proj-sel', 'aria-label': 'Select ' + m.name, onchange: e => { e.target.checked ? sel.add(m.id) : sel.delete(m.id); grid.querySelector('.proj-bar').replaceWith(selectBar(list)); } });
    c.checked = sel.has(m.id);
    grid.append(h('div', { class: 'proj' + (m.id === P.id ? ' cur' : '') },
      c,
      h('button', { class: 'proj-th', onclick: () => openFn(m.id), title: 'Open' }, m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('span', {}, '—')),
      h('div', { class: 'proj-meta' },
        h('b', { title: m.name }, m.name),
        h('small', {}, `${m.kind === 'scan' ? 'Scan' : 'PDF'} · ${m.pages} page${m.pages > 1 ? 's' : ''} · ${fmtBytes(m.bytes || 0)}`),
        h('small', { class: 'muted' }, 'Edited ' + ago(m.updated))),
      h('div', { class: 'proj-acts' },
        h('button', { class: 'primary', onclick: () => openFn(m.id) }, 'Open'),
        h('button', { onclick: async () => { const n = await promptBox('Rename project', 'Name', m.name); if (n) { await renameProject(m.id, n); refreshProjects(); } } }, 'Rename'),
        h('button', { onclick: async () => { busy('Duplicating…'); try { await duplicateProject(m.id); } finally { busy(false); } refreshProjects(); } }, 'Duplicate'),
        h('button', { class: 'del', onclick: async () => { await trashProjects([m.id]); toast(`“${m.name}” moved to Trash — restorable for 7 days.`, 'info'); refreshProjects(); } }, 'Delete'))));
  }
}

function selectBar(list) {
  const n = sel.size;
  return h('div', { class: 'proj-bar', hidden: !n },
    h('span', {}, `${n} selected`),
    h('button', { onclick: () => { for (const m of list) sel.add(m.id); refreshProjects(); } }, 'Select all'),
    h('button', { onclick: () => { sel.clear(); refreshProjects(); } }, 'Clear'),
    h('button', { class: 'del', onclick: async () => { const ids = [...sel]; sel.clear(); await trashProjects(ids); toast(`${ids.length} project${ids.length > 1 ? 's' : ''} moved to Trash.`, 'info'); refreshProjects(); } }, 'Delete selected'));
}

export async function showTrash() {
  const body = h('div', { class: 'trash-list' });
  const draw = async () => {
    const list = await listProjects(true); body.innerHTML = '';
    if (!list.length) { body.append(h('p', { class: 'muted' }, 'Trash is empty. Deleted projects stay here for 7 days, then are erased for good.')); return; }
    for (const m of list) body.append(h('div', { class: 'trash-row' },
      m.thumb ? h('img', { src: m.thumb, alt: '' }) : h('span', { class: 'ph' }),
      h('div', {}, h('b', {}, m.name), h('small', { class: 'muted' }, `${m.pages} page${m.pages > 1 ? 's' : ''} · erased in ${daysLeft(m)} day${daysLeft(m) === 1 ? '' : 's'}`)),
      h('button', { onclick: async () => { await restoreProjects([m.id]); await draw(); refreshProjects(); } }, 'Restore'),
      h('button', { class: 'del', onclick: async () => { if (await confirmBox('Delete forever?', `“${m.name}” will be erased permanently.`, 'Delete forever')) { await purgeProjects([m.id]); await draw(); refreshProjects(); } } }, 'Delete forever')));
  };
  await draw();
  const r = await modal({ title: 'Trash', body, width: 560, buttons: [{ label: 'Empty Trash', value: 'empty' }, { label: 'Close', value: true, primary: true }], cancelValue: true });
  if (r === 'empty') { if (await confirmBox('Empty Trash?', 'Everything in Trash will be erased permanently.', 'Empty Trash')) { await emptyTrash(); toast('Trash emptied.', 'ok'); } }
  refreshProjects();
}
