// Building precharge (v0.3 F3): Excel template (download) and import of a filled template or of the source
// Excel itself (same format). Pure module: no DOM, no IndexedDB (tested in Node).
import { writeXlsx, readXlsx, colName } from './xlsx.js';
import { FIELDS, FIELD, LISTS, HVAC_TYPES, ISO_HELP, headerFor, projectUnit, evalExpr, validateYear, measureIn } from './bldg-schema.js';
import { decodeBytes, detectDelimiter, parseRecords } from './csv.js';

const MAX_ROWS = 1000; // validations in the template cover rows 2..1000

// ---------------------------------------------------------------- template
const LIST_COLS = [
  ['frame', 'Frame'], ['ground_floor', 'Ground Floor'], ['intermediate_floors', 'Intermediate Floors'], ['walls', 'Walls'], ['roof', 'Roof'],
  ['sustainability', 'Sustainability'], ['iso_code', 'ISO Code'], ['fire_protection', 'Fire Protection'], ['hvac_category', 'HVAC Category'], ['yes_no', 'YES / NO']
];
const HVAC_NAMES = [['HEATING ONLY', 'HEATING_ONLY'], ['HEATING AND COOLING', 'HEATING_AND_COOLING'], ['COOLING ONLY', 'COOLING_ONLY'], ['NO', 'NO']];
const WIDTH = { code: 10, name: 34, fm_name: 18, occupancy: 18, address: 30, year_built: 11, storeys: 16, other_equipment: 40, hvac_type: 34, iso_code: 26 };

// Excel cell value of a building field (measures in project units, % as fraction like the Excel).
function cellValue(f, b, units) {
  if (f.key === 'code') return b.code;
  if (f.key === 'name') return b.name;
  const v = b.fields?.[f.key];
  if (v == null || v === '') return null;
  if (f.type === 'area' || f.type === 'length') { const n = measureIn(v, f.type, units); return n == null ? null : { v: n, s: 'num' }; }
  if (f.type === 'percent') return { v: Math.round((Number(v) / 100) * 10000) / 10000, s: 'pct' };
  return v;
}

// custom: [{field, value}] values added in the project ("Otro valor"); they go to the lists too.
// buildings: optional, to export the current list in the same format.
export function buildTemplate({ units = 'imperial', custom = [], buildings = [], projectName = '' } = {}) {
  const extra = (scope) => custom.filter((c) => c.field === scope).map((c) => c.value);
  // Listas sheet: one column per list, then the HVAC ranges (named exactly like the original Aux_List).
  const listCols = LIST_COLS.map(([k, title]) => ({ key: k, title, values: [...new Set([...(LISTS[k] || []), ...extra(k)])] }));
  const hvacCols = HVAC_NAMES.map(([cat, name]) => ({ key: name, title: name, values: [...new Set([...HVAC_TYPES[cat], ...(cat === 'NO' ? [] : extra('hvac_type:' + cat))])] }));
  const all = [...listCols, ...hvacCols];
  const depth = Math.max(...all.map((c) => c.values.length));
  const listRows = [all.map((c) => ({ v: c.title, s: 'bold' }))];
  for (let i = 0; i < depth; i++) listRows.push(all.map((c) => c.values[i] ?? null));
  const names = all.map((c, i) => ({ name: listCols.includes(c) ? 'L_' + c.key.toUpperCase() : c.key, ref: `Listas!$${colName(i)}$2:$${colName(i)}$${Math.max(2, c.values.length + 1)}` }));

  const header = FIELDS.map((f) => ({ v: headerFor(f, units), s: 'head' }));
  const rows = [header, ...buildings.map((b) => FIELDS.map((f) => cellValue(f, b, units)))];
  const col = (k) => FIELD[k].col;
  const range = (k) => `${col(k)}2:${col(k)}${MAX_ROWS}`;
  const listName = (k) => 'L_' + k.toUpperCase();
  const warn = { errorStyle: 'warning', errorTitle: 'Valor fuera de lista', error: 'Este valor no está en la lista. Puedes dejarlo: la app lo agregará a las listas del proyecto al importar.' };
  const validations = [
    ...['frame', 'ground_floor', 'intermediate_floors', 'walls', 'roof', 'sustainability'].map((k) => ({ sqref: range(k), type: 'list', formula1: listName(k), ...warn })),
    ...['iso_code', 'fire_protection', 'hvac_category'].map((k) => ({ sqref: range(k), type: 'list', formula1: listName(k), errorStyle: 'stop', errorTitle: 'Valor no válido', error: 'Elige un valor de la lista.' })),
    { sqref: range('hvac_type'), type: 'list', formula1: `INDIRECT(SUBSTITUTE(${col('hvac_category')}2," ","_"))`, ...warn },
    { sqref: `${range('plumbing')} ${range('electrical')} ${range('elevators')}`, type: 'list', formula1: 'L_YES_NO', errorStyle: 'stop', errorTitle: 'Valor no válido', error: 'YES o NO' },
    { sqref: FIELDS.filter((f) => f.type === 'area' || f.type === 'length').map((f) => range(f.key)).join(' '), type: 'decimal', operator: 'greaterThanOrEqual', formula1: '0', errorStyle: 'stop', errorTitle: 'Número', error: 'Escribe un número mayor o igual a 0 (o una fórmula).' },
    { sqref: range('fire_protection_pct'), type: 'decimal', operator: 'between', formula1: '0', formula2: '1', errorStyle: 'stop', errorTitle: 'Porcentaje', error: 'Entre 0 % y 100 %' }
  ];
  const sheetMain = {
    name: 'Edificios', rows, headerHeight: 64, freeze: { row: 1, col: 2 }, autoFilter: `A1:${colName(FIELDS.length - 1)}1`,
    cols: FIELDS.map((f) => ({ width: WIDTH[f.key] || (f.type === 'list' ? 30 : 14) })), validations
  };
  const unitTxt = units === 'metric' ? 'metros / metros cuadrados' : 'pies / pies cuadrados';
  const help = [
    [{ v: 'Plantilla de edificios' + (projectName ? ' — ' + projectName : ''), s: 'bold' }],
    ['1. Llena una fila por edificio en la hoja "Edificios". Puedes copiar y pegar directo desde el archivo fuente (mismo formato y orden de columnas).'],
    ['2. "AI Bldg #" (código) es obligatorio y no se puede repetir. Lo demás es opcional.'],
    [`3. Áreas, perímetro y altura en ${unitTxt} (sistema del proyecto). Se aceptan fórmulas (=12*95.5*10.7639); la app lee el valor calculado.`],
    ['4. % de protección contra incendio como porcentaje (100 %) o fracción (1).'],
    ['5. HVAC Type depende de HVAC Category (listas como en Aux_List). Valores fuera de lista se aceptan y se agregan a las listas del proyecto.'],
    ['6. En la app: Edificios → Importar Excel. Verás una vista previa con errores por fila antes de confirmar.'],
    [''],
    [{ v: 'ISO Code', s: 'bold' }],
    ...Object.entries(ISO_HELP).map(([k, v]) => [k, v])
  ];
  return writeXlsx({
    sheets: [sheetMain, { name: 'Instrucciones', rows: help, cols: [{ width: 110 }, { width: 60 }] }, { name: 'Listas', hidden: true, rows: listRows, cols: all.map(() => ({ width: 40 })) }],
    names
  });
}

// ---------------------------------------------------------------- import
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const UNIT_WORDS = /square\s*feet|square\s*meters|square\s*metres|sq\.?\s*ft|feet|meters|metres|\bft2?\b|\bm2\b|ft²|m²/g;
export const headerKey = (h) => norm(h).replace(UNIT_WORDS, '').replace(/[^a-z0-9%]/g, '');
const ALIASES = { code: ['aibldg', 'bldg', 'bldgno', 'codigo', 'code', 'edificio'], name: ['buildingname', 'bldgname', 'nombre', 'name'], fire_protection_pct: ['%', 'firepct', 'fireprotection%'] };
const HEADER_MAP = (() => {
  const m = new Map();
  for (const f of FIELDS) m.set(headerKey(f.header + (f.suffix ? ' ' + f.suffix : '')), f.key);
  for (const [k, list] of Object.entries(ALIASES)) for (const a of list) if (!m.has(a)) m.set(a, k);
  return m;
})();
export function detectUnits(headers) {
  const t = norm(headers.join(' '));
  if (/square\s*met|\bmeters?\b|\bmetres?\b/.test(t)) return 'metric';
  if (/square\s*feet|\bfeet\b/.test(t)) return 'imperial';
  return null;
}

// rows: matrix of {v, f?, formulaNoValue?, error?} (xlsx) or strings (csv). Returns the header row index and mapping.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = (rows[r] || []).map((c) => (c && typeof c === 'object' ? c.v : c));
    const keys = cells.map((c) => HEADER_MAP.get(headerKey(c)) || null);
    if (keys.includes('code')) return { r, cells, keys };
  }
  return null;
}

const listMatch = (value, options) => {
  const k = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  const vk = k(value);
  return options.find((o) => k(o) === vk) || null;
};
const toNumber = (c) => {
  const v = c && typeof c === 'object' ? c.v : c;
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\s/g, '');
  if (!s) return null;
  // "1,234.5" / "1.234,5" / "1234,5"
  let t = s;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

// Parse a file (xlsx bytes or csv bytes) into { units, rows:[{line, fields:{}, code, name}], errors, warnings, ignored, outOfList }
// opts: { projectUnits, custom:[{field,value}] }
export function parseBuildingsFile(bytes, fileName, { projectUnits = 'imperial', custom = [] } = {}) {
  const out = { units: null, unitsFromFile: false, sheet: null, rows: [], errors: [], warnings: [], ignored: [], outOfList: [] };
  let matrix;
  const isXlsx = /\.xlsx$/i.test(fileName) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (/\.xls$/i.test(fileName) && !isXlsx) { out.errors.push({ line: 0, msg: 'El formato .xls (Excel 97-2003) no se puede leer. Ábrelo en Excel y guárdalo como "Libro de Excel (.xlsx)".' }); return out; }
  if (isXlsx) {
    let wb;
    try { wb = readXlsx(bytes); } catch (e) { out.errors.push({ line: 0, msg: e.message }); return out; }
    const sheet = wb.sheets.find((s) => !s.hidden && findHeader(s.rows)) || wb.sheets.find((s) => findHeader(s.rows));
    if (!sheet) { out.errors.push({ line: 0, msg: 'No se encontró la columna "AI Bldg #" (código) en ninguna hoja. Usa la plantilla o el formato del Excel de levantamiento.' }); return out; }
    out.sheet = sheet.name;
    matrix = sheet.rows;
  } else {
    const { text } = decodeBytes(bytes);
    const clean = text.replace(/^﻿/, '');
    try { matrix = parseRecords(clean, detectDelimiter(clean)).map((r) => r.map((v) => ({ v }))); } catch (e) { out.errors.push({ line: 0, msg: e.message }); return out; }
  }
  const head = findHeader(matrix);
  if (!head) { out.errors.push({ line: 0, msg: 'No se encontró la columna "AI Bldg #" (código). Revisa que la primera fila tenga los encabezados.' }); return out; }
  const fileUnits = detectUnits(head.cells.map((c) => c ?? ''));
  out.units = fileUnits || projectUnits;
  out.unitsFromFile = !!fileUnits;
  head.cells.forEach((c, i) => { if (c != null && String(c).trim() && !head.keys[i]) out.ignored.push(String(c).replace(/\s+/g, ' ').trim()); });
  const seenKeys = new Set(); const colOf = {};
  head.keys.forEach((k, i) => { if (k && !seenKeys.has(k)) { seenKeys.add(k); colOf[k] = i; } });
  if (colOf.name == null) out.warnings.push({ line: head.r + 1, msg: 'No hay columna "Building Name": los edificios se importarán sin nombre.' });

  const customOf = (scope) => custom.filter((c) => c.field === scope).map((c) => c.value);
  const oolMap = new Map();
  const seenCodes = new Map();
  for (let r = head.r + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const line = r + 1;
    const cell = (k) => (colOf[k] == null ? undefined : row[colOf[k]]);
    const txt = (k) => { const c = cell(k); const v = c && typeof c === 'object' ? c.v : c; return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); };
    if (!row.some((c) => c && (typeof c !== 'object' || (c.v != null && String(c.v).trim() !== '') || c.formulaNoValue || c.error))) continue;
    const code = txt('code');
    if (!code) { out.errors.push({ line, msg: 'Falta el código (AI Bldg #); la fila no se importa.' }); continue; }
    const ck = norm(code).toUpperCase();
    if (seenCodes.has(ck)) { out.errors.push({ line, msg: `Código ${code} repetido (ya está en la fila ${seenCodes.get(ck)}); se conserva la primera.` }); continue; }
    seenCodes.set(ck, line);
    const fields = {};
    for (const f of FIELDS) {
      if (f.key === 'code' || f.key === 'name' || colOf[f.key] == null) continue;
      const c = cell(f.key);
      if (c && typeof c === 'object' && c.formulaNoValue) { out.warnings.push({ line, msg: `${f.header.replace(/\s+/g, ' ')} (${f.col}): fórmula sin valor calculado; abre y guarda el archivo en Excel. Celda omitida.` }); continue; }
      if (c && typeof c === 'object' && c.error) { out.warnings.push({ line, msg: `${f.label} (${f.col}): la celda tiene un error de Excel (${c.error}). Celda omitida.` }); continue; }
      const raw = c && typeof c === 'object' ? c.v : c;
      if (raw == null || String(raw).trim() === '') continue;
      if (f.type === 'area' || f.type === 'length') {
        let n = toNumber(c);
        let expr = null;
        if (Number.isNaN(n)) { try { n = evalExpr(String(raw)); expr = String(raw); } catch (_) { n = NaN; } }
        if (Number.isNaN(n) || n == null || n < 0) { out.warnings.push({ line, msg: `${f.label} (${f.col}): "${raw}" no es un número válido. Celda omitida.` }); continue; }
        if (c?.f) { try { if (Math.abs(evalExpr(c.f) - n) < 0.01) expr = c.f; } catch (_) { /* formula with references: keep only the value */ } }
        fields[f.key] = { value: Math.round(n * 1e6) / 1e6, unit: projectUnit(f.type, out.units), expr };
      } else if (f.type === 'percent') {
        let n = toNumber(c);
        if (typeof raw === 'string' && raw.trim().endsWith('%')) n = toNumber(raw.trim().slice(0, -1)) / 100;
        if (Number.isNaN(n) || n == null || n < 0 || n > 100) { out.warnings.push({ line, msg: `%: "${raw}" no es un porcentaje válido. Celda omitida.` }); continue; }
        fields[f.key] = Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
      } else if (f.type === 'year') {
        const y = typeof raw === 'number' ? String(Math.round(raw)) : String(raw).replace(/\s+/g, '').replace(/[–—]/g, '-');
        const err = validateYear(y);
        if (err) out.warnings.push({ line, msg: `Año "${raw}": ${err} Se importa tal cual.` });
        fields[f.key] = y;
      } else if (f.type === 'yesno') {
        const t = norm(raw).trim();
        const v = ['yes', 'y', 'si', 's', 'true', '1'].includes(t) ? 'YES' : ['no', 'n', 'false', '0'].includes(t) ? 'NO' : null;
        if (!v) { out.warnings.push({ line, msg: `${f.label} (${f.col}): "${raw}" debe ser YES o NO. Celda omitida.` }); continue; }
        fields[f.key] = v;
      } else if (f.type === 'list') {
        const value = String(raw).replace(/\s+/g, ' ').trim();
        const scope = f.key === 'hvac_type' ? 'hvac_type:' + (fields.hvac_category || '') : f.key;
        const base = f.key === 'hvac_type' ? (HVAC_TYPES[fields.hvac_category] || []) : (LISTS[f.list] || []);
        const options = [...base, ...customOf(scope)];
        const hit = listMatch(value, options);
        if (hit) { fields[f.key] = hit; continue; }
        if (f.closed) { out.warnings.push({ line, msg: `${f.label} (${f.col}): "${value}" no es un valor permitido (${base.join(', ')}). Celda omitida.` }); continue; }
        const up = value.toUpperCase();
        fields[f.key] = up;
        const k = scope + '|' + up;
        if (!oolMap.has(k)) oolMap.set(k, { field: f.key, scope, label: f.label, col: f.col, value: up, lines: [] });
        oolMap.get(k).lines.push(line);
      } else {
        fields[f.key] = String(raw).replace(/\r\n/g, '\n').trim();
      }
    }
    out.rows.push({ line, code, name: txt('name'), fields });
  }
  out.outOfList = [...oolMap.values()];
  if (!out.rows.length && !out.errors.length) out.errors.push({ line: 0, msg: 'El archivo no tiene filas de edificios debajo de los encabezados.' });
  return out;
}

// Plan the import against the project's buildings. mode: 'fill' (add new + fill empty fields) | 'overwrite' | 'new'
export function planImport(parsed, existing, mode = 'fill') {
  const byKey = new Map(existing.map((b) => [b.code_key, b]));
  const plan = { create: [], update: [], unchanged: [], conflicts: [] };
  for (const r of parsed.rows) {
    const key = String(r.code).normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
    const cur = byKey.get(key);
    if (!cur) { plan.create.push(r); continue; }
    if (mode === 'new') { plan.unchanged.push(r); continue; }
    const fields = { ...(cur.fields || {}) };
    let changed = 0;
    for (const [k, v] of Object.entries(r.fields)) {
      const has = fields[k] != null && fields[k] !== '';
      if (has && mode === 'fill') { if (JSON.stringify(fields[k]) !== JSON.stringify(v)) plan.conflicts.push({ code: r.code, field: k }); continue; }
      if (JSON.stringify(fields[k]) !== JSON.stringify(v)) { fields[k] = v; changed++; }
    }
    const name = r.name && (mode === 'overwrite' || !cur.name) ? r.name : cur.name;
    if (changed || name !== cur.name) plan.update.push({ cur, fields, name }); else plan.unchanged.push(r);
  }
  return plan;
}
