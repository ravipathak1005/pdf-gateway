// Small polyfills so the bundled pdf.js also runs on slightly older browsers.
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsert) C.prototype.getOrInsert = function (k, d) { if (!this.has(k)) this.set(k, d); return this.get(k); };
  if (!C.prototype.getOrInsertComputed) C.prototype.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
}
if (!Promise.try) Promise.try = function (fn, ...a) { return new Promise(res => res(fn(...a))); };
if (!Promise.withResolvers) Promise.withResolvers = function () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
if (!Math.sumPrecise) Math.sumPrecise = function (it) { let s = 0, c = 0; for (const x of it) { const y = x - c, t = s + y; c = (t - s) - y; s = t; } return s; };
if (!Object.hasOwn) Object.hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
if (!Uint8Array.prototype.toHex) Uint8Array.prototype.toHex = function () { let s = ''; for (const b of this) s += b.toString(16).padStart(2, '0'); return s; };
if (!Uint8Array.prototype.toBase64) Uint8Array.prototype.toBase64 = function () { let s = ''; for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000)); return btoa(s); };
if (!Uint8Array.fromBase64) Uint8Array.fromBase64 = function (s) { const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
if (!Uint8Array.fromHex) Uint8Array.fromHex = function (s) { const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
