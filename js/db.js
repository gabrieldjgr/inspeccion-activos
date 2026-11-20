// Minimal promise wrapper over IndexedDB. No external dependencies.
export const DB_NAME = 'inspeccion-activos';
export const DB_VERSION = 2;

let dbPromise = null;
let legacy = false; // true: open the DB at whatever version it has, never upgrade (pre-migration backup)
const listeners = { error: [], versionchange: [] };

export function onDbEvent(type, fn) { listeners[type].push(fn); }
function emit(type, detail) { listeners[type].forEach((fn) => { try { fn(detail); } catch (_) { /* ignore */ } }); }

// ISO 8601 with local offset (e.g. 2026-11-12T10:42:13-06:00), never 'Z'. Re-exported by data.js.
export function nowIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

// ---- Normalization helpers (shared by buildings and departments) ----
export const normKey = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
export const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* ---------------------------------------------------------------- schema
v1 (app 0.1–0.2): settings(key) · buildings(code) · departments(key) · assets(id) · blobs(id)
v2 (app 0.3):     + projects(id) · lists(id) · _v1_backup(key)
                  buildings recreated: keyPath id (uuid), indexes project_id, project_code [project_id, code_key] UNIQUE
                  departments recreated: keyPath id = `${project_id}|${key}`, index project_id
                  assets: + index project_id; every record gets project_id and building_id
                  blobs: NOT touched (photos/audio are never rewritten by a migration)
Migration v1 -> v2 runs inside the single upgrade transaction: if anything throws, the browser rolls
the whole upgrade back and the DB stays at v1 with its data intact. */
function createV1(db) {
  db.createObjectStore('settings', { keyPath: 'key' });
  db.createObjectStore('buildings', { keyPath: 'code' });
  db.createObjectStore('departments', { keyPath: 'key' });
  const assets = db.createObjectStore('assets', { keyPath: 'id' });
  assets.createIndex('created_at', 'created_at');
  assets.createIndex('building_code', 'building_code');
  assets.createIndex('exported_at', 'exported_at');
  assets.createIndex('status', 'status'); // 'draft' | 'saved'
  const blobs = db.createObjectStore('blobs', { keyPath: 'id' });
  blobs.createIndex('asset_id', 'asset_id'); // owner id: an asset id or (v2+) a building id
  blobs.createIndex('kind', 'kind'); // 'photo' | 'thumb' | 'audio' | 'audiochunk'
}

export const departmentId = (projectId, key) => `${projectId}|${key}`;

// Pure mapping of v1 records to v2 (exported for tests). Returns { project, buildings, departments, codeToId }.
export function mapV1ToV2({ buildings, departments, lastContext, projectId, now }) {
  const codeToId = new Map();
  const usedKeys = new Set();
  const outB = [];
  for (const b of buildings) {
    let key = normKey(b.code);
    if (!key) continue;
    // v1 keyed buildings by exact code, so "b-01" and "B-01" could coexist; v2 is case-insensitive.
    let n = 2; const base = key;
    while (usedKeys.has(key)) key = `${base}~${n++}`;
    usedKeys.add(key);
    const id = crypto.randomUUID();
    if (!codeToId.has(normKey(b.code))) codeToId.set(normKey(b.code), id);
    outB.push({ id, project_id: projectId, code: cleanText(b.code), code_key: key, name: cleanText(b.name), source: 'migrated', created_at: now, updated_at: now, ...(key !== base ? { duplicate_of: base } : {}) });
  }
  const outD = [];
  const seenD = new Set();
  for (const d of departments) {
    const key = d.key || normKey(d.name);
    if (!key || seenD.has(key)) continue;
    seenD.add(key);
    outD.push({ id: departmentId(projectId, key), project_id: projectId, key, name: d.name });
  }
  const ctx = lastContext ? { ...lastContext, building_id: codeToId.get(normKey(lastContext.building_code)) || null } : null;
  const project = {
    schema_version: 1, id: projectId, name: 'Proyecto 1', client: '', site: '', units: 'imperial', valuer_code: '',
    status: 'active', created_at: now, updated_at: now, last_context: ctx, migrated_from_v1: true
  };
  return { project, buildings: outB, departments: outD, codeToId };
}

function migrateToV2(db, t, hadV1) {
  db.createObjectStore('projects', { keyPath: 'id' });
  db.createObjectStore('lists', { keyPath: 'id' }).createIndex('project_id', 'project_id');
  const bak = db.createObjectStore('_v1_backup', { keyPath: 'key' });
  const assets = t.objectStore('assets');
  assets.createIndex('project_id', 'project_id');

  const recreate = () => {
    db.deleteObjectStore('buildings');
    db.deleteObjectStore('departments');
    const b = db.createObjectStore('buildings', { keyPath: 'id' });
    b.createIndex('project_id', 'project_id');
    b.createIndex('project_code', ['project_id', 'code_key'], { unique: true });
    db.createObjectStore('departments', { keyPath: 'id' }).createIndex('project_id', 'project_id');
  };
  if (!hadV1) { recreate(); return; }

  const fail = (r) => () => { try { t.abort(); } catch (_) { /* noop */ } emit('error', r.error || new Error('Migración fallida')); };
  const rB = t.objectStore('buildings').getAll();
  rB.onerror = fail(rB);
  rB.onsuccess = () => {
    const rD = t.objectStore('departments').getAll();
    rD.onerror = fail(rD);
    rD.onsuccess = () => {
      const rC = t.objectStore('settings').get('last_context');
      rC.onerror = fail(rC);
      rC.onsuccess = () => {
        const rN = assets.count();
        rN.onerror = fail(rN);
        rN.onsuccess = () => {
          const oldB = rB.result || []; const oldD = rD.result || []; const ctx = rC.result ? rC.result.value : null;
          const now = nowIso();
          // Safety copy of the small v1 stores (text only) before recreating them.
          bak.put({ key: 'buildings', value: oldB });
          bak.put({ key: 'departments', value: oldD });
          bak.put({ key: 'last_context', value: ctx });
          bak.put({ key: 'migrated_at', value: now });
          recreate();
          if (!oldB.length && !oldD.length && !rN.result) return; // empty v1 DB: nothing to move
          const m = mapV1ToV2({ buildings: oldB, departments: oldD, lastContext: ctx, projectId: crypto.randomUUID(), now });
          t.objectStore('projects').put(m.project);
          const sB = t.objectStore('buildings'); for (const b of m.buildings) sB.put(b);
          const sD = t.objectStore('departments'); for (const d of m.departments) sD.put(d);
          const sS = t.objectStore('settings');
          sS.put({ key: 'active_project', value: m.project.id });
          sS.delete('last_context'); // now lives on the project
          const cur = assets.openCursor();
          cur.onerror = fail(cur);
          cur.onsuccess = () => {
            const c = cur.result; if (!c) return;
            const a = c.value;
            c.update({ ...a, project_id: m.project.id, building_id: m.codeToId.get(normKey(a.building_code)) || null });
            c.continue();
          };
        };
      };
    };
  };
}

function openRequest() {
  return legacy ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, DB_VERSION);
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('Este navegador no soporta IndexedDB.')); return; }
    let req;
    try { req = openRequest(); } catch (e) { reject(e); return; }
    req.onupgradeneeded = (ev) => {
      if (legacy) { req.transaction.abort(); return; } // legacy mode never creates nor upgrades
      const db = req.result;
      const t = req.transaction;
      if (ev.oldVersion < 1) createV1(db);
      if (ev.oldVersion < 2) migrateToV2(db, t, ev.oldVersion >= 1);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; emit('versionchange'); };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('No se pudo abrir la base de datos.'));
    req.onblocked = () => emit('error', new Error('La base de datos está bloqueada por otra pestaña o ventana de la app. Ciérrala y recarga.'));
  });
  dbPromise.catch((e) => { dbPromise = null; emit('error', e); });
  return dbPromise;
}

// Version of the DB on disk without creating or upgrading it (0 = it does not exist).
export function probeVersion() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('Este navegador no soporta IndexedDB.')); return; }
    let creating = false;
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => { creating = true; req.transaction.abort(); };
    req.onsuccess = () => { const v = req.result.version; req.result.close(); resolve(v); };
    req.onerror = (e) => { if (creating) { e.preventDefault(); resolve(0); } else reject(req.error); };
    req.onblocked = () => emit('error', new Error('La base de datos está bloqueada por otra pestaña o ventana de la app. Ciérrala y recarga.'));
  });
}

// Legacy mode: open the existing DB at its current (old) version. Used only for the pre-migration backup.
export async function setLegacyMode(on) {
  if (legacy === on) return;
  await closeDb();
  legacy = on;
}
export const isLegacyMode = () => legacy;
export async function closeDb() {
  if (!dbPromise) return;
  try { const d = await dbPromise; d.close(); } catch (_) { /* ignore */ }
  dbPromise = null;
}
export async function currentVersion() { return (await openDb()).version; }
export async function storeNames() { return [...(await openDb()).objectStoreNames]; }

// Runs fn(stores) inside a transaction; resolves with fn's value once the transaction commits.
export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = {};
    names.forEach((n) => { stores[n] = t.objectStore(n); });
    let result;
    Promise.resolve(fn(names.length === 1 ? stores[names[0]] : stores)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch (_) { /* noop */ } reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
  });
}

export const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const get = (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key)));
export const getAll = (store) => tx(store, 'readonly', (s) => wrap(s.getAll()));
export const put = (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key)));
export const clear = (store) => tx(store, 'readwrite', (s) => wrap(s.clear()));
export const count = (store) => tx(store, 'readonly', (s) => wrap(s.count()));

// All records of a store that belong to a project (index 'project_id').
export const getByProject = (store, projectId) => tx(store, 'readonly', (s) => wrap(s.index('project_id').getAll(IDBKeyRange.only(projectId))));
export const countByProject = (store, projectId) => tx(store, 'readonly', (s) => wrap(s.index('project_id').count(IDBKeyRange.only(projectId))));

export async function putMany(store, values, { clearFirst = false } = {}) {
  return tx(store, 'readwrite', async (s) => {
    if (clearFirst) s.clear();
    for (const v of values) s.put(v);
  });
}

// Delete every record of a store that belongs to a project.
export function deleteByProject(store, projectId) {
  return tx(store, 'readwrite', (s) => new Promise((resolve, reject) => {
    const req = s.index('project_id').openKeyCursor(IDBKeyRange.only(projectId));
    req.onsuccess = () => { const c = req.result; if (!c) { resolve(); return; } s.delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  }));
}

// ---- Settings (key/value) ----
export async function getSetting(key, fallback = null) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export const setSetting = (key, value) => put('settings', { key, value });

export async function ensureDeviceId() {
  let id = await getSetting('device_id');
  if (!id) { id = crypto.randomUUID(); await setSetting('device_id', id); }
  return id;
}
