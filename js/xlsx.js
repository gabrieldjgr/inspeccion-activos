// Minimal XLSX writer/reader on top of fflate (already vendored). No DOM: works in Node for tests.
// Writer: inline strings, styles, frozen header, column widths, data validations, defined names, hidden sheets.
// Reader: first matching sheet as a matrix of cell values (shared/inline strings, numbers, booleans,
// cached formula results). Formulas without a cached value are reported, never evaluated.
import { zipSync, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.esm.js';

// ---------------------------------------------------------------- helpers
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control chars; keep tab/newline.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
export function colName(n) { // 0 -> A
  let s = ''; n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colIndex(letters) { // A -> 0
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------- writer
// sheets: [{ name, hidden?, cols:[{width}], rows:[[cell]], freeze?:{row,col}, validations?:[{sqref, type, formula1, formula2?, operator?, errorStyle?, error?, errorTitle?, prompt?}], autoFilter?:'A1:AG1' }]
// cell: null | string | number | boolean | {v, s} where s is a style key: 'head' | 'wrap' | 'num' | 'pct' | 'bold' | 'note'
// names: [{ name, ref }]  e.g. { name: 'HEATING_ONLY', ref: "Listas!$A$2:$A$12" }
const STYLE = { def: 0, head: 1, wrap: 2, num: 3, pct: 4, bold: 5, note: 6 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.##"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center" horizontal="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref, cell) {
  if (cell == null || cell === '') return '';
  let v = cell; let s = 0;
  if (typeof cell === 'object') { v = cell.v; s = STYLE[cell.s] || 0; if (v == null || v === '') return s ? `<c r="${ref}" s="${s}"/>` : ''; }
  const sa = s ? ` s="${s}"` : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}

function sheetXml(sh) {
  const cols = (sh.cols || []).map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"/>`).join('');
  const pane = sh.freeze ? `<pane${sh.freeze.col ? ` xSplit="${sh.freeze.col}"` : ''}${sh.freeze.row ? ` ySplit="${sh.freeze.row}"` : ''} topLeftCell="${colName(sh.freeze.col || 0)}${(sh.freeze.row || 0) + 1}" activePane="bottomRight" state="frozen"/>` : '';
  const rows = sh.rows.map((r, i) => {
    const cells = r.map((c, j) => cellXml(`${colName(j)}${i + 1}`, c)).join('');
    const ht = i === 0 && sh.headerHeight ? ` ht="${sh.headerHeight}" customHeight="1"` : '';
    return cells || ht ? `<row r="${i + 1}"${ht}>${cells}</row>` : '';
  }).join('');
  const dv = (sh.validations || []).map((d) => {
    const attrs = [`type="${d.type}"`, 'allowBlank="1"', 'showInputMessage="1"', 'showErrorMessage="1"', `sqref="${d.sqref}"`];
    if (d.operator) attrs.push(`operator="${d.operator}"`);
    if (d.errorStyle) attrs.push(`errorStyle="${d.errorStyle}"`);
    if (d.errorTitle) attrs.push(`errorTitle="${xmlEsc(d.errorTitle)}"`);
    if (d.error) attrs.push(`error="${xmlEsc(d.error)}"`);
    if (d.prompt) attrs.push(`prompt="${xmlEsc(d.prompt)}"`);
    return `<dataValidation ${attrs.join(' ')}><formula1>${xmlEsc(d.formula1)}</formula1>${d.formula2 != null ? `<formula2>${xmlEsc(d.formula2)}</formula2>` : ''}</dataValidation>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"${sh.hidden ? '' : ' tabSelected="' + (sh.selected ? 1 : 0) + '"'}>${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rows}</sheetData>${sh.autoFilter ? `<autoFilter ref="${sh.autoFilter}"/>` : ''}${dv ? `<dataValidations count="${(sh.validations || []).length}">${dv}</dataValidations>` : ''}
</worksheet>`;
}

export function writeXlsx({ sheets, names = [] }) {
  const files = {};
  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>${names.length ? `<definedNames>${names.map((n) => `<definedName name="${xmlEsc(n.name)}">${xmlEsc(n.ref)}</definedName>`).join('')}</definedNames>` : ''}</workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files['xl/styles.xml'] = STYLES_XML;
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml({ ...s, selected: i === 0 }); });
  const u8 = {};
  for (const [k, v] of Object.entries(files)) u8[k] = strToU8(v);
  return zipSync(u8, { level: 6 });
}

// ---------------------------------------------------------------- reader
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()] ?? m;
});
// Text of all <t> inside a fragment, ignoring phonetic runs (<rPh>).
const textOf = (frag) => { let out = ''; const clean = frag.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''); for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += unesc(m[1]); return out; };
const attr = (s, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s); return m ? unesc(m[1]) : null; };

// Returns { sheets:[{name, hidden, rows: Cell[][]}] } where Cell = { v, formulaNoValue?, error? } | undefined
export function readXlsx(bytes) {
  let files;
  try { files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch (_) { throw new Error('El archivo no es un Excel (.xlsx) válido o está dañado.'); }
  const get = (p) => (files[p] ? strFromU8(files[p]) : null);
  const wb = get('xl/workbook.xml');
  if (!wb) {
    if (files['xl/workbook.bin']) throw new Error('El archivo es .xlsb (binario). Guárdalo como "Libro de Excel (.xlsx)".');
    throw new Error('El archivo no es un Excel (.xlsx) válido.');
  }
  const rels = {};
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) rels[attr(m[1], 'Id')] = attr(m[1], 'Target');
  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] != null ? textOf(m[1]) : '');
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name');
    const rid = attr(m[1], 'r:id');
    let target = rels[rid] || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = get(target);
    if (!xml) continue;
    sheets.push({ name, hidden: /state="(hidden|veryHidden)"/.test(m[1]), rows: parseSheet(xml, shared) });
  }
  return { sheets };
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rIdx = Number(attr(rm[1], 'r')) - 1;
    const row = [];
    let auto = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1]; const inner = cm[2] || '';
      const ref = attr(a, 'r');
      const ci = ref ? colIndex(ref.replace(/\d+/g, '')) : auto;
      auto = ci + 1;
      const t = attr(a, 't');
      const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const fm = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
      const hasF = /<f\b/.test(inner);
      let v;
      if (t === 'inlineStr') v = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] || '');
      else if (!vm) { if (hasF) row[ci] = { v: null, formulaNoValue: true }; continue; }
      else if (t === 's') v = shared[Number(vm[1])] ?? '';
      else if (t === 'str') v = unesc(vm[1]);
      else if (t === 'b') v = vm[1] === '1';
      else if (t === 'e') { row[ci] = { v: null, error: unesc(vm[1]) }; continue; }
      else { const n = Number(vm[1]); v = Number.isFinite(n) ? n : unesc(vm[1]); }
      row[ci] = fm ? { v, f: unesc(fm[1]) } : { v };
    }
    rows[Number.isFinite(rIdx) && rIdx >= 0 ? rIdx : rows.length] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}
