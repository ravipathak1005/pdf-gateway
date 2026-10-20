# PDF Gateway — one-stop, offline, private PDF toolkit

Everything runs in your browser. Files never leave your device.

**Covers:** merge · split · extract · reorder · rotate · delete · duplicate · blank pages · crop · edit existing text (cover & retype) · add text (Hindi/Devanagari shaped correctly) · highlight / shapes / lines / arrows / pen · signatures (draw or upload) · stamps (incl. सत्यापित / प्रमाणित / प्राप्त) · watermark · page numbers · header/footer · redaction (true removal) · fill forms · images → PDF · PDF → images/text · camera/photo scanner with auto edge-detect + enhance · compress to a target size · password protect (AES-128) · unlock · optional OCR.

## Projects & Scanner (v1.1)
* **Projects:** every job is saved automatically in this browser (IndexedDB) and listed on the home screen — Open, Rename, Duplicate, Delete. Deleted projects go to **Trash** for 7 days (restore or erase early). Projects never leave the device and do not sync between devices/browsers.
* **Privacy switch:** "clear all saved projects when I close the app" erases everything when the app is closed (done at close where the browser allows, and again at the next start).
* **Scanner:** a separate, small flow (photos → crop → colour → save PDF/images). Full-screen crop editor with loupe and edge handles; colour presets plus brightness, contrast, shadow removal, sharpen and B&W level. "Open in editor" hands the scan to the full PDF editor.

## Run
The app uses ES modules, so it must be served over http(s) — double-clicking index.html (file://) will not work.

* **GitHub Pages (recommended):** put this folder in a repo → Settings → Pages → deploy from branch. Open the URL once online; then "Install app" / "Add to Home screen". After that it works offline.
* **Locally:** run `run-local.bat` (Windows) or `./run-local.sh`, then open http://localhost:8765 (needs Python).

After changing any file, run `python3 build-sw.py` to regenerate `sw.js` (offline cache list/version).

## Hindi fonts
Text uses Utsaah first, then Mangal / Nirmala UI / Noto Sans Devanagari. If Utsaah isn't on the device, use **Add font** in the text dialog and pick `Utsaah.ttf`; it is remembered in the browser.

## Honest limits
* **Edit text** covers the old text with a background-coloured box and places new text (not a true content-stream edit).
* **Redaction, compress, unlock, gray/B&W export** rasterise the pages (no selectable text afterwards, unless OCR is on).
* **Forms** are filled as flattened overlays, not live form values.
* **OCR** (English + Hindi) downloads Tesseract from a CDN the first time (needs internet), then is cached by the browser.
* PDFs made with legacy fonts (Kruti Dev etc.) look right but copy/extract as gibberish — that's in the file itself.
* Password: encryption is AES-128; browsers can't offer AES-256 writing here.
