// Password protection for PDFs (PDF standard security handler, V4/R4, AES-128).
// Self-contained: MD5 + RC4 for the key schedule, WebCrypto for AES-CBC.
// Works on a pdf-lib document *before* it is saved.

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

// ---- MD5 -----------------------------------------------------------------
const MK = new Uint32Array(64);
for (let i = 0; i < 64; i++) MK[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
const MR = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
export function md5(msg) {
  const len = msg.length, total = (len + 9 + 63) & ~63;
  const buf = new Uint8Array(total); buf.set(msg); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (len << 3) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(len / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MK[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const sh = MR[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << sh) | (F >>> (32 - sh)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), o = new DataView(out.buffer);
  o.setUint32(0, a0, true); o.setUint32(4, b0, true); o.setUint32(8, c0, true); o.setUint32(12, d0, true);
  return out;
}

// ---- RC4 -----------------------------------------------------------------
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
// Passwords: Latin-1 as per the spec for R<=4 (non-Latin-1 characters replaced by '?')
const pwBytes = s => Uint8Array.from([...String(s ?? '')].map(c => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63)));
const padPw = s => { const p = pwBytes(s).slice(0, 32); return cat(p, PAD.slice(0, 32 - p.length)); };

function computeO(userPw, ownerPw) {
  let h = md5(padPw(ownerPw || userPw));
  for (let i = 0; i < 50; i++) h = md5(h);
  const key = h.slice(0, 16);
  let x = rc4(key, padPw(userPw));
  for (let i = 1; i <= 19; i++) x = rc4(key.map(b => b ^ i), x);
  return x;
}
function computeKey(userPw, O, P, id) {
  const p = new Uint8Array(4); new DataView(p.buffer).setInt32(0, P, true);
  let h = md5(cat(padPw(userPw), O, p, id));
  for (let i = 0; i < 50; i++) h = md5(h.slice(0, 16));
  return h.slice(0, 16);
}
function computeU(key, id) {
  let x = rc4(key, md5(cat(PAD, id)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map(b => b ^ i), x);
  return cat(x, new Uint8Array(16)); // 16 arbitrary padding bytes
}

/** Permission flags → /P value. All true = unrestricted. */
export function permValue(p = {}) {
  const on = (k, d = true) => (p[k] ?? d);
  let v = 0xfffff0c0 | 0;      // bits 7,8 and 13-32 must be 1
  if (on('print')) v |= 1 << 2;
  if (on('modify')) v |= 1 << 3;
  if (on('copy')) v |= 1 << 4;
  if (on('annotate')) v |= 1 << 5;
  if (on('fill')) v |= 1 << 8;
  v |= 1 << 9;                 // accessibility extraction always allowed
  if (on('assemble')) v |= 1 << 10;
  if (on('print')) v |= 1 << 11; // high-quality print follows print
  return v | 0;
}

/**
 * Encrypt every string/stream in a pdf-lib document in place and install /Encrypt.
 * After this call the document MUST be saved with { useObjectStreams: false }.
 */
export async function encryptDoc(doc, { user = '', owner = '', perms = {} } = {}) {
  const L = window.PDFLib;
  const ctx = doc.context;
  const id = crypto.getRandomValues(new Uint8Array(16));
  const ownerPw = owner || (user ? user + '\u0000owner' + hex(crypto.getRandomValues(new Uint8Array(6))) : hex(crypto.getRandomValues(new Uint8Array(8))));
  const P = permValue(perms);
  const O = computeO(user, ownerPw);
  const key = computeKey(user, O, P, id);
  const U = computeU(key, id);

  const keyCache = new Map();
  async function objKey(num, gen) {
    const k = num + ':' + gen;
    let ck = keyCache.get(k);
    if (!ck) {
      const salt = Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255, 0x73, 0x41, 0x6c, 0x54]);
      const raw = md5(cat(key, salt)).slice(0, 16);
      ck = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt']);
      keyCache.set(k, ck);
    }
    return ck;
  }
  async function aes(ck, data) {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ck, data));
    return cat(iv, ct);
  }
  async function walk(o, ck) {
    if (o instanceof L.PDFHexString || o instanceof L.PDFString) {
      return L.PDFHexString.of(hex(await aes(ck, o.asBytes())));
    }
    if (o instanceof L.PDFArray) {
      for (let i = 0; i < o.size(); i++) { const v = o.get(i), n = await walk(v, ck); if (n !== v) o.set(i, n); }
      return o;
    }
    if (o instanceof L.PDFDict) { // includes PDFStream dicts via caller
      for (const [k, v] of [...o.entries()]) { const n = await walk(v, ck); if (n !== v) o.set(k, n); }
      return o;
    }
    return o;
  }

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const ck = await objKey(ref.objectNumber, ref.generationNumber);
    if (obj instanceof L.PDFStream) {
      const type = obj.dict.get(L.PDFName.of('Type'));
      if (type && type.toString() === '/XRef') continue;
      await walk(obj.dict, ck);
      const enc = await aes(ck, obj.getContents());
      ctx.assign(ref, L.PDFRawStream.of(obj.dict, enc));
    } else {
      await walk(obj, ck);
    }
  }

  const enc = ctx.obj({
    Filter: 'Standard', V: 4, R: 4, Length: 128,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV2', Length: 16 } },
    StmF: 'StdCF', StrF: 'StdCF',
    O: L.PDFHexString.of(hex(O)), U: L.PDFHexString.of(hex(U)), P,
  });
  ctx.trailerInfo.Encrypt = ctx.register(enc);
  ctx.trailerInfo.ID = ctx.obj([L.PDFHexString.of(hex(id)), L.PDFHexString.of(hex(id))]);
  return { saveOptions: { useObjectStreams: false, updateFieldAppearances: false } };
}
