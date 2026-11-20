// Building data model (v0.3 F2): mirrors the valuation Excel (33 columns A–AG) and Aux_List (HVAC types).
// Pure module (no DOM, no IndexedDB) so it can be tested in Node and reused by the template/import (F3)
// and the export (F4).

// ---- Fixed lists (from the Excel data validations; "CREATE YOUR OWN" becomes "Otro…" in the app) ----
export const LISTS = {
  frame: ['WOOD', 'STEEL', 'FIREPROOFED STEEL', 'REINFORCED CONCRETE', 'JOISTED MASONRY (LOAD BEARING WALL)', 'CONCRETE AND STEEL'],
  ground_floor: ['EXPOSED GRADE', 'REINFORCED CONCRETE', 'WOOD JOIST AND DECK', 'STEEL JOIST WITH CONCRETE'],
  intermediate_floors: ['WOOD FRAME AND DECK', 'STEEL JOIST AND DECK', 'STEEL JOIST WITH CONCRETE SLAB', 'N/A'],
  walls: ['INSULATED METAL PANELS', 'METAL PANELS', 'PRECAST CONCRETE PANELS', 'TILT-UP CONCRETE PANELS', 'REINFORCED CONCRETE', 'SOLID BRICK', 'BRICK ON CONCRETE BLOCK', 'CONCRETE', 'BLOCK', 'STUCCO ON WIRE MESH', 'STUCCO ON CONCRETE BLOCK', 'VINYL SIDING', 'WOOD SIDING'],
  roof: ['WOOD SHEATHING WITH ASPHALT SHINGLES', 'WOOD DECK WITH BUILT-UP ROOFING', 'WOOD DECK WITH MEMBRANE', 'METAL CLADDING', 'CONCRETE DECK WITH BUILT-UP ROOFING', 'CONCRETE DECK WITH MEMBRANE ROOFING'],
  sustainability: ['LEED CERTIFIED', 'LEED SILVER', 'LEED GOLD', 'LEED PLATINUM', 'N/A'],
  iso_code: ['1 - FRAME', '2 - JOISTED', '3 - NONCOMBUSTIBLE', '4 - MASONRY NONCOMBUSTIBLE', '5 - MODIFIED FIRE RESISTIVE', '6 - FIRE RESISTIVE'],
  fire_protection: ['SPRINKLED', 'MANUAL', 'AUTOMATIC', 'NO'],
  hvac_category: ['HEATING ONLY', 'HEATING AND COOLING', 'COOLING ONLY', 'NO'],
  yes_no: ['YES', 'NO']
};
// Aux_List named ranges HEATING_ONLY, HEATING_AND_COOLING, COOLING_ONLY, NO (AC depends on AB).
export const HVAC_TYPES = {
  'HEATING ONLY': ['ELECTRIC CABLE OR BASEBOARD', 'ELECTRIC WALL HEATERS (INCLUDING FWA)', 'FORCED AIR', 'HOT WATER, BASEBOARD OR RADIANT FLOOR', 'RADIANT HEAT, GAS, SUSPENDED OR RADIANT PANELS', 'SPACE HEATERS, GAS, WITH FAN', 'STEAM COIL, WITH BOILER', 'STEAM COIL, WITHOUT BOILER', 'STEAM RADIATOR, WITH BOILER', 'STEAM RADIATOR, WITHOUT BOILER', 'WALL OR FLOOR FURNACE'],
  'HEATING AND COOLING': ['ZONED A.C., HOT AND COOL WATER/AIR', 'PACKAGE HEATING AND COOLING, SHORT DUCTS', 'HEAT-PUMP SYSTEM', 'HEAT-PUMP SYSTEM, GROUND-LOOP HEAT SOURCE', 'INDIVIDUAL THRU-WALL HEAT PUMP'],
  'COOLING ONLY': ['EVAPORATIVE COOLERS', 'REFRIGERATED AIR CONDITIONING ONLY, ZONED SYSTEM', 'REFRIGERATED AIR CONDITIONING ONLY, PACKAGE UNIT, SHORT DUCTS', 'VENTILATION ONLY, WITH DUCTS & BLOWERS'],
  NO: ['N/A']
};
export const ISO_HELP = {
  '1 - FRAME': 'Madera o materiales ligeros; la menos resistente al fuego',
  '2 - JOISTED': 'Muros de mampostería con pisos/techo de madera',
  '3 - NONCOMBUSTIBLE': 'Metal u otros materiales no combustibles',
  '4 - MASONRY NONCOMBUSTIBLE': 'Muros de mampostería con pisos/techo no combustibles',
  '5 - MODIFIED FIRE RESISTIVE': 'Resistencia al fuego > 1 h y < 2 h',
  '6 - FIRE RESISTIVE': 'Resistencia al fuego > 2 h'
};

// Units of a measure field are stored with the value; `project` units drive the export/headers.
export const UNIT_LABEL = { m: 'm', ft: 'ft', m2: 'm²', ft2: 'ft²' };
const FT_PER_M = 3.28084;
const FT2_PER_M2 = 10.7639;

export const SECTIONS = [
  { key: 'ident', title: 'Identificación' },
  { key: 'geo', title: 'Geometría' },
  { key: 'areas', title: 'Áreas' },
  { key: 'const', title: 'Construcción' },
  { key: 'risk', title: 'Riesgo y sostenibilidad' },
  { key: 'serv', title: 'Servicios' },
  { key: 'office', title: 'Valores de gabinete (redondeos, se llenan en oficina)' }
];

// type: text | year | storeys | area | length | number | percent | list | yesno
// For area/length the Excel header gets the unit appended (", Square Feet" / ", Meters"...).
export const FIELDS = [
  { key: 'code', col: 'A', header: 'AI Bldg #', type: 'text', section: 'ident', label: 'Código (BLDG #)' },
  { key: 'name', col: 'B', header: 'Building Name', type: 'text', section: 'ident', label: 'Nombre del edificio' },
  { key: 'fm_name', col: 'C', header: 'FM Name\n(if Different)', type: 'text', section: 'ident', label: 'Nombre FM (si es distinto)', help: 'Para edificios nuevos escribe NEW BUILDING' },
  { key: 'occupancy', col: 'D', header: 'Occupancy', type: 'text', section: 'ident', label: 'Ocupación / uso', suggest: true, help: 'Ej.: PRODUCTION, STORAGE, OFFICES' },
  { key: 'address', col: 'E', header: 'Address', type: 'text', section: 'ident', label: 'Dirección', help: 'Solo si es distinta a la del proyecto' },
  { key: 'year_built', col: 'F', header: 'Year Built', type: 'year', section: 'ident', label: 'Año de construcción', help: 'Ej.: 1980 o 1960-1990' },
  { key: 'gfa', col: 'G', header: 'Gross Floor Area (Above Grade)', type: 'area', section: 'areas', label: 'Área bruta sobre rasante' },
  { key: 'gfa_rounded', col: 'H', header: 'Gross Floor Area (Above Grade)', suffix: 'Rounded', type: 'area', section: 'office', label: 'Área bruta, redondeada', office: true },
  { key: 'mezzanine_area', col: 'I', header: 'Mezzanine Area', type: 'area', section: 'areas', label: 'Área de mezzanine' },
  { key: 'mezzanine_rounded', col: 'J', header: 'Mezzanine Area', suffix: 'Rounded', type: 'area', section: 'office', label: 'Mezzanine, redondeada', office: true },
  { key: 'basement_area', col: 'K', header: 'Basement Area', type: 'area', section: 'areas', label: 'Área de sótano' },
  { key: 'basement_rounded', col: 'L', header: 'Basement Area', suffix: 'Rounded', type: 'area', section: 'office', label: 'Sótano, redondeada', office: true },
  { key: 'total_gfa', col: 'M', header: 'Total\nGross Floor Area', type: 'area', section: 'office', label: 'Área bruta total', office: true },
  { key: 'storeys', col: 'N', header: 'Number of Storeys + Basements', type: 'storeys', section: 'geo', label: 'Niveles + sótanos', help: 'Ej.: 2, 1 + MEZZANINE, 3 + 1 BASEMENT' },
  { key: 'perimeter', col: 'O', header: 'Building\nPerimeter', type: 'length', section: 'geo', label: 'Perímetro' },
  { key: 'perimeter_rounded', col: 'P', header: 'Building\nPerimeter', suffix: 'Rounded', type: 'length', section: 'office', label: 'Perímetro, redondeado', office: true },
  { key: 'height', col: 'Q', header: 'Building Height', type: 'length', section: 'geo', label: 'Altura' },
  { key: 'height_rounded', col: 'R', header: 'Building Height', suffix: 'Rounded', type: 'length', section: 'office', label: 'Altura, redondeada', office: true },
  { key: 'frame', col: 'S', header: 'Frame', type: 'list', list: 'frame', section: 'const', label: 'Estructura (Frame)' },
  { key: 'ground_floor', col: 'T', header: 'Ground Floor', type: 'list', list: 'ground_floor', section: 'const', label: 'Piso planta baja' },
  { key: 'intermediate_floors', col: 'U', header: 'Intermediate Floors', type: 'list', list: 'intermediate_floors', section: 'const', label: 'Entrepisos' },
  { key: 'walls', col: 'V', header: 'Walls', type: 'list', list: 'walls', section: 'const', label: 'Muros' },
  { key: 'roof', col: 'W', header: 'Roof', type: 'list', list: 'roof', section: 'const', label: 'Techo' },
  { key: 'sustainability', col: 'X', header: 'Sustainability', type: 'list', list: 'sustainability', section: 'risk', label: 'Sostenibilidad' },
  { key: 'iso_code', col: 'Y', header: 'ISO Code', type: 'list', list: 'iso_code', section: 'risk', label: 'Código ISO', closed: true },
  { key: 'fire_protection', col: 'Z', header: 'Fire Protection', type: 'list', list: 'fire_protection', section: 'risk', label: 'Protección contra incendio', closed: true },
  { key: 'fire_protection_pct', col: 'AA', header: '%', type: 'percent', section: 'risk', label: '% cubierto por protección', help: '0 a 100' },
  { key: 'hvac_category', col: 'AB', header: 'HVAC Category', type: 'list', list: 'hvac_category', section: 'serv', label: 'HVAC: categoría', closed: true },
  { key: 'hvac_type', col: 'AC', header: 'HVAC Type', type: 'list', list: 'hvac_type', dependsOn: 'hvac_category', section: 'serv', label: 'HVAC: tipo' },
  { key: 'plumbing', col: 'AD', header: 'Plumbing and Sewage Systems', type: 'yesno', section: 'serv', label: 'Plomería y drenaje' },
  { key: 'electrical', col: 'AE', header: 'Electrical and Lighting Systems', type: 'yesno', section: 'serv', label: 'Eléctrico e iluminación' },
  { key: 'elevators', col: 'AF', header: 'Elevators', type: 'yesno', section: 'serv', label: 'Elevadores' },
  { key: 'other_equipment', col: 'AG', header: 'Other Service Equipment (Enter Description)', type: 'text', section: 'serv', label: 'Otro equipo de servicio', multiline: true }
];
export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
// Fields stored inside building.fields (code and name live on the record itself).
export const DATA_FIELDS = FIELDS.filter((f) => f.key !== 'code' && f.key !== 'name');

// Excel header of a column for the project's unit system (same text the original formulas produce).
export function headerFor(f, units = 'imperial') {
  const imp = units !== 'metric';
  let h = f.header;
  if (f.type === 'area') h += ',\n' + (imp ? 'Square Feet' : 'Square Meters');
  else if (f.type === 'length') h += ',\n' + (imp ? 'Feet' : 'Meters');
  if (f.suffix) h += ',\n' + f.suffix;
  return h;
}
export const projectUnit = (type, units) => (type === 'area' ? (units === 'metric' ? 'm2' : 'ft2') : (units === 'metric' ? 'm' : 'ft'));

// ---- Arithmetic expressions for measures: "45.5*10.5 + (85*108,5)" ----
// Accepts + - * / ( ), decimal point or comma, spaces and "x"/"×" as multiply. Throws Error on anything else.
export function evalExpr(input) {
  const src = String(input ?? '').trim().replace(/[x×]/gi, '*').replace(/(\d),(\d)/g, '$1.$2');
  if (!src) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (src[i] === ' ') i++; };
  const num = () => {
    skip();
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) throw new Error('Número esperado');
    i += m[0].length;
    return Number(m[0]);
  };
  const factor = () => {
    skip();
    if (peek() === '(') { i++; const v = expr(); skip(); if (peek() !== ')') throw new Error('Falta “)”'); i++; return v; }
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    return num();
  };
  const term = () => {
    let v = factor();
    for (;;) {
      skip();
      if (peek() === '*') { i++; v *= factor(); } else if (peek() === '/') { i++; const d = factor(); if (d === 0) throw new Error('División entre cero'); v /= d; } else return v;
    }
  };
  function expr() {
    let v = term();
    for (;;) { skip(); if (peek() === '+') { i++; v += term(); } else if (peek() === '-') { i++; v -= term(); } else return v; }
  }
  const v = expr();
  skip();
  if (i < src.length) throw new Error(`Carácter no válido: “${src[i]}”`);
  if (!Number.isFinite(v)) throw new Error('Resultado no válido');
  return Math.round(v * 1e6) / 1e6;
}

// Convert a stored measure {value, unit} to a target unit.
export function convert(value, from, to) {
  if (value == null || from === to) return value;
  if (from === 'm' && to === 'ft') return value * FT_PER_M;
  if (from === 'ft' && to === 'm') return value / FT_PER_M;
  if (from === 'm2' && to === 'ft2') return value * FT2_PER_M2;
  if (from === 'ft2' && to === 'm2') return value / FT2_PER_M2;
  return value;
}
// Value of a measure field in the project's units (rounded to 2 decimals), or null.
export function measureIn(m, type, units) {
  if (!m || m.value == null || m.value === '') return null;
  const to = projectUnit(type, units);
  return Math.round(convert(Number(m.value), m.unit || to, to) * 100) / 100;
}

export function validateYear(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const m = /^(\d{4})(?:\s*-\s*(\d{4}))?$/.exec(t);
  const now = new Date().getFullYear() + 1;
  if (!m) return 'Usa un año (1980) o un rango (1960-1990).';
  const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
  if (a < 1700 || b > now || b < a) return 'Año fuera de rango.';
  return null;
}

// Options of a list field. custom = [{field, value}] project values added by users.
export function optionsFor(f, fields, custom = []) {
  if (f.type === 'yesno') return LISTS.yes_no;
  let base;
  let scope = f.key;
  if (f.key === 'hvac_type') {
    const cat = fields?.hvac_category;
    base = HVAC_TYPES[cat] || [];
    scope = 'hvac_type:' + (cat || '');
  } else base = LISTS[f.list] || [];
  const extra = custom.filter((c) => c.field === scope).map((c) => c.value);
  return [...base, ...extra.filter((v) => !base.includes(v))];
}
// List value key in the 'lists' store: hvac_type is scoped by its category.
export const listScope = (f, fields) => (f.key === 'hvac_type' ? 'hvac_type:' + (fields?.hvac_category || '') : f.key);

export function isFilled(f, fields) {
  const v = fields?.[f.key];
  if (v == null || v === '') return false;
  if (typeof v === 'object') return v.value != null && v.value !== '';
  return true;
}
export function sectionProgress(section, fields) {
  const fs = DATA_FIELDS.filter((f) => f.section === section);
  return { filled: fs.filter((f) => isFilled(f, fields)).length, total: fs.length };
}
export const emptyFieldLabels = (fields, { includeOffice = false } = {}) => DATA_FIELDS.filter((f) => (includeOffice || !f.office) && !isFilled(f, fields)).map((f) => f.label);

// Inspection status:
//  inspected   = marked inspected AND has at least one photo
//  in_progress = anything captured in the field (photo, audio, notes, an edited field) but not inspected
//  pending     = nothing captured in the field yet (preloaded data does not count)
export function buildingStatus(b, counts) {
  const photos = counts?.photo || 0;
  if (b.inspected_at && photos > 0) return 'inspected';
  if (photos || counts?.audio || counts?.chunk || String(b.notes || '').trim() || b.field_updated_at) return 'in_progress';
  return 'pending';
}
export const STATUS_LABEL = { pending: 'Pendiente', in_progress: 'En proceso', inspected: 'Inspeccionado' };
