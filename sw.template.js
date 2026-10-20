// PDF Gateway service worker — precaches the whole app so it works offline after the first visit.
const VERSION = 'pdfgw-__VERSION__';
const FILES = __FILES__;
// Cloudflare (and some hosts) redirect /index.html -> /. A *redirected* response can't be served to a navigation
// (browser shows ERR_FAILED), so always re-wrap it as a clean response.
const clean = async res => {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
};
const put = async (c, req, res) => { if (res && res.ok) await c.put(req, await clean(res.clone())); };
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(FILES.map(async f => {
    try { await put(c, new Request(f), await fetch(new Request(f, { cache: 'reload' }))); } catch (_) {}
  }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('pdfgw-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // CDN (OCR engine) etc. are handled by the browser cache
  const nav = req.mode === 'navigate';
  e.respondWith((async () => {
    const hit = await caches.match(nav ? './index.html' : req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && !nav) { const c = await caches.open(VERSION); await put(c, req, res); }
      return await clean(res);
    } catch (err) {
      return (await caches.match('./index.html')) || Response.error();
    }
  })());
});
