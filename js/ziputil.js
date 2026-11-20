// Small shared helpers for the ZIP outputs (AI export and backup). Pure except readBlobBytes.
import { Zip, ZipPassThrough, ZipDeflate, strToU8 } from '../vendor/fflate.esm.js';

export const pad2 = (n) => String(n).padStart(2, '0');
export const fileStamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' };
export const extOf = (rec, fallback) => String(rec.ext || MIME_EXT[String(rec.mime_type || '').split(';')[0]] || fallback).replace(/[^\w]/g, '') || fallback;

// Split items [{size}] into consecutive groups whose summed size stays <= limit.
// A single item bigger than the limit goes alone in its own group. Order is preserved.
export function partitionBySize(items, limit) {
  const parts = [];
  let cur = []; let sum = 0;
  for (const it of items) {
    if (cur.length && sum + it.size > limit) { parts.push(cur); cur = []; sum = 0; }
    cur.push(it); sum += it.size;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// Streaming zip writer around fflate. Chunks are accumulated; finish() returns them.
export function createZipWriter() {
  const chunks = [];
  let size = 0;
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  finished.catch(() => {});
  const zip = new Zip((err, chunk, final) => {
    if (err) { settle.reject(err); return; }
    chunks.push(chunk); size += chunk.length;
    if (final) settle.resolve();
  });
  return {
    get size() { return size; },
    addStored(name, u8) { const f = new ZipPassThrough(name); zip.add(f); f.push(u8, true); },
    addText(name, text) { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); f.push(strToU8(text), true); },
    async finish() { zip.end(); await finished; return chunks; }
  };
}

export const isMemoryError = (e) => !!e && (e instanceof RangeError || e.name === 'QuotaExceededError' || /memory|allocation|quota/i.test(String(e.message || '')));
export async function readBlobBytes(rec) { return new Uint8Array(await rec.blob.arrayBuffer()); }

export async function sha256Hex(u8) {
  const d = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
