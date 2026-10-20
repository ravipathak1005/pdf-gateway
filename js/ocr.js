// OCR → searchable PDF using tesseract.js (loaded on demand from a CDN the first time;
// the engine and language data are then cached by the browser for offline reuse).
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not download the OCR engine. Check your internet connection (needed only the first time).'));
    document.head.append(s);
  });
}
export async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  loading ||= loadScript(TESS_URL);
  await loading;
  return window.Tesseract;
}

/** Returns {recognize(canvas) -> Uint8Array(single-page searchable PDF), close()} */
export async function createOcr(langs = 'eng+hin', onStatus) {
  const T = await loadTesseract();
  const worker = await T.createWorker(langs.split('+'), 1, {
    logger: m => { if (m.status) onStatus?.(m.status, m.progress); },
  });
  return {
    async recognize(canvas, title = 'page') {
      const { data } = await worker.recognize(canvas, { pdfTitle: title }, { pdf: true });
      return Uint8Array.from(data.pdf);
    },
    async close() { try { await worker.terminate(); } catch {} },
  };
}
