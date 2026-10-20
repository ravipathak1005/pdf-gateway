// Share a finished PDF straight from the app (WhatsApp, email, Drive, Bluetooth …) using the device's share sheet.
// Chrome only allows sharing right after a tap, and building a PDF can take a few seconds — so we build first,
// then show a small "ready" card whose Share button is a fresh tap.
import { h, modal, toast } from './ui.js';
import { download } from './export.js';

const kb = n => n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

export function canShareFiles(mime = 'application/pdf') {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: mime })] })); } catch { return false; }
}

export async function offerShare(bytes, filename, { mime = 'application/pdf', title = filename } = {}) {
  const can = canShareFiles(mime);
  const file = new File([bytes], filename, { type: mime });
  const note = h('p', { class: 'muted', style: { margin: '8px 0 0', fontSize: '12.5px' } },
    can ? 'Pick WhatsApp, Gmail, Drive or any app from your phone’s share list.' : 'Sharing straight from the browser isn’t supported here — download the file, then send it from your files app.');
  const shareBtn = h('button', { class: 'primary', onclick: async () => {
    try { await navigator.share({ files: [file], title }); done(true); }
    catch (e) { if (e?.name !== 'AbortError') { toast('Could not open the share sheet: ' + (e?.message || e), 'error'); } }
  } }, 'Share…');
  let done = () => {};
  const body = h('div', {}, h('p', { style: { margin: 0 } }, h('b', {}, filename), h('br'), h('span', { class: 'muted' }, kb(bytes.length || bytes.size))), note);
  const buttons = [{ label: 'Download', value: 'dl' }, { label: 'Close', value: true }];
  const r = await modal({
    title: 'Your PDF is ready', body, width: 420, buttons, cancelValue: true,
    onOpen: (dlg, d) => { done = d; if (can) dlg.querySelector('.modal-foot').prepend(shareBtn); },
  });
  if (r === 'dl') download(bytes, filename, mime);
}
