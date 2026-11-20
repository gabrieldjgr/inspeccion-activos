// AI-oriented export (v0.3 F4). One predictable layout, one index that links every record to its files,
// a README for the AI that processes it, SHA-256 per file and parts that keep buildings whole.
//
// {B1}_{building-slug}/B1_edificio.json · B1_foto_01_general.jpg · B1_audio_01.m4a · B1_notas.txt
// {B1}_{building-slug}/activos/B1-GA-A001/B1-GA-A001.json · B1-GA-A001_foto_01_placa.jpg · …_audio_01.m4a · …_notas.txt
// indice.json (all records of the export, with paths and part numbers) · activos.csv · edificios.csv · archivos.csv
// manifest.json (this part: files with sha256 and bytes) · README_IA.md
import * as db from './db.js';
import { APP_VERSION } from './version.js';
import { csvEscape } from './csv.js';
import { getSavedAssets, getMedia, isPending, nowIso, mediaIndex, countsOf, assetLabel } from './data.js';
import { projectSlug } from './projects.js';
import { FIELDS, DATA_FIELDS, headerFor, measureIn, buildingStatus, projectUnit } from './bldg-schema.js';
import { createZipWriter, fileStamp, partitionBySize, extOf, readBlobBytes, sha256Hex } from './ziputil.js';

export const EXPORT_SCHEMA_VERSION = 2;
const RECORD_OVERHEAD = 6144; // bytes of json/txt per record for part planning

// ---------------------------------------------------------------- pure helpers (Node-testable)
const slug = (s, max = 40) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, max);
export const safeName = (s) => String(s || 'SIN-CODIGO').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'SIN-CODIGO';
export const buildingFolder = (code, name) => { const s = slug(name, 40); return safeName(code) + (s ? '_' + s : ''); };

// File names of the media of a record (photos/audios sorted by order), always prefixed with the record id.
export function namesFor(prefix, photos, audios) {
  let f = 0; let c = 0; let a = 0;
  const num = (n) => String(n).padStart(2, '0');
  const sfx = (m) => `${m.tag ? '_' + String(m.tag).replace(/[^\w]/g, '') : ''}${m.copied ? '_copia' : ''}`;
  return {
    photoNames: photos.map((p) => (p.source === 'gallery' && p.is_screenshot ? `${prefix}_captura_${num(++c)}${sfx(p)}.${extOf(p, 'png')}` : `${prefix}_foto_${num(++f)}${sfx(p)}.${extOf(p, 'jpg')}`)),
    audioNames: audios.map((x) => `${prefix}_audio_${num(++a)}${sfx(x)}.${extOf(x, 'webm')}`)
  };
}

// Quality flags for the AI and for the pre-export alert.
export function assetWarnings(a, photos, audios) {
  const w = [];
  if (!photos.length) w.push('sin_foto');
  if (!String(a.notes || '').trim() && !audios.length) w.push('sin_nota');
  if (photos.length && !photos.some((p) => p.tag === 'placa')) w.push('sin_placa');
  if (a.copied_from && !photos.some((p) => !p.copied)) w.push('copia_sin_fotos_propias');
  return w;
}

// Field value as in the Excel: measures in project units, % as a fraction (1 = 100 %).
export function excelValue(f, b, units) {
  if (f.key === 'code') return b.code;
  if (f.key === 'name') return b.name;
  const v = b.fields?.[f.key];
  if (v == null || v === '') return null;
  if (f.type === 'area' || f.type === 'length') return measureIn(v, f.type, units);
  if (f.type === 'percent') return Math.round((Number(v) / 100) * 10000) / 10000;
  return v;
}

const crlf = (s) => String(s ?? '').replace(/\r?\n/g, '\r\n');
const notesText = (s) => crlf(s) + '\r\n';
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';

export function filterAssets(assets, scope) {
  return assets.filter((a) => {
    if (a.status !== 'saved') return false;
    switch (scope.type) {
      case 'pending': return isPending(a);
      case 'building': return a.building_code === scope.building_code;
      case 'dates': { const d = String(a.created_at || '').slice(0, 10); return (!scope.from || d >= scope.from) && (!scope.to || d <= scope.to); }
      default: return true;
    }
  });
}
const buildingHasContent = (b, c) => !!(c.photo || c.audio || String(b.notes || '').trim() || (b.fields && Object.keys(b.fields).length) || b.inspected_at);
const buildingPending = (b) => !b.exported_at || String(b.updated_at || '') > String(b.exported_at);
function buildingInScope(b, c, scope) {
  if (!buildingHasContent(b, c)) return false;
  switch (scope.type) {
    case 'pending': return buildingPending(b);
    case 'building': return b.code === scope.building_code;
    case 'dates': { const d = String(b.updated_at || '').slice(0, 10); return (!scope.from || d >= scope.from) && (!scope.to || d <= scope.to); }
    default: return true;
  }
}

export const partFileName = (projectSlugTxt, who, stamp, n, total) => `inspeccion_${projectSlugTxt}_${who}_${stamp}_parte${n}de${total}.zip`;

// ---------------------------------------------------------------- tombstones (records deleted after export)
const tombKey = (pid) => `tombstones|${pid}`;
export async function addTombstone(asset) {
  if (!asset?.exported_at) return; // never exported: the AI never saw it
  const list = await db.getSetting(tombKey(asset.project_id), []);
  list.push({ type: 'asset', id: asset.id, display_id: asset.display_id || null, deleted_at: nowIso(), exported_at: null });
  await db.setSetting(tombKey(asset.project_id), list);
}
async function pendingTombstones(pid, all) {
  const list = await db.getSetting(tombKey(pid), []);
  return all ? list : list.filter((t) => !t.exported_at);
}
async function markTombstones(pid, ids, at) {
  if (!ids.length) return;
  const list = await db.getSetting(tombKey(pid), []);
  await db.setSetting(tombKey(pid), list.map((t) => (ids.includes(t.id) ? { ...t, exported_at: at } : t)));
}

async function markExported(store, entries, exportedAt) {
  if (!entries.length) return;
  await db.tx(store, 'readwrite', (s) => new Promise((resolve, reject) => {
    let left = entries.length;
    for (const e of entries) {
      const g = s.get(e.id);
      g.onsuccess = () => { const r = g.result; if (r && r.updated_at === e.updated_at) s.put({ ...r, exported_at: exportedAt }); if (--left === 0) resolve(); };
      g.onerror = () => reject(g.error);
    }
  }));
}

// ---------------------------------------------------------------- pre-export review
// Counts what the AI will miss, for the alert shown before exporting.
export async function reviewExport(project, scope) {
  const [all, buildings, media] = await Promise.all([getSavedAssets(project.id), db.getByProject('buildings', project.id), mediaIndex()]);
  const assets = filterAssets(all, scope);
  const out = { assets: assets.length, buildings: 0, noPhoto: 0, noNote: 0, noPlate: 0, bNoPhoto: 0, bNotInspected: 0 };
  for (const a of assets) {
    const c = countsOf(media, a.id);
    if (!c.photo) out.noPhoto++;
    if (!String(a.notes || '').trim() && !c.audio) out.noNote++;
  }
  // "sin placa" needs tags: only read photo records of assets that have photos.
  for (const a of assets) { if (countsOf(media, a.id).photo) { const ph = await getMedia(a.id, 'photo'); if (!ph.some((p) => p.tag === 'placa')) out.noPlate++; } }
  for (const b of buildings) {
    const c = countsOf(media, b.id);
    if (buildingInScope(b, c, scope)) out.buildings++;
    if (!c.photo) out.bNoPhoto++;
    if (buildingStatus(b, c) !== 'inspected') out.bNotInspected++;
  }
  return out;
}

// ---------------------------------------------------------------- README for the AI
export function readmeIA({ project, units, mode, exportedAt, totalParts, counts }) {
  const area = units === 'metric' ? 'm²' : 'ft²';
  const len = units === 'metric' ? 'm' : 'ft';
  return `# Levantamiento de campo — instrucciones para la IA que procesa este ZIP

Proyecto: **${project.name}**${project.client ? ` · Cliente: ${project.client}` : ''}${project.site ? ` · Planta: ${project.site}` : ''}
Exportado: ${exportedAt} · App: Inspección de Activos ${APP_VERSION} · Esquema: ${EXPORT_SCHEMA_VERSION}
Modo: **${mode === 'incremental' ? 'incremental (solo lo nuevo o editado desde la exportación anterior)' : 'completo'}** · Partes: ${totalParts}
Contenido: ${counts.assets} activos, ${counts.buildings} edificios con datos de campo, ${counts.files} archivos.

## Qué es
Un valuador (MRICS) recorrió una planta industrial y capturó **evidencia en bruto**: fotos (vistas generales, placas de identificación, detalles), notas de voz y notas de texto, organizadas por **proyecto → edificio → activo**, con piso y departamento. Los activos (maquinaria y equipo) **no** traen datos técnicos estructurados: tu trabajo es extraerlos de la evidencia. Los edificios sí traen datos estructurados (formato del Excel de levantamiento), que puedes completar con la evidencia.

## Cómo leerlo
1. Empieza por **\`indice.json\`**: tiene todos los registros de esta exportación con la ruta (relativa a la raíz del ZIP) de cada archivo y la parte del ZIP donde está (\`part\`). No necesitas recorrer carpetas.
2. Las mismas tablas en CSV (UTF-8 con BOM): \`activos.csv\`, \`edificios.csv\` (33 columnas idénticas al Excel de levantamiento + columnas de la app), \`archivos.csv\` (un archivo por fila).
3. \`manifest.json\` lista los archivos de **esta parte** con su SHA-256 y tamaño para verificar integridad.
4. Si hay varias partes, cada una trae el índice completo; junta las carpetas de todas las partes (no se repiten archivos).

## Identificadores
- Activo: \`display_id\` = \`{EDIFICIO}-{VALUADOR}-A{NNN}\` (p. ej. \`B1-GA-A001\`). Es único en el proyecto aunque varios valuadores trabajen a la vez (cada uno tiene su código). \`id\` es un UUID estable: úsalo para cruzar exportaciones.
- \`previous_display_ids\`: IDs que tuvo el activo antes de cambiarlo de edificio (antes de exportarse).
- \`moved_from_building_code\`: el activo cambió de edificio después de exportarse; conserva su ID original.
- Edificio: \`code\` (AI Bldg #, p. ej. B1) e \`id\` (UUID).
- Todos los nombres de archivo empiezan con el ID de su registro: siguen siendo únicos si se aplana el ZIP.

## Fotos
- JPEG (las capturas de pantalla, PNG). Lado largo 3072 px; las marcadas **placa** se guardan a resolución completa para leer texto pequeño.
- \`tag\` / sufijo del nombre: \`placa\` (placa de identificación: marca, modelo, número de serie, capacidad, año, voltaje…), \`general\` (vista general), \`detalle\`; sin sufijo = sin clasificar (puede ser cualquiera).
- \`copied: true\` / sufijo \`_copia\`: foto copiada de otro activo similar; **no es evidencia de este equipo** (no tomes de ahí serie ni placa).

## Notas de voz
- \`.m4a\` (AAC) o \`.webm\` (Opus), en **español**, grabadas en planta (puede haber ruido). \`duration_s\` en segundos. Transcríbelas; suelen describir el equipo, su estado y datos que no se ven en las fotos.

## Notas de texto
- Campo \`notes\` y archivo \`*_notas.txt\` (UTF-8). Escritas rápido en campo: abreviaturas y errores de dedo son normales.

## Activos copiados
- \`copied_from\` = ID del activo original. El valuador indicó que es un equipo **similar** (otro edificio/departamento). Usa el original como referencia, pero los datos propios (serie, placa, estado) deben salir solo de la evidencia del activo copiado. \`copia_sin_fotos_propias\` en \`warnings\` = no hay fotos propias.

## Avisos por registro (\`warnings\`)
\`sin_foto\`, \`sin_nota\` (ni texto ni voz), \`sin_placa\` (hay fotos pero ninguna marcada como placa: búscala entre las no clasificadas), \`copia_sin_fotos_propias\`. Repórtalos al valuador si impiden completar el inventario.

## Edificios
- \`fields\`: columnas del Excel en unidades del proyecto (**${area}** para áreas, **${len}** para longitudes); \`fire_protection_pct\` como fracción (1 = 100 %). Vacío = no capturado (\`null\`), no "cero".
- \`measures\`: valor tal como se capturó (unidad original y la **operación**, p. ej. \`45.5*10.5 + 85*108.5\` en m²) y su conversión.
- Columnas "Rounded" y "Total": normalmente vienen de la precarga u oficina.
- \`status\`: pending (nada capturado en campo), in_progress, inspected (el valuador lo marcó; tiene al menos una foto).
- Los campos vacíos pueden completarse con las fotos, audios y notas del edificio.

## Exportaciones incrementales y borrados
- En modo incremental vienen solo registros nuevos o editados (\`updated_at\` posterior a la exportación anterior). Un registro con el mismo \`id\` reemplaza al anterior.
- \`deleted\` en \`indice.json\`: registros que el valuador borró después de haberlos exportado; elimínalos de tu inventario.

## Fechas y ubicación
- Fechas ISO 8601 con zona horaria local del teléfono. \`gps\` (lat, lon, precisión en m) si el valuador lo activó; \`null\` si no.
`;
}

// ---------------------------------------------------------------- export
// opts: { scope, maxPartBytes, onProgress(done,total,label), onPart({n,total,name,blob,nAssets,nBuildings}) }
export async function exportForAI(h, opts) {
  const { scope, maxPartBytes, onProgress, onPart } = opts;
  const project = h.state.project;
  const pid = project.id;
  const units = project.units || 'imperial';
  const mode = scope.type === 'pending' ? 'incremental' : scope.type === 'all' ? 'full' : scope.type;
  const [allAssets, buildings, media, inspector] = await Promise.all([getSavedAssets(pid), db.getByProject('buildings', pid), mediaIndex(), db.getSetting('inspector', '')]);
  buildings.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }));
  const assets = filterAssets(allAssets, scope).sort((a, b) => String(a.building_code).localeCompare(String(b.building_code), 'es', { numeric: true }) || String(a.display_id || '').localeCompare(String(b.display_id || ''), 'es', { numeric: true }) || String(a.created_at).localeCompare(String(b.created_at)));
  const tombs = await pendingTombstones(pid, mode === 'full');
  const bById = new Map(buildings.map((b) => [b.id, b]));
  const bByKey = new Map(buildings.map((b) => [b.code_key, b]));
  const buildingOf = (a) => bById.get(a.building_id) || bByKey.get(db.normKey(a.building_code)) || null;
  const nAssetsOf = (b) => allAssets.filter((a) => buildingOf(a) === b).length;

  // ---- groups: one per building (building record + its assets in scope)
  const groups = new Map();
  const groupFor = (key, b, code, name) => {
    if (!groups.has(key)) groups.set(key, { key, b, code, name, folder: buildingFolder(code, name), buildingItem: null, assetItems: [] });
    return groups.get(key);
  };
  const exportedAt = nowIso();
  const totalSteps = buildings.length + assets.length;
  let step = 0;
  for (const b of buildings) {
    onProgress?.(step++, totalSteps, 'Preparando…');
    const c = countsOf(media, b.id);
    if (!buildingInScope(b, c, scope)) continue;
    const [photos, audios] = await Promise.all([getMedia(b.id, 'photo'), getMedia(b.id, 'audio')]);
    const g = groupFor(b.id, b, b.code, b.name);
    g.buildingItem = { kind: 'building', b, photos, audios, names: namesFor(safeName(b.code), photos, audios), status: buildingStatus(b, c) };
  }
  for (const a of assets) {
    onProgress?.(step++, totalSteps, 'Preparando…');
    const b = buildingOf(a);
    const g = groupFor(b ? b.id : 'code:' + db.normKey(a.building_code), b, b ? b.code : a.building_code, b ? b.name : a.building_name);
    const [photos, audios] = await Promise.all([getMedia(a.id, 'photo'), getMedia(a.id, 'audio')]);
    const label = safeName(assetLabel(a).replace(/^#/, 'N'));
    g.assetItems.push({ kind: 'asset', a, photos, audios, label, names: namesFor(label, photos, audios), warnings: assetWarnings(a, photos, audios) });
  }
  const groupList = [...groups.values()].sort((x, y) => String(x.code).localeCompare(String(y.code), 'es', { numeric: true }));
  if (!groupList.length && !tombs.length) return { parts: 0, assets: 0, buildings: 0 };

  // ---- paths and sizes
  const itemSize = (it) => RECORD_OVERHEAD + it.photos.reduce((s, p) => s + (p.blob?.size || 0), 0) + it.audios.reduce((s, x) => s + (x.blob?.size || 0), 0);
  for (const g of groupList) {
    if (g.buildingItem) { const it = g.buildingItem; it.dir = `${g.folder}/`; it.size = itemSize(it); }
    for (const it of g.assetItems) { it.dir = `${g.folder}/activos/${it.label}/`; it.size = itemSize(it); }
  }
  // ---- parts: whole buildings when they fit, otherwise split that building record by record
  const units_ = [];
  for (const g of groupList) {
    const items = [...(g.buildingItem ? [g.buildingItem] : []), ...g.assetItems];
    const size = items.reduce((s, it) => s + it.size, 0);
    if (size <= maxPartBytes) units_.push({ size, items }); else for (const it of items) units_.push({ size: it.size, items: [it] });
  }
  const parts = partitionBySize(units_.length ? units_ : [{ size: 0, items: [] }], maxPartBytes).map((u) => u.flatMap((x) => x.items));
  const totalParts = parts.length;
  parts.forEach((items, i) => items.forEach((it) => { it.part = i + 1; }));

  // ---- index (complete, identical in every part)
  const fileRows = [];
  const fileEntry = (it, kind, rec, name, ownerType, ownerId, ownerLabel) => {
    const path = it.dir + name;
    fileRows.push({ path, part: it.part, owner_type: ownerType, owner_id: ownerId, owner_label: ownerLabel, kind, tag: rec.tag || '', copied: !!rec.copied, mime_type: rec.mime_type || '', bytes: rec.bytes ?? rec.blob?.size ?? '', captured_at: rec.captured_at || rec.recorded_at || '' });
    return path;
  };
  const indexBuildings = [];
  for (const g of groupList) {
    const it = g.buildingItem;
    if (!it) continue;
    const b = it.b;
    const fields = {}; const measures = {};
    for (const f of DATA_FIELDS) {
      fields[f.key] = excelValue(f, b, units);
      const v = b.fields?.[f.key];
      if ((f.type === 'area' || f.type === 'length') && v) measures[f.key] = { value: v.value, unit: v.unit, expression: v.expr || null, value_in_project_units: measureIn(v, f.type, units), project_unit: projectUnit(f.type, units) };
    }
    it.doc = {
      type: 'building', schema_version: EXPORT_SCHEMA_VERSION, id: b.id, code: b.code, name: b.name, folder: g.folder + '/', part: it.part,
      status: it.status, inspected_at: b.inspected_at || null, source: b.source || null, created_by: b.created_by || null,
      created_at: b.created_at || null, updated_at: b.updated_at || null, units, fields, measures,
      notes: b.notes || '', notes_file: it.dir + `${safeName(b.code)}_notas.txt`, json_file: it.dir + `${safeName(b.code)}_edificio.json`, n_assets: nAssetsOf(b),
      photos: it.photos.map((p, i) => ({ path: fileEntry(it, 'photo', p, it.names.photoNames[i], 'building', b.id, b.code), tag: p.tag || null, width: p.width ?? null, height: p.height ?? null, captured_at: p.captured_at ?? null })),
      audios: it.audios.map((x, i) => ({ path: fileEntry(it, 'audio', x, it.names.audioNames[i], 'building', b.id, b.code), mime_type: x.mime_type ?? null, duration_s: x.duration_s ?? null, recorded_at: x.recorded_at ?? null }))
    };
    indexBuildings.push(it.doc);
  }
  const indexAssets = [];
  for (const g of groupList) {
    for (const it of g.assetItems) {
      const a = it.a;
      it.doc = {
        type: 'asset', schema_version: EXPORT_SCHEMA_VERSION, display_id: a.display_id || null, id: a.id, part: it.part, folder: it.dir,
        building_id: g.b ? g.b.id : null, building_code: a.building_code || '', building_name: a.building_name || '', floor: a.floor || '', department: a.department || '',
        notes: a.notes || '', notes_file: it.dir + `${it.label}_notas.txt`, json_file: it.dir + `${it.label}.json`,
        inspector: a.inspector || '', device_id: a.device_id || null, created_at: a.created_at, updated_at: a.updated_at,
        gps: a.gps && a.gps.lat != null ? a.gps : null,
        copied_from: a.copied_from ? a.copied_from.display_id || a.copied_from.id : null,
        previous_display_ids: a.previous_display_ids || [], moved_from_building_code: a.moved_from_building_code || null,
        warnings: it.warnings,
        photos: it.photos.map((p, i) => ({ path: fileEntry(it, 'photo', p, it.names.photoNames[i], 'asset', a.id, it.label), tag: p.tag || null, copied: !!p.copied, source: p.source || 'camera', width: p.width ?? null, height: p.height ?? null, captured_at: p.captured_at ?? null })),
        audios: it.audios.map((x, i) => ({ path: fileEntry(it, 'audio', x, it.names.audioNames[i], 'asset', a.id, it.label), copied: !!x.copied, mime_type: x.mime_type ?? null, duration_s: x.duration_s ?? null, recorded_at: x.recorded_at ?? null }))
      };
      indexAssets.push(it.doc);
    }
  }
  const projectInfo = { id: project.id, name: project.name, client: project.client || '', site: project.site || '', units };
  const index = {
    schema_version: EXPORT_SCHEMA_VERSION, generated_by: `Inspección de Activos ${APP_VERSION}`, exported_at: exportedAt, mode, scope,
    project: projectInfo, valuer_code: project.valuer_code || null, inspector, device_id: h.state.deviceId, total_parts: totalParts,
    counts: { assets: indexAssets.length, buildings: indexBuildings.length, files: fileRows.length, deleted: tombs.length },
    buildings: indexBuildings, assets: indexAssets,
    all_buildings: buildings.map((b) => ({ id: b.id, code: b.code, name: b.name, status: buildingStatus(b, countsOf(media, b.id)), included: indexBuildings.some((x) => x.id === b.id) })),
    deleted: tombs.map(({ exported_at: _e, ...t }) => t)
  };
  const indexJson = JSON.stringify(index, null, 2);
  const assetsCsv = csv([
    ['display_id', 'id', 'building_code', 'building_name', 'floor', 'department', 'notes', 'n_photos', 'n_audios', 'photo_tags', 'warnings', 'copied_from', 'previous_display_ids', 'created_at', 'updated_at', 'inspector', 'gps_lat', 'gps_lon', 'gps_accuracy_m', 'folder', 'part'],
    ...indexAssets.map((d) => [d.display_id, d.id, d.building_code, d.building_name, d.floor, d.department, d.notes, d.photos.length, d.audios.length, d.photos.map((p) => p.tag).filter(Boolean).join(' '), d.warnings.join(' '), d.copied_from, d.previous_display_ids.join(' '), d.created_at, d.updated_at, d.inspector, d.gps?.lat, d.gps?.lon, d.gps?.accuracy_m, d.folder, d.part])
  ]);
  const bRows = buildings.map((b) => { const c = countsOf(media, b.id); return { b, c }; });
  const buildingsCsv = csv([
    [...FIELDS.map((f) => headerFor(f, units).replace(/\n/g, ' ')), 'building_id', 'status', 'inspected_at', 'n_photos', 'n_audios', 'n_assets', 'source', 'notes', 'folder', 'part'],
    ...bRows.map(({ b, c }) => { const d = indexBuildings.find((x) => x.id === b.id); return [...FIELDS.map((f) => excelValue(f, b, units)), b.id, buildingStatus(b, c), b.inspected_at || '', c.photo, c.audio, nAssetsOf(b), b.source || '', b.notes || '', d ? d.folder : '', d ? d.part : '']; })
  ]);
  const filesCsv = csv([['path', 'part', 'owner_type', 'owner_id', 'owner_label', 'kind', 'tag', 'copied', 'mime_type', 'bytes', 'captured_at'], ...fileRows.map((r) => [r.path, r.part, r.owner_type, r.owner_id, r.owner_label, r.kind, r.tag, r.copied ? 1 : 0, r.mime_type, r.bytes, r.captured_at])]);
  const readme = readmeIA({ project: projectInfo, units, mode, exportedAt, totalParts, counts: index.counts });

  // ---- write parts
  const stamp = fileStamp(new Date());
  const who = project.valuer_code || String(h.state.deviceId || 'sin-id').slice(0, 8);
  let done = 0;
  const totalItems = parts.reduce((s, p) => s + p.length, 0);
  for (let p = 0; p < totalParts; p++) {
    const w = createZipWriter();
    const manifestFiles = [];
    const addText = async (name, text) => { const u8 = new TextEncoder().encode(text); w.addText(name, text); manifestFiles.push({ path: name, bytes: u8.length, sha256: await sha256Hex(u8) }); };
    const addBin = async (name, u8) => { w.addStored(name, u8); manifestFiles.push({ path: name, bytes: u8.length, sha256: await sha256Hex(u8) }); };
    await addText('README_IA.md', readme);
    await addText('indice.json', indexJson);
    await addText('activos.csv', assetsCsv);
    await addText('edificios.csv', buildingsCsv);
    await addText('archivos.csv', filesCsv);
    const marksA = []; const marksB = [];
    for (const it of parts[p]) {
      onProgress?.(done, totalItems, `Parte ${p + 1} de ${totalParts}`);
      await addText(it.doc.json_file, JSON.stringify(it.doc, null, 2));
      await addText(it.doc.notes_file, notesText(it.kind === 'building' ? it.b.notes : it.a.notes));
      for (let i = 0; i < it.photos.length; i++) await addBin(it.doc.photos[i].path, await readBlobBytes(it.photos[i]));
      for (let i = 0; i < it.audios.length; i++) await addBin(it.doc.audios[i].path, await readBlobBytes(it.audios[i]));
      if (it.kind === 'building') marksB.push({ id: it.b.id, updated_at: it.b.updated_at }); else marksA.push({ id: it.a.id, updated_at: it.a.updated_at });
      done++;
      onProgress?.(done, totalItems, `Parte ${p + 1} de ${totalParts}`);
    }
    w.addText('manifest.json', JSON.stringify({
      schema_version: EXPORT_SCHEMA_VERSION, generated_by: `Inspección de Activos ${APP_VERSION}`, exported_at: exportedAt, mode,
      project: projectInfo, valuer_code: project.valuer_code || null, part: p + 1, total_parts: totalParts,
      n_assets: marksA.length, n_buildings: marksB.length, files: manifestFiles
    }, null, 2));
    const chunks = await w.finish();
    const blob = new Blob(chunks, { type: 'application/zip' });
    chunks.length = 0;
    // Only after the part was generated: mark as exported (updated_at untouched).
    await markExported('assets', marksA, exportedAt);
    await markExported('buildings', marksB, exportedAt);
    if (p === totalParts - 1) await markTombstones(pid, tombs.map((t) => t.id), exportedAt);
    onPart?.({ n: p + 1, total: totalParts, name: partFileName(projectSlug(project), safeName(who), stamp, p + 1, totalParts), blob, nAssets: marksA.length, nBuildings: marksB.length });
    await new Promise((r) => setTimeout(r));
  }
  return { parts: totalParts, assets: indexAssets.length, buildings: indexBuildings.length, deleted: tombs.length };
}
