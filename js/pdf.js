// Minimal PDF writer (v0.3 F5): text with Helvetica / Helvetica-Bold (WinAnsi: Spanish accents, ñ, ¿, ¡, ²),
// rectangles, lines, page breaks and page numbers. No images, no external fonts. Pure: works in Node.
// Coordinates: points, origin at the TOP-left of the page (converted to PDF's bottom-left internally).
import { zlibSync, strToU8 } from '../vendor/fflate.esm.js';

// Advance widths (1/1000 em) for ASCII 32..126 from the standard Helvetica AFM metrics.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// Characters outside WinAnsi that we map to WinAnsi bytes.
const SPECIAL = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
const SPECIAL_W = { 0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000 };

// String -> array of WinAnsi codes ('?' for unsupported characters).
function encode(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (SPECIAL[ch]) out.push(SPECIAL[ch]);
    else if (c === 9) out.push(32);
    else if (c >= 0x300 && c <= 0x36f) continue; // stray combining marks
    else out.push(63);
  }
  return out;
}
// Width of a Latin-1 letter: the width of its base letter (é -> e), else a typical width.
function codeWidth(c, bold) {
  const W = bold ? W_BOLD : W_REG;
  if (c >= 32 && c <= 126) return W[c - 32];
  if (SPECIAL_W[c]) return SPECIAL_W[c];
  if (c === 160) return 278;
  const base = String.fromCharCode(c).normalize('NFD')[0].charCodeAt(0);
  if (base >= 32 && base <= 126 && base !== c) return W[base - 32];
  if (c === 0xb2 || c === 0xb3 || c === 0xb9) return 333; // superscripts
  return 556;
}
export function textWidth(str, size, bold = false) {
  let w = 0;
  for (const c of encode(str)) w += codeWidth(c, bold);
  return (w * size) / 1000;
}
function pdfString(str) {
  let s = '(';
  for (const c of encode(str)) {
    if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s + ')';
}
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const rgb = (hex) => { const h = String(hex || '#000').replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => n2(x)).join(' '); };

export class PdfDoc {
  constructor({ width = 595.28, height = 841.89, margin = 40, footer = null } = {}) {
    Object.assign(this, { width, height, margin, footer });
    this.pages = [];
    this.y = margin;
    this.addPage();
  }
  addPage() { this.ops = []; this.pages.push(this.ops); this.y = this.margin; return this; }
  get bottom() { return this.height - this.margin - 18; } // room for the footer
  ensure(h) { if (this.y + h > this.bottom) this.addPage(); return this; }
  wrap(str, size, maxWidth, bold = false) {
    const lines = [];
    for (const para of String(str ?? '').split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? line + ' ' + word : word;
        if (textWidth(t, size, bold) <= maxWidth || !line) {
          // A single word longer than the line is cut hard.
          if (!line && textWidth(word, size, bold) > maxWidth) {
            let part = '';
            for (const ch of word) { if (textWidth(part + ch, size, bold) > maxWidth) { lines.push(part); part = ch; } else part += ch; }
            line = part;
          } else line = t;
        } else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }
  // Single line of text at (x, y=top of the line box). opts: size, bold, color, align ('left'|'right'|'center'), width (for align)
  text(x, y, str, { size = 10, bold = false, color = '#111111', align = 'left', width = 0 } = {}) {
    let tx = x;
    if (align !== 'left' && width) { const w = textWidth(str, size, bold); tx = align === 'right' ? x + width - w : x + (width - w) / 2; }
    const baseline = this.height - (y + size * 0.82);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${rgb(color)} rg ${n2(tx)} ${n2(baseline)} Td ${pdfString(str)} Tj ET`);
    return this;
  }
  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.6 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.ops.push(`q ${fill ? rgb(fill) + ' rg ' : ''}${stroke ? rgb(stroke) + ' RG ' : ''}${n2(lineWidth)} w ${n2(x)} ${n2(this.height - y - h)} ${n2(w)} ${n2(h)} re ${op} Q`);
    return this;
  }
  line(x1, y1, x2, y2, { color = '#cccccc', lineWidth = 0.6 } = {}) {
    this.ops.push(`q ${rgb(color)} RG ${n2(lineWidth)} w ${n2(x1)} ${n2(this.height - y1)} m ${n2(x2)} ${n2(this.height - y2)} l S Q`);
    return this;
  }
  // Paragraph that flows across pages. Returns the doc; advances this.y.
  paragraph(str, { size = 10, bold = false, color = '#111111', x = this.margin, width = this.width - 2 * this.margin, gap = 4 } = {}) {
    const lh = size * 1.3;
    for (const l of this.wrap(str, size, width, bold)) { this.ensure(lh); this.text(x, this.y, l, { size, bold, color }); this.y += lh; }
    this.y += gap;
    return this;
  }
  // Table with header repeated on each page. cols: [{title, width, align}], rows: [[cell]] where cell = string | {text, color, bold, fill}
  table(cols, rows, { size = 8.5, headFill = '#1e3a5f', headColor = '#ffffff', zebra = '#f1f5f9', rowPad = 3 } = {}) {
    const x0 = this.margin;
    const total = cols.reduce((s, c) => s + c.width, 0);
    const head = () => {
      const lines = cols.map((c) => this.wrap(c.title, size, c.width - 6, true));
      const h = Math.max(...lines.map((l) => l.length)) * size * 1.25 + rowPad * 2;
      this.ensure(h + size * 2);
      this.rect(x0, this.y, total, h, { fill: headFill });
      let x = x0;
      cols.forEach((c, i) => { lines[i].forEach((l, j) => this.text(x + 3, this.y + rowPad + j * size * 1.25, l, { size, bold: true, color: headColor, align: c.align || 'left', width: c.width - 6 })); x += c.width; });
      this.y += h;
    };
    head();
    rows.forEach((row, ri) => {
      const cells = row.map((c) => (c != null && typeof c === 'object' ? c : { text: c == null ? '' : String(c) }));
      const lines = cells.map((c, i) => this.wrap(c.text, size, cols[i].width - 6, !!c.bold));
      const h = Math.max(1, ...lines.map((l) => l.length)) * size * 1.25 + rowPad * 2;
      if (this.y + h > this.bottom) { this.addPage(); head(); }
      const fill = cells.find((c) => c.fill)?.fill || (ri % 2 ? zebra : null);
      if (fill) this.rect(x0, this.y, total, h, { fill });
      let x = x0;
      cells.forEach((c, i) => { lines[i].forEach((l, j) => this.text(x + 3, this.y + rowPad + j * size * 1.25, l, { size, bold: !!c.bold, color: c.color || '#111111', align: cols[i].align || 'left', width: cols[i].width - 6 })); x += cols[i].width; });
      this.y += h;
    });
    this.line(x0, this.y, x0 + total, this.y, { color: '#94a3b8' });
    this.y += 10;
    return this;
  }
  output() {
    const total = this.pages.length;
    if (this.footer) this.pages.forEach((ops, i) => { this.ops = ops; this.footer(this, i + 1, total); });
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalog = add(null); const pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const data = zlibSync(strToU8(ops.join('\n')), { level: 6 });
      let bin = ''; for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
      const content = add(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${bin}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n2(this.width)} ${n2(this.height)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    // Every char of `out` is a single byte (binary streams were turned into latin1 chars).
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
