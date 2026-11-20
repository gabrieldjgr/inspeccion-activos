// Buildings (v0.3 F2): list with inspection status and the structured form that mirrors the Excel.
// The form writes only the building record; photos/audio live in 'blobs' with asset_id = building.id.
import * as db from './db.js';
import { nowIso, mediaCounts, mediaIndex, countsOf } from './data.js';
import { buildTemplate, parseBuildingsFile, planImport } from './bldg-import.js';
import { projectSlug } from './projects.js';
import { mountPhotos } from './photos.js';
import { mountAudio } from './audio.js';
import { pick, quickBuilding, leave as leaveAssets } from './assets.js';
import {
  FIELD, DATA_FIELDS, SECTIONS, UNIT_LABEL, ISO_HELP, evalExpr, convert, projectUnit, measureIn, validateYear,
  optionsFor, listScope, isFilled, sectionProgress, emptyFieldLabels, buildingStatus, STATUS_LABEL
} from './bldg-schema.js';

let cleanup = null;
export function leave() { if (cleanup) { const c = cleanup; cleanup = null; try { c(); } catch (e) { console.error(e); } } }

const byCode = (a, b) => a.code.localeCompare(b.code, 'es', { numeric: true });
const normSearch = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtNum = (n) => (n == null ? '' : Number(n).toLocaleString('es', { maximumFractionDigits: 2 }));

// ---------- project lists ("Otro…" values available to the whole project) ----------
export const listId = (projectId, scope, value) => `${projectId}|${scope}|${db.normKey(value)}`;
export async function addListValue(projectId, scope, value) {
  const v = db.cleanText(value).toUpperCase();
  if (!v) return null;
  await db.put('lists', { id: listId(projectId, scope, v), project_id: projectId, field: scope, value: v, created_at: nowIso() });
  return v;
}

function textPrompt(h, { title, label, value = '', help = '' }) {
  return new Promise((resolve) => {
    const d = h.$dlg;
    d.innerHTML = `<h2 style="margin-top:0">${h.esc(title)}</h2><label for="tp-v">${h.esc(label)}</label>
      <input id="tp-v" type="text" value="${h.esc(value)}" autocomplete="off" autocapitalize="characters">
      ${help ? `<p class="muted small">${h.esc(help)}</p>` : ''}
      <div class="actions"><button class="btn primary" id="tp-ok">Agregar</button><button class="btn" id="tp-no">Cancelar</button></div>`;
    let r = null;
    d.querySelector('#tp-ok').onclick = () => { r = d.querySelector('#tp-v').value.trim() || null; d.close(); };
    d.querySelector('#tp-no').onclick = () => d.close();
    d.onclose = () => resolve(r);
    d.showModal();
    d.querySelector('#tp-v').focus();
  });
}

// ---------- list view ----------
const view = { pid: null, status: 'all', q: '' };

export async function viewBuildings(h) {
  leave(); leaveAssets();
  const pid = h.state.project.id;
  if (view.pid !== pid) Object.assign(view, { pid, status: 'all', q: '' });
  const [rows, assets, media] = await Promise.all([db.getByProject('buildings', pid), db.getByProject('assets', pid), mediaIndex()]);
  rows.sort(byCode);
  const nAssets = new Map();
  for (const a of assets) if (a.status === 'saved') { const k = a.building_id || db.normKey(a.building_code); nAssets.set(k, (nAssets.get(k) || 0) + 1); }
  const info = rows.map((b) => {
    const c = countsOf(media, b.id);
    const filled = DATA_FIELDS.filter((f) => !f.office && isFilled(f, b.fields)).length;
    return { b, c, st: buildingStatus(b, c), filled, assets: (nAssets.get(b.id) || 0) + (nAssets.get(b.code_key) || 0) };
  });
  const totals = { pending: 0, in_progress: 0, inspected: 0 };
  info.forEach((x) => totals[x.st]++);
  const totalFields = DATA_FIELDS.filter((f) => !f.office).length;
  const pct = rows.length ? Math.round((totals.inspected / rows.length) * 100) : 0;

  h.$app.innerHTML = `
    <h1>Edificios</h1>
    ${rows.length ? `<div class="card bprog">
      <div class="bprog-head"><strong>${totals.inspected} de ${rows.length} inspeccionados</strong><span>${pct} % <button type="button" class="btn bpdf" id="b-pdf">📄 Reporte</button></span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="bstats" role="group" aria-label="Filtrar por estado">
        <button type="button" class="bstat st-pending${view.status === 'pending' ? ' on' : ''}" data-st="pending"><b>${totals.pending}</b><span>Pendientes</span></button>
        <button type="button" class="bstat st-in_progress${view.status === 'in_progress' ? ' on' : ''}" data-st="in_progress"><b>${totals.in_progress}</b><span>En proceso</span></button>
        <button type="button" class="bstat st-inspected${view.status === 'inspected' ? ' on' : ''}" data-st="inspected"><b>${totals.inspected}</b><span>Inspeccionados</span></button>
      </div></div>` : ''}
    <div class="row">
      <button class="btn primary" id="b-add">+ Nuevo edificio</button>
      <button class="btn" id="b-import">⬆ Importar Excel</button>
    </div>
    <details class="card bmore"><summary>Plantilla y exportación a Excel</summary>
      <p class="muted small">Plantilla con las mismas columnas y listas del Excel de levantamiento. Llénala (o copia y pega desde el archivo fuente) e impórtala aquí. También se puede importar directamente el archivo fuente o un CSV.</p>
      <div class="row">
        <button class="btn" id="b-tpl">⬇ Plantilla vacía</button>
        <button class="btn" id="b-xls"${rows.length ? '' : ' disabled'}>⬇ Edificios a Excel</button>
      </div>
    </details>
    <input id="b-file" class="sr" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" tabindex="-1">
    ${rows.length ? `<input id="b-q" type="search" placeholder="Buscar código o nombre…" aria-label="Buscar edificio" value="${h.esc(view.q)}" style="margin-top:12px">` : ''}
    <div id="b-list"></div>
    ${!rows.length ? '<div class="card empty-state"><span class="big-emoji">🏢</span><strong>Aún no hay edificios</strong><p class="muted">Créalos aquí o al registrar un activo, o importa la lista.</p></div>' : ''}`;

  const $ = (s) => h.$app.querySelector(s);
  const draw = () => {
    const q = normSearch(view.q).trim();
    const list = info.filter((x) => (view.status === 'all' || x.st === view.status) && (!q || normSearch(x.b.code + ' ' + x.b.name).includes(q)));
    const el = $('#b-list'); if (!el) return;
    el.innerHTML = list.length || !rows.length ? `<ul class="blist">${list.map((x) => `<li><a class="bitem st-${x.st}" href="#/edificio?id=${h.esc(x.b.id)}">
      <span class="bdot" aria-hidden="true"></span>
      <span class="binfo"><span class="bline"><strong>${h.esc(x.b.code)}</strong><span class="bst">${STATUS_LABEL[x.st]}</span></span>
      <span class="bname">${h.esc(x.b.name)}</span>
      <span class="chips"><span class="chip${x.c.photo ? '' : ' warn'}">📷 ${x.c.photo}</span><span class="chip">🎙 ${x.c.audio}</span><span class="chip">📦 ${x.assets} activos</span><span class="chip">📝 ${x.filled}/${totalFields}</span>${x.b.source === 'field' ? '<span class="chip">creado en campo</span>' : ''}</span></span></a></li>`).join('')}</ul>`
      : '<div class="card empty-state"><strong>Ningún edificio coincide</strong></div>';
  };
  h.$app.querySelectorAll('.bstat').forEach((b) => (b.onclick = () => { view.status = view.status === b.dataset.st ? 'all' : b.dataset.st; viewBuildings(h); }));
  const pdf = $('#b-pdf'); if (pdf) pdf.onclick = async () => {
    pdf.disabled = true;
    try { const { shareReport } = await import('./report.js'); await shareReport(h); } catch (e) { h.reportError(e); } finally { pdf.disabled = false; }
  };
  const q = $('#b-q'); if (q) q.addEventListener('input', () => { view.q = q.value; draw(); });
  $('#b-add').onclick = async () => {
    const b = await quickBuilding(h, h.state.project, rows, '');
    if (b) h.navigate('#/edificio?id=' + encodeURIComponent(b.id));
  };
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const custom = () => db.getByProject('lists', pid);
  $('#b-tpl').onclick = async () => {
    try {
      const bytes = buildTemplate({ units: h.state.project.units, custom: await custom(), projectName: h.state.project.name });
      h.download(`plantilla_edificios_${projectSlug(h.state.project)}.xlsx`, new Blob([bytes], { type: XLSX_TYPE }));
    } catch (e) { h.reportError(e); }
  };
  $('#b-xls').onclick = async () => {
    try {
      const bytes = buildTemplate({ units: h.state.project.units, custom: await custom(), projectName: h.state.project.name, buildings: rows });
      h.download(`edificios_${projectSlug(h.state.project)}.xlsx`, new Blob([bytes], { type: XLSX_TYPE }));
    } catch (e) { h.reportError(e); }
  };
  const $file = $('#b-file');
  $('#b-import').onclick = () => { $file.value = ''; $file.click(); };
  $file.onchange = () => importFile(h, $file.files[0]);
  draw();
}

// ---------- import with preview ----------
const MODES = {
  fill: 'Agregar nuevos y completar solo los campos vacíos (recomendado: no pisa lo capturado en campo)',
  overwrite: 'Agregar nuevos y sobrescribir con los valores del archivo',
  new: 'Solo agregar edificios nuevos'
};
const lineList = (lines) => (lines.length > 8 ? lines.slice(0, 8).join(', ') + ` y ${lines.length - 8} más` : lines.join(', '));

async function importFile(h, file) {
  if (!file) return;
  const pid = h.state.project.id;
  const units = h.state.project.units || 'imperial';
  let parsed;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    parsed = parseBuildingsFile(bytes, file.name, { projectUnits: units, custom: await db.getByProject('lists', pid) });
  } catch (e) { h.reportError(e); return; }
  if (!parsed.rows.length) {
    await h.ask('No se pudo importar', `<ul>${parsed.errors.map((e) => `<li>${e.line ? `Fila ${e.line}: ` : ''}${h.esc(e.msg)}</li>`).join('')}</ul>`, [{ label: 'Cerrar', value: null, cls: 'primary' }]);
    return;
  }
  const existing = await db.getByProject('buildings', pid);
  let mode = 'fill';
  const d = h.$dlg;
  const draw = () => {
    const plan = planImport(parsed, existing, mode);
    const unitNote = parsed.units !== units
      ? `<p class="warn-box">El archivo está en <strong>${parsed.units === 'metric' ? 'metros' : 'pies'}</strong> y el proyecto en <strong>${units === 'metric' ? 'metros' : 'pies'}</strong>. Las medidas se guardan con la unidad del archivo y la app las convierte.</p>` : '';
    d.innerHTML = `<h2 style="margin-top:0">Importar edificios</h2>
      <div class="scroll tall">
        <p class="muted small">${h.esc(file.name)}${parsed.sheet ? ` · hoja “${h.esc(parsed.sheet)}”` : ''} · unidades: ${parsed.units === 'metric' ? 'métricas' : 'imperiales'}${parsed.unitsFromFile ? ' (según los encabezados)' : ' (del proyecto)'}</p>
        ${unitNote}
        <div class="imp-stats"><div><b>${plan.create.length}</b><span>nuevos</span></div><div><b>${plan.update.length}</b><span>se actualizan</span></div><div><b>${plan.unchanged.length}</b><span>sin cambios</span></div><div class="${parsed.errors.length ? 'bad' : ''}"><b>${parsed.errors.length}</b><span>filas con error</span></div></div>
        ${existing.length ? `<fieldset class="imp-mode"><legend>Edificios que ya existen (mismo código)</legend>${Object.entries(MODES).map(([k, l]) => `<label class="radio"><input type="radio" name="imp-mode" value="${k}"${mode === k ? ' checked' : ''}> ${l}</label>`).join('')}</fieldset>` : ''}
        ${mode === 'fill' && plan.conflicts.length ? `<p class="muted small">${plan.conflicts.length} campo(s) ya tenían otro valor en la app y se conservan.</p>` : ''}
        ${parsed.errors.length ? `<h3 class="imp-h bad">Filas que no se importan</h3><ul class="imp-list">${parsed.errors.map((e) => `<li><strong>Fila ${e.line}</strong>: ${h.esc(e.msg)}</li>`).join('')}</ul>` : ''}
        ${parsed.outOfList.length ? `<h3 class="imp-h">Valores fuera de lista</h3><ul class="imp-list">${parsed.outOfList.map((o) => `<li><strong>${h.esc(o.label)} (${o.col})</strong>: “${h.esc(o.value)}” — filas ${lineList(o.lines)}</li>`).join('')}</ul>
          <label class="switch"><input type="checkbox" id="imp-addlists" checked> Agregarlos a las listas del proyecto</label>` : ''}
        ${parsed.warnings.length ? `<h3 class="imp-h">Avisos (${parsed.warnings.length})</h3><ul class="imp-list">${parsed.warnings.slice(0, 60).map((e) => `<li>${e.line ? `<strong>Fila ${e.line}</strong>: ` : ''}${h.esc(e.msg)}</li>`).join('')}${parsed.warnings.length > 60 ? `<li>… y ${parsed.warnings.length - 60} más</li>` : ''}</ul>` : ''}
        ${parsed.ignored.length ? `<p class="muted small">Columnas no reconocidas (se ignoran): ${parsed.ignored.map(h.esc).join(' · ')}</p>` : ''}
      </div>
      <div class="actions"><button class="btn primary" id="imp-go"${plan.create.length + plan.update.length ? '' : ' disabled'}>Importar ${plan.create.length + plan.update.length} edificio(s)</button><button class="btn" id="imp-cancel">Cancelar</button></div>`;
    d.querySelectorAll('input[name=imp-mode]').forEach((r) => (r.onchange = () => { mode = r.value; draw(); }));
    d.querySelector('#imp-cancel').onclick = () => d.close();
    d.querySelector('#imp-go').onclick = async () => {
      const addLists = !!d.querySelector('#imp-addlists')?.checked;
      d.querySelector('#imp-go').disabled = true;
      try {
        const now = nowIso();
        const creates = plan.create.map((r) => ({ id: crypto.randomUUID(), project_id: pid, code: r.code, code_key: db.normKey(r.code), name: r.name || r.code, fields: r.fields, source: 'import', created_at: now, updated_at: now }));
        const updates = plan.update.map((u) => ({ ...u.cur, name: u.name || u.cur.name, fields: u.fields, updated_at: now }));
        const lists = addLists ? parsed.outOfList.map((o) => ({ id: listId(pid, o.scope, o.value), project_id: pid, field: o.scope, value: o.value, created_at: now })) : [];
        await db.tx(['buildings', 'lists'], 'readwrite', (st) => { for (const b of [...creates, ...updates]) st.buildings.put(b); for (const l of lists) st.lists.put(l); });
        d.close();
        h.showBanner('imp', 'info', `Importación lista: ${creates.length} nuevos, ${updates.length} actualizados${lists.length ? `, ${lists.length} valor(es) agregados a las listas` : ''} ✓`, [{ label: 'OK', onClick: () => h.hideBanner('imp') }]);
        await viewBuildings(h);
      } catch (e) { d.close(); h.reportError(e); }
    };
  };
  d.onclose = null;
  draw();
  d.showModal();
}

// ---------- building form ----------
function controlHtml(h, f, b, ctx) {
  const v = b.fields?.[f.key];
  const id = 'bf-' + f.key;
  const help = f.help ? `<p class="muted small bf-help">${h.esc(f.help)}</p>` : '';
  const lab = `<label for="${id}">${h.esc(f.label)} <span class="bf-col">${f.col}</span></label>`;
  switch (f.type) {
    case 'text': case 'storeys':
      return `<div class="bf" data-k="${f.key}">${lab}${f.multiline
        ? `<textarea id="${id}" rows="3">${h.esc(v ?? '')}</textarea>`
        : `<input id="${id}" type="text" value="${h.esc(v ?? '')}" autocomplete="off"${f.suggest ? ` list="dl-${f.key}"` : ''}>`}${f.suggest ? `<datalist id="dl-${f.key}">${(ctx.suggest[f.key] || []).map((s) => `<option value="${h.esc(s)}">`).join('')}</datalist>` : ''}${help}</div>`;
    case 'year':
      return `<div class="bf" data-k="${f.key}">${lab}<input id="${id}" type="text" inputmode="numeric" value="${h.esc(v ?? '')}" autocomplete="off"><p class="bad small bf-err" id="${id}-err"></p>${help}</div>`;
    case 'percent':
      return `<div class="bf" data-k="${f.key}">${lab}<div class="bf-unitrow"><input id="${id}" type="number" inputmode="decimal" min="0" max="100" step="any" value="${h.esc(v ?? '')}"><span class="bf-unit static">%</span></div>${help}</div>`;
    case 'area': case 'length': {
      const unit = v?.unit || ctx.unitPref[f.type];
      return `<div class="bf" data-k="${f.key}">${lab}<div class="bf-unitrow"><input id="${id}" type="text" inputmode="text" value="${h.esc(v?.expr ?? (v?.value ?? ''))}" placeholder="${f.type === 'area' ? 'Ej.: 45.5*10.5 + 20*30' : 'Ej.: 7.5'}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn bf-unit" data-unit="${f.key}" aria-label="Cambiar unidad">${UNIT_LABEL[unit]}</button></div>
        <p class="small bf-res" id="${id}-res"></p></div>`;
    }
    case 'yesno':
      return `<div class="bf" data-k="${f.key}"><span class="bf-l">${h.esc(f.label)} <span class="bf-col">${f.col}</span></span><div class="seg" role="group" aria-label="${h.esc(f.label)}">${[['YES', 'Sí'], ['NO', 'No'], ['', '—']].map(([val, l]) => `<button type="button" class="seg-b${(v || '') === val ? ' on' : ''}" data-yn="${f.key}" data-v="${val}">${l}</button>`).join('')}</div></div>`;
    case 'list': {
      const disabled = f.dependsOn && !b.fields?.[f.dependsOn];
      const sub = f.key === 'iso_code' && v ? ISO_HELP[v] : '';
      return `<div class="bf" data-k="${f.key}"><span class="bf-l">${h.esc(f.label)} <span class="bf-col">${f.col}</span></span>
        <button type="button" class="btn bf-pick${v ? ' set' : ''}" data-pick="${f.key}"${disabled ? ' disabled' : ''}>${v ? h.esc(v) : disabled ? 'Elige primero la categoría' : 'Elegir…'}</button>${sub ? `<p class="muted small bf-help">${h.esc(sub)}</p>` : ''}</div>`;
    }
    default: return '';
  }
}

export async function viewBuildingForm(h, id) {
  leave(); leaveAssets();
  const b = id ? await db.get('buildings', id) : null;
  if (!b || b.project_id !== h.state.project.id) { h.$app.innerHTML = '<div class="card empty-state"><strong>Edificio no encontrado</strong><p><a href="#/edificios">Volver a edificios</a></p></div>'; return; }
  b.fields = b.fields || {};
  const pid = b.project_id;
  const units = h.state.project.units || 'imperial';
  const [quality, cameraMode, custom, all, prefA, prefL] = await Promise.all([
    db.getSetting('photo_quality', 'alta'), db.getSetting('camera_mode', 'sistema'), db.getByProject('lists', pid), db.getByProject('buildings', pid),
    db.getSetting(`unitpref|${pid}|area`, null), db.getSetting(`unitpref|${pid}|length`, null)
  ]);
  const ctx = {
    unitPref: { area: prefA || projectUnit('area', units), length: prefL || projectUnit('length', units) },
    suggest: { occupancy: [...new Set(all.map((x) => x.fields?.occupancy).filter(Boolean))].sort() }
  };
  const open = new Set(JSON.parse(sessionStorage.getItem('bf-open') || '["ident","geo"]'));
  let chain = Promise.resolve();
  let counts = await mediaCounts(b.id);
  const openCounts = { ...counts };
  const nAssets = (await db.getByProject('assets', pid)).filter((a) => a.building_id === b.id || (!a.building_id && db.normKey(a.building_code) === b.code_key)).length;
  const mounts = [];
  let alive = true; // false once the view is left: late callbacks must not paint another page

  const persist = (fieldEdit = true) => {
    const now = nowIso();
    b.updated_at = now;
    if (fieldEdit) b.field_updated_at = now;
    const snap = JSON.parse(JSON.stringify(b));
    chain = chain.then(() => db.put('buildings', snap)).catch((e) => h.reportError(e));
    paintStatus();
    return chain;
  };

  const sectionHtml = (s) => {
    const fs = DATA_FIELDS.filter((f) => f.section === s.key);
    const p = sectionProgress(s.key, b.fields);
    return `<details class="card bsec" data-sec="${s.key}"${open.has(s.key) ? ' open' : ''}><summary><span>${h.esc(s.title)}</span><span class="bsec-p${p.filled === p.total ? ' done' : ''}" id="sp-${s.key}">${p.filled}/${p.total}</span></summary>
      ${s.key === 'ident' ? `<div class="bf"><label for="bf-name">Nombre del edificio <span class="bf-col">B</span></label><input id="bf-name" type="text" value="${h.esc(b.name)}" autocomplete="off"></div>` : ''}
      ${s.key === 'areas' ? '<p class="muted small">Escribe el número o una operación en la unidad del botón (m² o ft²): <code>45.5*10.5 + 85*108.5</code>. Se guarda la operación y el resultado.</p>' : ''}
      ${s.key === 'office' ? '<p class="muted small">Opcional. Normalmente vienen de la precarga o se calculan en oficina.</p>' : ''}
      ${fs.map((f) => controlHtml(h, f, b, ctx)).join('')}</details>`;
  };

  h.$app.innerHTML = `
    <div class="bhead"><h1>${h.esc(b.code)} <span class="muted h1-sub" id="bh-name">${h.esc(b.name)}</span></h1><span class="bst-chip" id="b-st"></span></div>
    <div class="card" id="slot-photos"></div>
    <div class="card" id="slot-audio"></div>
    <p class="muted small voice-hint">💡 Puedes dictar todo en una nota de voz: uso, niveles, estructura, muros, techo, protección contra incendio, HVAC, servicios. La IA llenará los campos después.</p>
    <div class="card"><label for="bf-notes">Notas generales</label><textarea id="bf-notes" rows="4" placeholder="Observaciones, estado, ampliaciones, daños…">${h.esc(b.notes || '')}</textarea></div>
    <div id="secs">${SECTIONS.map(sectionHtml).join('')}</div>
    <p id="b-msg" class="bad" role="alert"></p>
    <div class="savebar" id="b-bar"></div>`;
  const $ = (s) => h.$app.querySelector(s);

  function paintSection(key) {
    if (!alive) return;
    const p = sectionProgress(key, b.fields);
    const el = $('#sp-' + key); if (!el) return;
    el.textContent = `${p.filled}/${p.total}`; el.classList.toggle('done', p.filled === p.total);
  }
  function paintStatus() {
    if (!alive) return;
    const st = buildingStatus(b, counts);
    const el = $('#b-st'); if (!el) return;
    el.className = 'bst-chip st-' + st; el.textContent = STATUS_LABEL[st];
    const bar = $('#b-bar');
    const inspected = st === 'inspected';
    bar.innerHTML = inspected
      ? `<p class="ok bdone">✓ Inspeccionado ${b.inspected_at ? 'el ' + h.esc(new Date(b.inspected_at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })) : ''}</p><button class="btn primary" id="b-done">Listo</button><button class="btn" id="b-unmark">Desmarcar</button>`
      : `<button class="btn primary" id="b-mark"${counts.photo ? '' : ' disabled'}>✓ Marcar inspeccionado</button><button class="btn" id="b-done">Listo</button>${counts.photo ? '' : '<p class="muted small bhint">Para marcarlo inspeccionado toma al menos una foto.</p>'}`;
    if (!nAssets && !counts.photo && !counts.audio) bar.insertAdjacentHTML('beforeend', '<button class="btn danger subtle" id="b-del">Borrar edificio</button>');
    const bd = $('#b-del'); if (bd) bd.onclick = async () => {
      if (!(await h.confirmDlg('Borrar edificio', `<p>¿Borrar <strong>${h.esc(b.code)}</strong> (${h.esc(b.name)}) y sus datos? No tiene activos ni fotos.</p>`, 'Borrar', 'danger'))) return;
      alive = false; await chain; await db.del('buildings', b.id); h.navigate('#/edificios');
    };
    $('#b-done').onclick = () => h.navigate('#/edificios');
    const mk = $('#b-mark'); if (mk) mk.onclick = markInspected;
    const um = $('#b-unmark'); if (um) um.onclick = () => { b.inspected_at = null; persist(false); };
  }
  async function markInspected() {
    await chain;
    counts = await mediaCounts(b.id);
    if (!counts.photo) { paintStatus(); return; }
    const empty = emptyFieldLabels(b.fields);
    const body = empty.length
      ? `<p>Quedan <strong>${empty.length}</strong> campos sin llenar:</p><p class="muted small">${empty.map(h.esc).join(' · ')}</p><p>Puedes marcarlo igual: la IA podrá completarlos con tus fotos, audios y notas.</p>`
      : '<p>Todos los campos de campo están llenos. 👍</p>';
    if (!(await h.confirmDlg('Marcar inspeccionado', body, 'Marcar inspeccionado'))) return;
    b.inspected_at = nowIso();
    await persist(false);
    try { navigator.vibrate?.(40); } catch (_) { /* ignore */ }
    h.showBanner('bins', 'info', `${h.esc(b.code)} inspeccionado ✓`, [{ label: 'OK', onClick: () => h.hideBanner('bins') }]);
    setTimeout(() => h.hideBanner('bins'), 3000);
  }

  // ---- field events
  const setField = (k, val) => {
    if (val === '' || val == null) delete b.fields[k]; else b.fields[k] = val;
    paintSection(FIELD[k].section);
    return persist();
  };
  let tName = null;
  $('#bf-name').addEventListener('input', (e) => { clearTimeout(tName); tName = setTimeout(() => { const n = db.cleanText(e.target.value); if (n) { b.name = n; $('#bh-name').textContent = n; persist(); } }, 400); });
  let tNotes = null;
  $('#bf-notes').addEventListener('input', (e) => { clearTimeout(tNotes); tNotes = setTimeout(() => { b.notes = e.target.value; persist(false); }, 400); });

  // Debounced field writes; pending ones run immediately when the view is left or hidden.
  const debounce = new Map(); // key -> {t, fn}
  const later = (k, fn) => {
    clearTimeout(debounce.get(k)?.t);
    debounce.set(k, { fn, t: setTimeout(() => { debounce.delete(k); fn(); }, 400) });
  };
  for (const f of DATA_FIELDS) {
    const input = $('#bf-' + f.key);
    if (!input) continue;
    if (f.type === 'text' || f.type === 'storeys') input.addEventListener('input', () => later(f.key, () => setField(f.key, f.multiline ? input.value.trim() : db.cleanText(input.value))));
    if (f.type === 'year') input.addEventListener('input', () => later(f.key, () => { const err = validateYear(input.value); if (alive) $('#bf-' + f.key + '-err').textContent = err || ''; setField(f.key, db.cleanText(input.value)); }));
    if (f.type === 'percent') input.addEventListener('input', () => later(f.key, () => { const n = input.value === '' ? '' : Math.max(0, Math.min(100, Number(input.value))); setField(f.key, n === '' || Number.isNaN(n) ? '' : n); }));
    if (f.type === 'area' || f.type === 'length') {
      const res = $('#bf-' + f.key + '-res');
      const show = () => {
        if (!alive) return;
        const m = b.fields[f.key];
        if (!m) { res.textContent = ''; res.className = 'small bf-res'; return; }
        const pu = projectUnit(f.type, units);
        const conv = m.unit !== pu ? ` = ${fmtNum(measureIn(m, f.type, units))} ${UNIT_LABEL[pu]}` : '';
        res.className = 'small bf-res ok'; res.textContent = `${fmtNum(m.value)} ${UNIT_LABEL[m.unit]}${conv}`;
      };
      show();
      input.addEventListener('input', () => later(f.key, () => {
        const unit = b.fields[f.key]?.unit || ctx.unitPref[f.type];
        const txt = input.value.trim();
        if (!txt) { setField(f.key, ''); show(); return; }
        try {
          const value = evalExpr(txt);
          if (value < 0) throw new Error('El resultado es negativo');
          setField(f.key, { value, unit, expr: /^[\d.,\s]+$/.test(txt) ? null : txt });
          show();
        } catch (e) { if (alive) { res.className = 'small bf-res bad'; res.textContent = '⚠ ' + e.message + ' (no se guardó)'; } }
      }));
    }
  }
  // unit toggles: change the unit of what was typed (the number stays as typed, the unit flips)
  h.$app.querySelectorAll('[data-unit]').forEach((btn) => (btn.onclick = async () => {
    const f = FIELD[btn.dataset.unit];
    const pair = f.type === 'area' ? ['m2', 'ft2'] : ['m', 'ft'];
    const cur = b.fields[f.key]?.unit || ctx.unitPref[f.type];
    const next = cur === pair[0] ? pair[1] : pair[0];
    btn.textContent = UNIT_LABEL[next];
    ctx.unitPref[f.type] = next;
    await db.setSetting(`unitpref|${pid}|${f.type}`, next);
    if (b.fields[f.key]) { b.fields[f.key] = { ...b.fields[f.key], unit: next }; await persist(); }
    $('#bf-' + f.key).dispatchEvent(new Event('input'));
  }));
  h.$app.querySelectorAll('[data-yn]').forEach((btn) => (btn.onclick = () => {
    const k = btn.dataset.yn;
    btn.parentElement.querySelectorAll('.seg-b').forEach((x) => x.classList.toggle('on', x === btn));
    setField(k, btn.dataset.v);
  }));
  h.$app.querySelectorAll('[data-pick]').forEach((btn) => (btn.onclick = async () => {
    const f = FIELD[btn.dataset.pick];
    const lists = await db.getByProject('lists', pid);
    const opts = optionsFor(f, b.fields, lists);
    const items = [...opts.map((o) => ({ value: o, label: o, sub: f.key === 'iso_code' ? ISO_HELP[o] : '' })), ...(b.fields[f.key] ? [{ value: '__clear', label: '— Quitar valor' }] : [])];
    const r = await pick(h, { title: f.label, items, current: b.fields[f.key], newLabel: f.closed ? null : 'Otro valor', newAlways: !f.closed });
    let val = null;
    if (r?.created !== undefined && r !== null) {
      const typed = r.created || await textPrompt(h, { title: 'Otro valor', label: f.label, help: 'Quedará disponible para todos los edificios de este proyecto.' });
      if (typed) val = await addListValue(pid, listScope(f, b.fields), typed);
    } else if (r?.value) val = r.value === '__clear' ? '' : r.value;
    if (val === null) return;
    await setField(f.key, val);
    if (f.key === 'hvac_category') { // dependent list: drop a type that no longer belongs to the category
      const t = b.fields.hvac_type;
      if (t && !optionsFor(FIELD.hvac_type, b.fields, lists).includes(t)) await setField('hvac_type', '');
      if (val === 'NO') await setField('hvac_type', 'N/A');
    }
    rerenderSection(f.section);
    if (f.key === 'hvac_category') rerenderSection('serv');
  }));
  function rerenderSection(key) {
    // Simple and safe: re-render the whole form state (inputs keep b.fields as source of truth).
    sessionStorage.setItem('bf-open', JSON.stringify([...h.$app.querySelectorAll('details.bsec[open]')].map((d) => d.dataset.sec)));
    const y = window.scrollY;
    viewBuildingForm(h, b.id).then(() => window.scrollTo(0, y));
  }
  h.$app.querySelectorAll('details.bsec').forEach((d) => d.addEventListener('toggle', () => {
    sessionStorage.setItem('bf-open', JSON.stringify([...h.$app.querySelectorAll('details.bsec[open]')].map((x) => x.dataset.sec)));
  }));

  // ---- media (owner = building id; modules never write the building record)
  try {
    const ph = await mountPhotos($('#slot-photos'), { id: b.id }, { quality, cameraMode });
    mounts.push(ph);
    ph.onChange?.(async () => { counts = await mediaCounts(b.id); paintStatus(); });
  } catch (e) { $('#slot-photos').innerHTML = `<p class="bad">No se pudo cargar el módulo de fotos: ${h.esc(e.message)}</p>`; }
  try { mounts.push(await mountAudio($('#slot-audio'), { id: b.id })); } catch (e) { $('#slot-audio').innerHTML = `<p class="bad">No se pudo cargar el módulo de audio: ${h.esc(e.message)}</p>`; }
  paintStatus();

  const onHide = () => { if (document.visibilityState === 'hidden') flushAll(); };
  function flushAll() {
    clearTimeout(tName); clearTimeout(tNotes);
    const n = db.cleanText($('#bf-name')?.value || ''); if (n && n !== b.name) { b.name = n; persist(); }
    const notes = $('#bf-notes')?.value; if (notes != null && notes !== (b.notes || '')) { b.notes = notes; persist(false); }
    for (const [k, d] of [...debounce]) { clearTimeout(d.t); debounce.delete(k); d.fn(); }
  }
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushAll);
  cleanup = () => {
    flushAll();
    alive = false;
    // Media-only edits must still make the building "pending export" (the media modules never write it).
    mediaCounts(b.id).then((c) => { if (c.photo !== openCounts.photo || c.audio !== openCounts.audio) { b.updated_at = nowIso(); const snap = JSON.parse(JSON.stringify(b)); chain = chain.then(() => db.get('buildings', b.id)).then((cur) => (cur ? db.put('buildings', { ...snap, inspected_at: cur.inspected_at, exported_at: cur.exported_at }) : null)); } }).catch(() => {});
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flushAll);
    mounts.forEach((m) => { try { m?.destroy?.(); } catch (_) { /* ignore */ } });
  };
}
