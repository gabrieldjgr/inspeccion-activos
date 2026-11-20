// Progress report PDF (v0.3 F5): buildings inspected vs pending, assets per building / department,
// records without photo / note / plate photo. Data gathering (IndexedDB) + pure rendering (renderReport).
import * as db from './db.js';
import { APP_VERSION } from './version.js';
import { getSavedAssets, getMedia, mediaIndex, countsOf, isPending, nowIso, assetLabel } from './data.js';
import { DATA_FIELDS, isFilled, buildingStatus, STATUS_LABEL } from './bldg-schema.js';
import { PdfDoc } from './pdf.js';
import { projectSlug } from './projects.js';

const floorLabel = (f) => (/^\d+$/.test(f) ? `Piso ${f}` : f || '—');
const byCode = (a, b) => String(a).localeCompare(String(b), 'es', { numeric: true });

export async function gatherReport(project) {
  const pid = project.id;
  const [assets, buildings, media, inspector, drafts] = await Promise.all([
    getSavedAssets(pid), db.getByProject('buildings', pid), mediaIndex(), db.getSetting('inspector', ''),
    db.getByProject('assets', pid).then((all) => all.filter((a) => a.status === 'draft').length)
  ]);
  buildings.sort((a, b) => byCode(a.code, b.code));
  const fieldTotal = DATA_FIELDS.filter((f) => !f.office).length;
  const bRows = buildings.map((b) => {
    const c = countsOf(media, b.id);
    const own = assets.filter((a) => a.building_id === b.id || (!a.building_id && db.normKey(a.building_code) === b.code_key));
    return { code: b.code, name: b.name, status: buildingStatus(b, c), photos: c.photo, audios: c.audio, assets: own.length, filled: DATA_FIELDS.filter((f) => !f.office && isFilled(f, b.fields)).length, inspected_at: b.inspected_at || null };
  });
  // Assets referencing a building code that is not in the list (e.g. deleted building).
  const known = new Set(buildings.map((b) => b.id));
  const orphanCodes = [...new Set(assets.filter((a) => !known.has(a.building_id) && !buildings.some((b) => b.code_key === db.normKey(a.building_code))).map((a) => a.building_code))];
  const aRows = [];
  for (const a of assets) {
    const c = countsOf(media, a.id);
    let plate = false;
    if (c.photo) plate = (await getMedia(a.id, 'photo')).some((p) => p.tag === 'placa');
    aRows.push({ id: assetLabel(a), building: a.building_code, floor: a.floor, department: a.department || '—', photos: c.photo, audios: c.audio, hasNote: !!String(a.notes || '').trim() || c.audio > 0, plate, pending: isPending(a), copied: !!a.copied_from, created: String(a.created_at || '').slice(0, 10) });
  }
  aRows.sort((x, y) => byCode(x.id, y.id));
  const deptMap = new Map();
  for (const a of aRows) { const k = a.department; deptMap.set(k, (deptMap.get(k) || 0) + 1); }
  const floorMap = new Map();
  for (const a of aRows) { const k = `${a.building} · ${floorLabel(a.floor)}`; floorMap.set(k, (floorMap.get(k) || 0) + 1); }
  const today = nowIso().slice(0, 10);
  const perDay = new Map();
  for (const a of aRows) perDay.set(a.created, (perDay.get(a.created) || 0) + 1);
  return {
    project: { name: project.name, client: project.client || '', site: project.site || '', units: project.units, valuer: project.valuer_code || '' },
    inspector, generatedAt: nowIso(), fieldTotal, drafts,
    buildings: bRows, assets: aRows, orphanCodes,
    byDepartment: [...deptMap.entries()].sort((a, b) => b[1] - a[1] || byCode(a[0], b[0])),
    byFloor: [...floorMap.entries()].sort((a, b) => byCode(a[0], b[0])),
    perDay: [...perDay.entries()].sort((a, b) => byCode(b[0], a[0])).slice(0, 10),
    totals: {
      buildings: bRows.length, inspected: bRows.filter((b) => b.status === 'inspected').length, inProgress: bRows.filter((b) => b.status === 'in_progress').length, pending: bRows.filter((b) => b.status === 'pending').length,
      assets: aRows.length, today: aRows.filter((a) => a.created === today).length, toExport: aRows.filter((a) => a.pending).length,
      photos: aRows.reduce((s, a) => s + a.photos, 0) + bRows.reduce((s, b) => s + b.photos, 0), audios: aRows.reduce((s, a) => s + a.audios, 0) + bRows.reduce((s, b) => s + b.audios, 0),
      noPhoto: aRows.filter((a) => !a.photos).length, noNote: aRows.filter((a) => !a.hasNote).length, noPlate: aRows.filter((a) => a.photos && !a.plate).length
    }
  };
}

const STATUS_COLOR = { inspected: '#166534', in_progress: '#b45309', pending: '#475569' };
const STATUS_FILL = { inspected: '#dcfce7', in_progress: '#fef3c7', pending: null };

// Pure: report data -> PDF bytes.
export function renderReport(d) {
  const fmtDate = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? iso : t.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }); };
  const pdf = new PdfDoc({
    footer: (doc, n, total) => {
      doc.line(doc.margin, doc.height - 32, doc.width - doc.margin, doc.height - 32, { color: '#cbd5e1' });
      doc.text(doc.margin, doc.height - 28, `${d.project.name} · Reporte de avance · ${fmtDate(d.generatedAt)}`, { size: 7.5, color: '#64748b' });
      doc.text(doc.margin, doc.height - 28, `Página ${n} de ${total}`, { size: 7.5, color: '#64748b', align: 'right', width: doc.width - 2 * doc.margin });
    }
  });
  const M = pdf.margin; const W = pdf.width - 2 * M; const t = d.totals;
  // ---- header
  pdf.rect(0, 0, pdf.width, 74, { fill: '#1e3a5f' });
  pdf.text(M, 18, 'Reporte de avance del levantamiento', { size: 9, color: '#cbd5e1', bold: true });
  pdf.text(M, 32, d.project.name, { size: 20, bold: true, color: '#ffffff' });
  pdf.text(M, 56, [d.project.client, d.project.site].filter(Boolean).join(' · ') || ' ', { size: 9, color: '#e2e8f0' });
  pdf.y = 88;
  pdf.text(M, pdf.y, `Generado: ${fmtDate(d.generatedAt)}   ·   Valuador: ${d.project.valuer || '—'}${d.inspector ? ' (' + d.inspector + ')' : ''}   ·   App ${APP_VERSION}`, { size: 8.5, color: '#475569' });
  pdf.y += 20;

  // ---- KPI boxes
  const pct = t.buildings ? Math.round((t.inspected / t.buildings) * 100) : 0;
  const box = (x, w, label, value, sub, color = '#111111') => {
    pdf.rect(x, pdf.y, w, 66, { fill: '#f1f5f9' });
    pdf.text(x + 8, pdf.y + 7, label, { size: 7, bold: true, color: '#475569' });
    pdf.text(x + 8, pdf.y + 19, String(value), { size: 17, bold: true, color });
    pdf.wrap(sub || '', 7, w - 16).slice(0, 2).forEach((l, i) => pdf.text(x + 8, pdf.y + 42 + i * 9, l, { size: 7, color: '#475569' }));
  };
  const bw = (W - 3 * 8) / 4;
  box(M, bw, 'EDIFICIOS INSPECCIONADOS', `${t.inspected} / ${t.buildings}`, `${pct} % · ${t.inProgress} en proceso · ${t.pending} pendientes`, '#166534');
  box(M + (bw + 8), bw, 'ACTIVOS', t.assets, `${t.today} hoy · ${t.toExport} por exportar`);
  box(M + 2 * (bw + 8), bw, 'EVIDENCIA', `${t.photos} fotos`, `${t.audios} notas de voz`);
  box(M + 3 * (bw + 8), bw, 'POR REVISAR', t.noPhoto + t.noNote, `${t.noPhoto} sin foto · ${t.noNote} sin nota · ${t.noPlate} sin placa`, t.noPhoto + t.noNote ? '#b45309' : '#166534');
  pdf.y += 78;
  // progress bar
  pdf.rect(M, pdf.y, W, 10, { fill: '#e2e8f0' });
  if (t.buildings) {
    const wi = (W * t.inspected) / t.buildings; const wp = (W * t.inProgress) / t.buildings;
    if (wi) pdf.rect(M, pdf.y, wi, 10, { fill: '#16a34a' });
    if (wp) pdf.rect(M + wi, pdf.y, wp, 10, { fill: '#f59e0b' });
  }
  pdf.y += 14;
  pdf.text(M, pdf.y, 'Verde: inspeccionado · Ámbar: en proceso · Gris: pendiente', { size: 7.5, color: '#64748b' });
  pdf.y += 18;
  if (d.drafts) pdf.paragraph(`Hay ${d.drafts} borrador(es) sin guardar en este teléfono (no se cuentan).`, { size: 8.5, color: '#b45309' });

  const h2 = (s) => { pdf.ensure(40); pdf.y += 4; pdf.text(M, pdf.y, s, { size: 12.5, bold: true, color: '#1e3a5f' }); pdf.y += 18; };

  // ---- buildings
  h2(`Edificios (${t.buildings})`);
  if (d.buildings.length) {
    pdf.table(
      [{ title: 'Código', width: 50 }, { title: 'Nombre', width: 175 }, { title: 'Estado', width: 75 }, { title: 'Fotos', width: 40, align: 'right' }, { title: 'Voz', width: 35, align: 'right' }, { title: 'Activos', width: 45, align: 'right' }, { title: `Campos (de ${d.fieldTotal})`, width: W - 420, align: 'right' }],
      d.buildings.map((b) => [{ text: b.code, bold: true, fill: STATUS_FILL[b.status] }, b.name, { text: STATUS_LABEL[b.status], color: STATUS_COLOR[b.status], bold: true }, { text: String(b.photos), color: b.photos ? '#111111' : '#b45309' }, String(b.audios), String(b.assets), String(b.filled)])
    );
  } else pdf.paragraph('Aún no hay edificios en el proyecto.', { size: 9, color: '#475569' });
  if (d.orphanCodes.length) pdf.paragraph(`Activos con edificio que no está en la lista: ${d.orphanCodes.join(', ')}.`, { size: 8.5, color: '#b45309' });

  // ---- assets by department / building-floor
  h2('Activos por departamento');
  if (d.byDepartment.length) pdf.table([{ title: 'Departamento', width: W - 80 }, { title: 'Activos', width: 80, align: 'right' }], d.byDepartment.map(([k, n]) => [k, String(n)]));
  else pdf.paragraph('Aún no hay activos.', { size: 9, color: '#475569' });
  if (d.byFloor.length) { h2('Activos por edificio y piso'); pdf.table([{ title: 'Edificio · piso', width: W - 80 }, { title: 'Activos', width: 80, align: 'right' }], d.byFloor.map(([k, n]) => [k, String(n)])); }
  if (d.perDay.length) { h2('Activos registrados por día (últimos 10 días con registros)'); pdf.table([{ title: 'Fecha', width: W - 80 }, { title: 'Activos', width: 80, align: 'right' }], d.perDay.map(([k, n]) => [k, String(n)])); }

  // ---- to review
  const list = (title, rows, note) => {
    h2(`${title} (${rows.length})`);
    if (!rows.length) { pdf.paragraph('Ninguno.', { size: 9, color: '#166534' }); return; }
    if (note) pdf.paragraph(note, { size: 8.5, color: '#475569' });
    pdf.table([{ title: 'ID', width: 95 }, { title: 'Edificio', width: 60 }, { title: 'Piso', width: 70 }, { title: 'Departamento', width: W - 345 }, { title: 'Fotos', width: 40, align: 'right' }, { title: 'Voz', width: 40, align: 'right' }, { title: 'Fecha', width: 40 }],
      rows.map((a) => [{ text: a.id, bold: true }, a.building, floorLabel(a.floor), a.department + (a.copied ? ' (copia)' : ''), String(a.photos), String(a.audios), a.created.slice(5)]));
  };
  list('Activos sin foto', d.assets.filter((a) => !a.photos));
  list('Activos sin nota (ni texto ni voz)', d.assets.filter((a) => !a.hasNote));
  list('Activos con fotos pero sin foto de placa', d.assets.filter((a) => a.photos && !a.plate), 'Puede que la placa esté entre las fotos sin clasificar; si el equipo no tiene placa, ignorar.');
  const bNoPhoto = d.buildings.filter((b) => !b.photos);
  h2(`Edificios sin foto (${bNoPhoto.length})`);
  pdf.paragraph(bNoPhoto.length ? bNoPhoto.map((b) => `${b.code} ${b.name}`).join(' · ') : 'Ninguno.', { size: 9, color: bNoPhoto.length ? '#111111' : '#166534' });
  return pdf.output();
}

export async function buildReportPdf(project) {
  const data = await gatherReport(project);
  const bytes = renderReport(data);
  const stamp = data.generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return { blob: new Blob([bytes], { type: 'application/pdf' }), name: `avance_${projectSlug(project)}_${stamp}.pdf`, data };
}

// Build the PDF and share it (WhatsApp, Teams, Outlook, Drive…) where Web Share with files is supported;
// download otherwise. PDF is an allowed share type on Android Chrome and iOS Safari.
export async function shareReport(h, { download = false } = {}) {
  const r = await buildReportPdf(h.state.project);
  const file = new File([r.blob], r.name, { type: 'application/pdf' });
  if (!download) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: r.name, text: `Avance ${h.state.project.name}` }); return 'shared'; }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  h.download(r.name, r.blob);
  return 'downloaded';
}
