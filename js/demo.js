// Demo project ("Proyecto Test", v0.3.6): created on first install so a new user can try every screen with
// data before going to the field. Photos are drawn on a canvas (machines and legible nameplates), nothing is
// downloaded. Can be deleted from Proyectos and loaded again at any time.
import * as db from './db.js';
import { nowIso, blobId, saveAsset, newDraft, deleteAsset } from './data.js';
import { createProject, setActiveProject } from './projects.js';

export const DEMO_FLAG = 'demo_seeded';

// ---------------------------------------------------------------- drawing
function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
async function toJpeg(c, q) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality: q });
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}
function noise(g, w, h, alpha = 0.05) {
  for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},${alpha})`; g.fillRect(Math.random() * w, Math.random() * h, 3, 3); }
}
// A machine on a shop floor.
function drawMachine(g, w, h, { body = '#4f7aa8', label = '', kind = 'box' }) {
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#d7dde4'); sky.addColorStop(0.62, '#b9c2cc'); sky.addColorStop(0.62, '#8d8f8f'); sky.addColorStop(1, '#6f7272');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,220,0,.85)'; g.lineWidth = 14; g.beginPath(); g.moveTo(0, h * 0.86); g.lineTo(w, h * 0.80); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(w * 0.5, h * 0.78, w * 0.36, h * 0.05, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = body;
  if (kind === 'lathe') {
    g.fillRect(w * 0.14, h * 0.32, w * 0.72, h * 0.42); g.fillStyle = '#2b3a4a'; g.fillRect(w * 0.2, h * 0.38, w * 0.42, h * 0.22);
    g.fillStyle = '#9fb3c8'; g.fillRect(w * 0.66, h * 0.36, w * 0.16, h * 0.3); g.fillStyle = '#1f2933'; g.fillRect(w * 0.14, h * 0.7, w * 0.72, h * 0.06);
  } else if (kind === 'tank') {
    g.beginPath(); g.ellipse(w * 0.5, h * 0.48, w * 0.3, h * 0.2, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2b3a4a'; g.fillRect(w * 0.24, h * 0.62, w * 0.06, h * 0.12); g.fillRect(w * 0.7, h * 0.62, w * 0.06, h * 0.12);
  } else if (kind === 'rack') {
    g.fillStyle = '#e8740c'; for (let i = 0; i < 4; i++) g.fillRect(w * (0.12 + i * 0.25), h * 0.12, w * 0.025, h * 0.64);
    g.fillStyle = '#2d5fa8'; for (let j = 0; j < 4; j++) g.fillRect(w * 0.12, h * (0.2 + j * 0.15), w * 0.78, h * 0.02);
    g.fillStyle = '#c8a46b'; for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) g.fillRect(w * (0.16 + i * 0.25), h * (0.25 + j * 0.15), w * 0.17, h * 0.1);
  } else if (kind === 'forklift') {
    g.fillRect(w * 0.3, h * 0.4, w * 0.34, h * 0.3); g.fillStyle = '#1f2933'; g.fillRect(w * 0.64, h * 0.22, w * 0.03, h * 0.52); g.fillRect(w * 0.67, h * 0.68, w * 0.16, h * 0.03);
    g.beginPath(); g.arc(w * 0.38, h * 0.72, h * 0.06, 0, Math.PI * 2); g.arc(w * 0.58, h * 0.72, h * 0.06, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#1f2933'; g.lineWidth = 10; g.strokeRect(w * 0.33, h * 0.22, w * 0.24, h * 0.18);
  } else {
    g.fillRect(w * 0.22, h * 0.24, w * 0.56, h * 0.5); g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(w * 0.26, h * 0.28, w * 0.2, h * 0.3);
    g.fillStyle = '#1f2933'; for (let i = 0; i < 6; i++) g.fillRect(w * 0.52, h * (0.3 + i * 0.06), w * 0.22, h * 0.02);
  }
  noise(g, w, h);
  if (label) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, h - 70, w, 70); g.fillStyle = '#fff'; g.font = 'bold 38px sans-serif'; g.fillText(label, 30, h - 22); }
}
// A riveted metal nameplate with legible text.
function drawPlate(g, w, h, lines) {
  g.fillStyle = '#3d4248'; g.fillRect(0, 0, w, h); noise(g, w, h, 0.06);
  const px = w * 0.08, py = h * 0.1, pw = w * 0.84, ph = h * 0.8;
  const metal = g.createLinearGradient(px, py, px + pw, py + ph);
  metal.addColorStop(0, '#e9ecef'); metal.addColorStop(0.5, '#c5ccd3'); metal.addColorStop(1, '#dde2e7');
  g.fillStyle = metal; g.fillRect(px, py, pw, ph);
  g.strokeStyle = '#6b7280'; g.lineWidth = 6; g.strokeRect(px + 10, py + 10, pw - 20, ph - 20);
  g.fillStyle = '#7b8189'; for (const [x, y] of [[px + 26, py + 26], [px + pw - 26, py + 26], [px + 26, py + ph - 26], [px + pw - 26, py + ph - 26]]) { g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#111827'; g.font = `bold ${Math.round(h * 0.075)}px sans-serif`; g.fillText(lines[0], px + 60, py + h * 0.13);
  g.font = `${Math.round(h * 0.052)}px monospace`;
  lines.slice(1).forEach((l, i) => g.fillText(l, px + 60, py + h * (0.24 + i * 0.085)));
  g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(px, py); g.lineTo(px + pw * 0.35, py); g.lineTo(px, py + ph * 0.5); g.fill();
}
async function makePhoto(ownerId, spec, i, now) {
  const W = 1600, H = 1200;
  const c = canvas(W, H); const g = c.getContext('2d');
  if (spec.plate) drawPlate(g, W, H, spec.plate); else drawMachine(g, W, H, spec);
  const blob = await toJpeg(c, 0.86);
  const t = canvas(300, 225); t.getContext('2d').drawImage(c, 0, 0, 300, 225);
  const thumb = await toJpeg(t, 0.7);
  const uid = crypto.randomUUID(); const order = Date.now() + i;
  return [
    { id: blobId('photo', ownerId, uid), asset_id: ownerId, kind: 'photo', uid, blob, mime_type: 'image/jpeg', ext: 'jpg', source: 'camera', is_screenshot: false, width: W, height: H, bytes: blob.size, resized: false, captured_at: now, order, tag: spec.tag || null, demo: true },
    { id: blobId('thumb', ownerId, uid), asset_id: ownerId, kind: 'thumb', uid, blob: thumb, mime_type: 'image/jpeg', order }
  ];
}

// ---------------------------------------------------------------- data
const DEPTS = ['Maquinado', 'Ensamble', 'Pintura', 'Almacén', 'Mantenimiento', 'Servicios'];
const BUILDINGS = [
  { code: 'B1', name: 'NAVE DE PRODUCCIÓN', inspected: true, photo: { kind: 'box', body: '#8a96a3', label: 'B1 · Fachada norte', tag: 'general' },
    fields: { occupancy: 'PRODUCTION', year_built: '1998', storeys: '1 + MEZZANINE', height: { value: 9.5, unit: 'm', expr: null }, gfa: { value: 6480, unit: 'm2', expr: '120*54' }, mezzanine_area: { value: 180, unit: 'm2', expr: '12*15' }, perimeter: { value: 348, unit: 'm', expr: '2*(120+54)' },
      frame: 'STEEL', ground_floor: 'REINFORCED CONCRETE', intermediate_floors: 'STEEL JOIST AND DECK', walls: 'INSULATED METAL PANELS', roof: 'METAL CLADDING', sustainability: 'N/A', iso_code: '3 - NONCOMBUSTIBLE', fire_protection: 'SPRINKLED', fire_protection_pct: 100, hvac_category: 'COOLING ONLY', hvac_type: 'VENTILATION ONLY, WITH DUCTS & BLOWERS', plumbing: 'YES', electrical: 'YES', elevators: 'NO' },
    notes: 'Nave principal. Ampliación en 2012 hacia el lado sur (crujía de 24 m). Cubierta con algunas filtraciones en la esquina noreste.' },
  { code: 'B2', name: 'ALMACÉN DE PRODUCTO TERMINADO', photo: { kind: 'rack', label: 'B2 · Interior', tag: 'general' },
    fields: { occupancy: 'STORAGE', year_built: '2005', frame: 'STEEL', walls: 'PRECAST CONCRETE PANELS', height: { value: 11, unit: 'm', expr: null } }, notes: 'Falta medir perímetro y revisar sistema contra incendio.' },
  { code: 'B3', name: 'OFICINAS ADMINISTRATIVAS', fields: { occupancy: 'OFFICES', year_built: '1998', storeys: '2', gfa_rounded: { value: 9000, unit: 'ft2', expr: null } } },
  { code: 'B4', name: 'CUARTO DE MÁQUINAS', fields: { occupancy: 'UTILITIES' } },
  { code: 'B5', name: 'CASETA DE VIGILANCIA', fields: {} }
];
const ASSETS = [
  { b: 'B1', floor: '1', dept: 'Maquinado', notes: 'Torno CNC horizontal, bancada de 3 m. Buen estado, en operación. Incluye transportador de rebaba.', photos: [{ kind: 'lathe', body: '#3f6fa3', label: 'Torno CNC', tag: 'general' }, { tag: 'placa', plate: ['HAAS AUTOMATION', 'MODELO: ST-30Y', 'SERIE: 3112457', 'AÑO: 2019', '480 V  3 PH  60 Hz', 'POTENCIA: 30 HP'] }] },
  { b: 'B1', floor: '1', dept: 'Maquinado', notes: 'Centro de maquinado vertical 3 ejes con cambiador de 24 herramientas.', photos: [{ kind: 'box', body: '#2f6b5a', label: 'Centro de maquinado', tag: 'general' }, { tag: 'placa', plate: ['DMG MORI', 'MODELO: NVX 5080', 'SERIE: NV508-21-0387', 'AÑO: 2021', '440 V  3 PH  60 Hz', 'PESO: 7,800 kg'] }] },
  { b: 'B1', floor: '1', dept: 'Ensamble', notes: 'Compresor de tornillo con secador. La placa está detrás, no se alcanzó.', photos: [{ kind: 'tank', body: '#2c7a3f', label: 'Compresor', tag: 'general' }] },
  { b: 'B1', floor: 'MEZZANINE 1', dept: 'Pintura', notes: 'Cabina de pintura presurizada 6 x 4 m, filtros nuevos.', photos: [{ kind: 'box', body: '#b45309', label: 'Cabina de pintura' }] },
  { b: 'B2', floor: '1', dept: 'Almacén', notes: 'Montacargas eléctrico, batería 48 V, horómetro 6,250 h.', photos: [{ kind: 'forklift', body: '#e0a100', label: 'Montacargas', tag: 'general' }, { tag: 'placa', plate: ['TOYOTA', 'MODELO: 8FBE20U', 'SERIE: 8FBE20U-61234', 'AÑO: 2018', 'CAPACIDAD: 4,000 lb', 'BATERÍA: 48 V'] }] },
  { b: 'B2', floor: '1', dept: 'Almacén', notes: 'Rack selectivo 6 niveles, 40 secciones aprox. Falta foto.', photos: [] },
  { b: 'B4', floor: '1', dept: 'Mantenimiento', notes: 'Subestación eléctrica compacta.', photos: [{ kind: 'box', body: '#5b6470', label: 'Subestación', tag: 'general' }, { tag: 'placa', plate: ['SCHNEIDER ELECTRIC', 'TRANSFORMADOR 1000 kVA', 'SERIE: TR-88412', 'AÑO: 2010', '13.2 kV / 480-277 V', 'ENFRIAMIENTO: ONAN'] }] },
  { b: 'B4', floor: '1', dept: 'Servicios', notes: 'Bomba contra incendio con motor diésel, cuarto de bombas.', photos: [{ kind: 'tank', body: '#b91c1c', label: 'Bomba contra incendio' }] }
];

// Create the demo project and make it the active one. Returns the project.
export async function seedDemo({ inspector = '', deviceId = null } = {}) {
  const now = nowIso();
  const project = await createProject({ name: 'Proyecto Test', client: 'Cliente de ejemplo', site: 'Planta demo', units: 'imperial', valuer_code: 'TS', demo: true });
  const pid = project.id;
  // Buildings (+ their photos).
  const bByCode = {};
  const blobs = [];
  let k = 0;
  for (const b of BUILDINGS) {
    const rec = { id: crypto.randomUUID(), project_id: pid, code: b.code, code_key: db.normKey(b.code), name: b.name, fields: b.fields, notes: b.notes || '', source: 'demo', created_at: now, updated_at: now, ...(b.photo ? { field_updated_at: now } : {}), ...(b.inspected ? { inspected_at: now } : {}) };
    bByCode[b.code] = rec;
    if (b.photo) blobs.push(...await makePhoto(rec.id, b.photo, k++, now));
  }
  await db.tx(['buildings', 'departments', 'blobs'], 'readwrite', (st) => {
    for (const b of Object.values(bByCode)) st.buildings.put(b);
    for (const d of DEPTS) st.departments.put({ id: db.departmentId(pid, db.normKey(d)), project_id: pid, key: db.normKey(d), name: d });
    for (const x of blobs) st.blobs.put(x);
  });
  // Assets: draft -> photos -> saveAsset (gets B1-TS-A001… like a real capture).
  for (const a of ASSETS) {
    const b = bByCode[a.b];
    const draft = newDraft({ projectId: pid, inspector: inspector || 'Demo', deviceId, context: { building_id: b.id, building_code: b.code, building_name: b.name, floor: a.floor, department: a.dept } });
    draft.notes = a.notes;
    const media = [];
    for (const p of a.photos) media.push(...await makePhoto(draft.id, p, k++, now));
    await db.tx(['assets', 'blobs'], 'readwrite', (st) => { st.assets.put(draft); for (const m of media) st.blobs.put(m); });
    await saveAsset(draft);
  }
  // A copy, like "Copiar" in the app: same compressor model in another department.
  const comp = (await db.getByProject('assets', pid)).find((x) => /Compresor/.test(x.notes));
  if (comp) {
    const copy = newDraft({ projectId: pid, inspector: inspector || 'Demo', deviceId, context: { ...comp, department: 'Mantenimiento' } });
    copy.notes = comp.notes + ' (Equipo gemelo en mantenimiento.)';
    copy.copied_from = { id: comp.id, display_id: comp.display_id };
    await db.put('assets', copy);
    await saveAsset(copy);
  }
  await setActiveProject(pid);
  await db.setSetting(DEMO_FLAG, true);
  return db.get('projects', pid);
}

// Delete a project and everything in it (used for the demo project).
export async function deleteProjectData(pid) {
  const [assets, buildings] = await Promise.all([db.getByProject('assets', pid), db.getByProject('buildings', pid)]);
  for (const a of assets) await deleteAsset(a.id);           // asset + its blobs
  for (const b of buildings) await deleteAsset(b.id);        // building media (same blob index); no asset record exists
  await Promise.all([db.deleteByProject('buildings', pid), db.deleteByProject('departments', pid), db.deleteByProject('lists', pid)]);
  await db.del('projects', pid);
  if ((await db.getSetting('active_project', null)) === pid) await db.setSetting('active_project', null);
}
