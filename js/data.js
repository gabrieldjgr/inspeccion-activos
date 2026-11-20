// Shared data contracts. FROZEN: photo/audio/export modules depend on these shapes.
import * as db from './db.js';
import { APP_VERSION } from './version.js';

// ---- Floors (fixed list, order as in brief section 3.2) ----
export const FLOORS = (() => {
  const l = ['BASEMENT 4', 'BASEMENT 3', 'BASEMENT 2', 'BASEMENT 1', '1', 'MEZZANINE 1', '2', 'MEZZANINE 2', '3', 'MEZZANINE 3', '4', 'MEZZANINE 4'];
  for (let i = 5; i <= 30; i++) l.push(String(i));
  return l;
})();

// ISO 8601 with local offset (e.g. 2026-11-12T10:42:13-06:00), never 'Z'. Defined in db.js (the migration needs it).
const { nowIso } = db;
export { nowIso };
export const todayKey = (d = new Date()) => nowIso(d).slice(0, 10);

/*
Project record (store 'projects', keyPath 'id'), DB v2+:
{ schema_version:1, id, name, client, site, units:'imperial'|'metric', valuer_code:'' (2-3 letters, this device),
  status:'active'|'archived', created_at, updated_at,
  last_context:{building_id, building_code, building_name, floor, department}|null }

Building record (store 'buildings', keyPath 'id' uuid; unique index [project_id, code_key]):
{ id, project_id, code, code_key:normKey(code), name, source:'migrated'|'import'|'manual'|'package', created_at, updated_at }

Department record (store 'departments', keyPath 'id' = `${project_id}|${key}`): { id, project_id, key, name }

Asset record (store 'assets', keyPath 'id'):
{ schema_version:1, id, project_id, status:'draft'|'saved', seq:number|null (assigned on first save),
  display_id:'B1-GA-A001'|null (assigned on save once the project has a valuer code; see assignDisplayId),
  id_building_key (normKey of the building the display_id was made for), previous_display_ids?:[],
  moved_from_building_code? (building changed after export: the display_id is kept),
  copied_from?:{id, display_id} (created with "Copiar"),
  inspector, device_id, app_version, created_at, updated_at,
  building_id, building_code, building_name (code/name are a snapshot), floor, department, notes,
  gps:{lat,lon,accuracy_m}, exported_at:null|iso }
NOTE: photos[] and audios[] are NOT stored on the asset record. Media modules never write the
asset record (avoids write races with the form). They live in the 'blobs' store and are
assembled at export time.

Blob record (store 'blobs', keyPath 'id', indexes asset_id, kind):
  asset_id = id of the OWNER record (an asset; from v0.3 also a building). Blobs are never rewritten by migrations.
  id = `${kind}:${assetId}:${uuid}`   kind in 'photo' | 'thumb' | 'audio'
  photo: { id, asset_id, kind:'photo', uid, blob:Blob, mime_type, ext:'jpg'|'png'|..., source:'camera'|'gallery',
           is_screenshot:boolean, width, height, bytes, resized:boolean, captured_at:iso, order:number,
           tag?:null|'general'|'placa'|'detalle', copied?:true (copied from another asset) }
  thumb: { id, asset_id, kind:'thumb', uid, blob:Blob, mime_type:'image/jpeg', order }  (same uid and order as its photo)
  audiochunk: transient pieces of a recording in progress (audio.js); recovered at boot by recoverOrphanAudio().
  audio: { id, asset_id, kind:'audio', uid, blob:Blob, mime_type, ext:'webm'|'m4a', duration_s, recorded_at:iso, transcript:null, order:number, copied?:true }
`order` = Date.now() at creation; sort ascending for foto_01, foto_02... numbering.
*/
export const blobId = (kind, assetId, uid) => `${kind}:${assetId}:${uid}`;

// Count media of an asset without loading blobs (primary keys only).
export async function mediaCounts(assetId) {
  const out = { photo: 0, audio: 0, chunk: 0, thumbKey: null };
  await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
    const req = s.index('asset_id').openKeyCursor(IDBKeyRange.only(assetId));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      const kind = String(c.primaryKey).split(':', 1)[0];
      if (kind === 'photo' || kind === 'audio') out[kind]++;
      else if (kind === 'audiochunk') out.chunk++; // unfinished recording: counts as content
      else if (kind === 'thumb' && !out.thumbKey) out.thumbKey = c.primaryKey;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
  return out;
}

// Media counts of MANY owners in one pass over the blob keys (no Blob is loaded).
// Returns Map(owner_id -> {photo, audio, chunk, thumbKey}).
export async function mediaIndex() {
  const out = new Map();
  await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
    const req = s.openKeyCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      const key = String(c.primaryKey);
      const i = key.indexOf(':'); const j = key.indexOf(':', i + 1);
      const kind = key.slice(0, i); const owner = key.slice(i + 1, j);
      let m = out.get(owner);
      if (!m) { m = { photo: 0, audio: 0, chunk: 0, thumbKey: null }; out.set(owner, m); }
      if (kind === 'photo' || kind === 'audio') m[kind]++;
      else if (kind === 'audiochunk') m.chunk++;
      else if (kind === 'thumb' && !m.thumbKey) m.thumbKey = key;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
  return out;
}
// Bytes used by photos/thumbs/audio of a set of owners (asset or building ids). Reads each blob record once
// (Blob bodies stay on disk; only .size is read). Returns { photo, audio, other, total }.
export async function mediaBytes(ownerIds) {
  const owners = ownerIds instanceof Set ? ownerIds : new Set(ownerIds);
  const out = { photo: 0, audio: 0, other: 0, total: 0 };
  await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      const r = c.value;
      if (owners.has(r.asset_id)) {
        const n = r.blob?.size || 0;
        if (r.kind === 'photo') out.photo += n; else if (r.kind === 'audio' || r.kind === 'audiochunk') out.audio += n; else out.other += n;
        out.total += n;
      }
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
  return out;
}
export async function projectBytes(projectId) {
  const [a, b] = await Promise.all([db.getByProject('assets', projectId), db.getByProject('buildings', projectId)]);
  return mediaBytes(new Set([...a.map((x) => x.id), ...b.map((x) => x.id)]));
}

const EMPTY_COUNTS = Object.freeze({ photo: 0, audio: 0, chunk: 0, thumbKey: null });
export const countsOf = (index, id) => index.get(id) || EMPTY_COUNTS;

// All blob records (full, with Blob) of an asset filtered by kind, ordered. Use only for ONE asset at a time.
export async function getMedia(assetId, kind) {
  const all = await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
    const req = s.index('asset_id').getAll(IDBKeyRange.only(assetId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  return all.filter((b) => b.kind === kind).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Delete one media item (and its thumb, if a photo) by uid.
export async function deleteMedia(assetId, kinds, uid) {
  await db.tx('blobs', 'readwrite', async (s) => { for (const k of kinds) s.delete(blobId(k, assetId, uid)); });
}

// Delete an asset and ALL its blobs in a single transaction.
export async function deleteAsset(assetId) {
  await db.tx(['assets', 'blobs'], 'readwrite', (st) => new Promise((resolve, reject) => {
    st.assets.delete(assetId);
    const req = st.blobs.index('asset_id').openKeyCursor(IDBKeyRange.only(assetId));
    req.onsuccess = () => { const c = req.result; if (!c) { resolve(); return; } st.blobs.delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  }));
}

// A saved asset is pending export if never exported or edited after export.
export const isPending = (a) => a.status === 'saved' && (!a.exported_at || a.updated_at > a.exported_at);

export function newDraft({ projectId, inspector, deviceId, context }) {
  const now = nowIso();
  return {
    schema_version: 1, id: crypto.randomUUID(), project_id: projectId, status: 'draft', seq: null,
    inspector: inspector || '', device_id: deviceId, app_version: APP_VERSION,
    created_at: now, updated_at: now,
    building_id: context?.building_id || null, building_code: context?.building_code || '', building_name: context?.building_name || '',
    floor: context?.floor || '', department: context?.department || '', notes: '',
    gps: { lat: null, lon: null, accuracy_m: null }, exported_at: null
  };
}

// ---- Display IDs: {BLDG}-{VALUER}-A{NNN}, consecutive per project + building + valuer ----
const idSafe = (s) => String(s ?? '').trim().replace(/[^\w.]+/g, '-').replace(/^-+|-+$/g, '') || 'SIN-EDIF';
export const idPrefix = (buildingCode, valuer) => `${idSafe(buildingCode)}-${valuer}-A`;
export const formatDisplayId = (buildingCode, valuer, n) => `${idPrefix(buildingCode, valuer)}${String(n).padStart(3, '0')}`;
export function displayIdNumber(displayId, prefix) {
  if (!displayId || !displayId.startsWith(prefix)) return 0;
  const n = Number(displayId.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
// Pure decision (exported for tests): 'new' | 'keep' | 'moved' (building changed after export: keep id).
export function displayIdAction(a, valuer) {
  if (!valuer || !a.building_code) return 'keep';
  if (!a.display_id) return 'new';
  if (a.id_building_key === db.normKey(a.building_code)) return 'keep';
  return a.exported_at ? 'moved' : 'new';
}

// Inside an open transaction on ['settings','assets']: gives `a` its display id if needed (mutates a).
// Next number = max(counter, highest number already used in the project) + 1, so numbers are never
// reused even after a restore or if the counter was lost. Only IDB requests are awaited here.
async function assignDisplayId(st, a, valuer, projectAssets) {
  const action = displayIdAction(a, valuer);
  if (action === 'keep') return;
  if (action === 'moved') { a.moved_from_building_code ??= a.display_id.split('-')[0]; return; }
  if (a.display_id) a.previous_display_ids = [...(a.previous_display_ids || []), a.display_id];
  const prefix = idPrefix(a.building_code, valuer);
  const ctrKey = `ctr|${a.project_id}|${prefix}`;
  const cur = await db.wrap(st.settings.get(ctrKey));
  let max = Number(cur?.value) || 0;
  for (const x of projectAssets) if (x.id !== a.id) max = Math.max(max, displayIdNumber(x.display_id, prefix));
  a.display_id = formatDisplayId(a.building_code, valuer, max + 1);
  a.id_building_key = db.normKey(a.building_code);
  st.settings.put({ key: ctrKey, value: max + 1 });
  projectAssets.push(a);
}

// Gives a display id to saved assets that have none (data migrated from v0.2, or saved before the valuer
// code was set). Does not touch updated_at. Returns how many were assigned.
export async function assignMissingDisplayIds(project) {
  if (!project?.valuer_code) return 0;
  return db.tx(['settings', 'assets'], 'readwrite', async (st) => {
    const all = await db.wrap(st.assets.index('project_id').getAll(IDBKeyRange.only(project.id)));
    const todo = all.filter((a) => a.status === 'saved' && !a.display_id && a.building_code)
      .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || (x.seq ?? 0) - (y.seq ?? 0));
    for (const a of todo) { await assignDisplayId(st, a, project.valuer_code, all); st.assets.put(a); }
    return todo.length;
  });
}

// Atomically: assign seq and display id, store asset as 'saved', update the project's last_context.
export async function saveAsset(asset) {
  return db.tx(['settings', 'assets', 'projects'], 'readwrite', async (st) => {
    const wrap = db.wrap;
    const a = { ...asset, status: 'saved', updated_at: nowIso(), app_version: APP_VERSION };
    if (!a.seq) {
      const cur = await wrap(st.settings.get('seq_counter'));
      a.seq = ((cur && cur.value) || 0) + 1;
      a.created_at = a.updated_at; // stamp on first save so reused drafts don't keep an old date
      st.settings.put({ key: 'seq_counter', value: a.seq });
    }
    const p = await wrap(st.projects.get(a.project_id));
    if (p?.valuer_code && displayIdAction(a, p.valuer_code) !== 'keep') {
      const projectAssets = await wrap(st.assets.index('project_id').getAll(IDBKeyRange.only(a.project_id)));
      await assignDisplayId(st, a, p.valuer_code, projectAssets);
    }
    if (p) st.projects.put({ ...p, last_context: { building_id: a.building_id || null, building_code: a.building_code, building_name: a.building_name, floor: a.floor, department: a.department } });
    st.assets.put(a);
    return a;
  });
}

export const folderName = (a) => (a.display_id ? `${a.display_id}_${a.id.slice(0, 8)}` : `${String(a.building_code || 'SIN-EDIF').replace(/[^\w.-]+/g, '-')}_${String(a.seq ?? 0).padStart(4, '0')}_${a.id.slice(0, 8)}`);
// Short human label for an asset: its display id, or #seq for assets saved without one.
export const assetLabel = (a) => a.display_id || (a.seq ? `#${a.seq}` : 'Nuevo activo');

// Copy an asset into a new DRAFT (same project and location; the user changes the location in the form).
// opts: { notes, audios, photos } booleans. Copied media get new uids and `copied: true`.
export async function copyAsset(sourceId, { notes = true, audios = false, photos = false } = {}, { inspector, deviceId } = {}) {
  const src = await db.get('assets', sourceId);
  if (!src) throw new Error('El activo original ya no existe.');
  const draft = newDraft({ projectId: src.project_id, inspector: inspector || src.inspector, deviceId, context: src });
  draft.notes = notes ? src.notes || '' : '';
  draft.copied_from = { id: src.id, display_id: src.display_id || null };
  const media = [];
  const base = Date.now();
  let k = 0;
  if (photos) {
    const [ph, th] = await Promise.all([getMedia(src.id, 'photo'), getMedia(src.id, 'thumb')]);
    const thumbs = new Map(th.map((t) => [t.uid, t]));
    for (const p of ph) {
      const uid = crypto.randomUUID(); const order = base + k++;
      media.push({ ...p, id: blobId('photo', draft.id, uid), asset_id: draft.id, uid, order, copied: true });
      const t = thumbs.get(p.uid);
      if (t) media.push({ ...t, id: blobId('thumb', draft.id, uid), asset_id: draft.id, uid, order });
    }
  }
  if (audios) {
    for (const x of await getMedia(src.id, 'audio')) {
      const uid = crypto.randomUUID();
      media.push({ ...x, id: blobId('audio', draft.id, uid), asset_id: draft.id, uid, order: base + k++, copied: true });
    }
  }
  await db.tx(['assets', 'blobs'], 'readwrite', (st) => { st.assets.put(draft); for (const m of media) st.blobs.put(m); });
  return draft;
}

// All saved assets of a project (never drafts).
export async function getSavedAssets(projectId) {
  return (await db.getByProject('assets', projectId)).filter((a) => a.status === 'saved');
}
