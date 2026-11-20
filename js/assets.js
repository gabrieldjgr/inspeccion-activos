// Asset capture (v0.3 F1), home list and departments. Photo/audio modules are mounted into slots.
import * as db from './db.js';
import { FLOORS, newDraft, saveAsset, nowIso, todayKey, isPending, mediaCounts, mediaIndex, countsOf, deleteAsset, copyAsset, assetLabel } from './data.js';
import { parseDepartmentsCsv, csvEscape } from './csv.js';
import { mountPhotos } from './photos.js';
import { mountAudio } from './audio.js';
import { projectDialog } from './projects.js';

let cleanup = null;
export function leave() { if (cleanup) { const c = cleanup; cleanup = null; try { c(); } catch (e) { console.error(e); } } }

const normSearch = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const floorLabel = (f) => (/^\d+$/.test(f) ? `Piso ${f}` : f);

// ---------- searchable picker (dialog) ----------
// items: [{value,label,sub}]. Resolves {value} | {created:text} | null. With newLabel, a "+ newLabel"
// button is always available (created:'' when nothing was typed).
function pick(h, { title, items, newLabel, newAlways = false, current }) {
  return new Promise((resolve) => {
    const d = h.$dlg;
    d.innerHTML = `<h2 style="margin-top:0">${h.esc(title)}</h2>
      <input id="pk-q" type="search" placeholder="Buscar…" autocomplete="off" aria-label="Buscar">
      <div class="scroll pk-list" id="pk-list"></div>
      <div class="actions"><button class="btn" id="pk-cancel">Cancelar</button></div>`;
    const $q = d.querySelector('#pk-q');
    const $list = d.querySelector('#pk-list');
    let result = null;
    let shown = [];
    const draw = () => {
      const q = normSearch($q.value).trim();
      shown = items.filter((i) => !q || normSearch(i.label + ' ' + (i.sub || '')).includes(q));
      const exact = items.some((i) => normSearch(i.label).trim() === q);
      let html = '';
      if (newLabel && !exact && (q || newAlways)) html += `<button type="button" class="btn primary pk-item pk-new" data-new="1">+ ${h.esc(newLabel)}${q ? `: “${h.esc($q.value.trim())}”` : ''}</button>`;
      html += shown.map((i, n) => `<button type="button" class="btn pk-item${i.value === current ? ' sel' : ''}" data-n="${n}"><span>${h.esc(i.label)}</span>${i.sub ? `<small>${h.esc(i.sub)}</small>` : ''}</button>`).join('');
      if (!html) html = '<p class="muted">Sin resultados.</p>';
      $list.innerHTML = html;
    };
    $q.addEventListener('input', draw);
    $list.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.new) result = { created: $q.value.trim() };
      else result = { value: shown[Number(b.dataset.n)].value };
      d.close();
    });
    d.querySelector('#pk-cancel').onclick = () => d.close();
    d.onclose = () => resolve(result);
    draw();
    d.showModal();
  });
}

// ---------- quick building (created from the asset form, without leaving it) ----------
export function suggestBuildingCode(buildings) {
  let max = 0;
  for (const b of buildings) { const m = /^B(\d+)$/i.exec(b.code); if (m) max = Math.max(max, Number(m[1])); }
  return `B${max + 1}`;
}
function quickBuilding(h, project, buildings, typed) {
  return new Promise((resolve) => {
    const looksLikeCode = typed && /^[A-Za-z]{0,3}-?\d{1,4}[A-Za-z]?$/.test(typed.trim());
    const code0 = looksLikeCode ? typed.trim().toUpperCase() : suggestBuildingCode(buildings);
    const name0 = looksLikeCode ? '' : (typed || '');
    const d = h.$dlg;
    d.innerHTML = `<h2 style="margin-top:0">Nuevo edificio</h2>
      <label for="qb-code">Código (BLDG #)</label><input id="qb-code" type="text" value="${h.esc(code0)}" autocapitalize="characters" autocomplete="off">
      <label for="qb-name">Nombre</label><input id="qb-name" type="text" value="${h.esc(name0)}" autocomplete="off" placeholder="Ej.: Almacén de refacciones">
      <p class="muted small">Queda disponible en todo el proyecto. Se marca como creado en campo.</p>
      <p id="qb-err" class="bad" role="alert"></p>
      <div class="actions"><button class="btn primary" id="qb-save">Crear y usar</button><button class="btn" id="qb-cancel">Cancelar</button></div>`;
    let result = null;
    d.querySelector('#qb-cancel').onclick = () => d.close();
    d.querySelector('#qb-save').onclick = async () => {
      const code = db.cleanText(d.querySelector('#qb-code').value).toUpperCase();
      const name = db.cleanText(d.querySelector('#qb-name').value);
      const err = d.querySelector('#qb-err');
      if (!code) { err.textContent = 'Escribe el código.'; return; }
      if (!name) { err.textContent = 'Escribe el nombre.'; return; }
      const key = db.normKey(code);
      const fresh = await db.getByProject('buildings', project.id);
      if (fresh.some((b) => b.code_key === key)) { err.textContent = `Ya existe el edificio ${code} en este proyecto.`; return; }
      const now = nowIso();
      const b = { id: crypto.randomUUID(), project_id: project.id, code, code_key: key, name, source: 'field', created_by: project.valuer_code || null, created_at: now, updated_at: now };
      try { await db.put('buildings', b); result = b; d.close(); } catch (e) { err.textContent = 'Error: ' + e.message; }
    };
    d.onclose = () => resolve(result);
    d.showModal();
    (name0 || looksLikeCode ? d.querySelector('#qb-name') : d.querySelector('#qb-code')).focus();
  });
}

// ---------- save confirmation: unmissable flash + vibration ----------
function flashSaved(label) {
  const el = document.createElement('div');
  el.className = 'save-flash';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="sf-check">✓</span><strong></strong><span>Guardado</span>`;
  el.querySelector('strong').textContent = label;
  document.body.append(el);
  try { navigator.vibrate?.([40, 60, 40]); } catch (_) { /* ignore */ }
  setTimeout(() => el.classList.add('out'), 700);
  setTimeout(() => el.remove(), 1100);
}

// ---------- departments ----------
export async function addDepartment(projectId, name) {
  const clean = db.cleanText(name);
  const key = db.normKey(clean);
  if (!key) return null;
  const id = db.departmentId(projectId, key);
  const existing = await db.get('departments', id);
  if (existing) return existing.name;
  await db.put('departments', { id, project_id: projectId, key, name: clean });
  return clean;
}
const listDepartments = async (projectId) => (await db.getByProject('departments', projectId)).sort((a, b) => a.name.localeCompare(b.name, 'es'));

export async function viewDepartments(h) {
  leave();
  const pid = h.state.project.id;
  const rows = await listDepartments(pid);
  h.$app.innerHTML = `
    <h1>Departamentos</h1>
    <div class="card">
      <p class="muted">CSV de 1 columna (<code>DEPARTMENT</code>). También se pueden crear al vuelo desde el formulario del activo.</p>
      <div class="row">
        <button class="btn primary" id="d-import">Importar CSV</button>
        <button class="btn" id="d-add">+ Agregar</button>
        <button class="btn" id="d-export"${rows.length ? '' : ' disabled'}>Exportar CSV</button>
      </div>
      <input id="d-file" class="sr" type="file" accept=".csv,text/csv,text/plain" tabindex="-1">
    </div>
    <div class="card"><strong>${rows.length} departamento${rows.length === 1 ? '' : 's'}</strong>
      ${rows.length ? `<ul class="list">${rows.map((r) => `<li><span class="name">${h.esc(r.name)}</span><button class="btn danger" data-del="${h.esc(r.id)}">Borrar</button></li>`).join('')}</ul>` : '<p class="muted">Aún no hay departamentos.</p>'}
    </div>`;
  const $file = h.$app.querySelector('#d-file');
  h.$app.querySelector('#d-import').onclick = () => { $file.value = ''; $file.click(); };
  $file.onchange = async () => {
    const f = $file.files[0]; if (!f) return;
    try {
      const res = parseDepartmentsCsv(await f.arrayBuffer());
      if (res.errors.length && !res.names.length) { await h.ask('No se pudo importar', `<ul>${res.errors.map((e) => `<li>${h.esc(e)}</li>`).join('')}</ul>`, [{ label: 'Cerrar', value: null, cls: 'primary' }]); return; }
      for (const n of res.names) await addDepartment(pid, n);
      h.showBanner('imp', 'info', `Se procesaron ${res.names.length} departamentos ✓ (los existentes no se duplican)`, [{ label: 'OK', onClick: () => h.hideBanner('imp') }]);
      await viewDepartments(h);
    } catch (e) { h.reportError(e); }
  };
  h.$app.querySelector('#d-add').onclick = async () => {
    const r = await pick(h, { title: 'Nuevo departamento', items: [], newLabel: 'Crear departamento' });
    if (r?.created) { await addDepartment(pid, r.created); await viewDepartments(h); }
  };
  h.$app.querySelector('#d-export').onclick = () => h.download('departamentos.csv', new Blob(['﻿DEPARTMENT\r\n' + rows.map((r) => csvEscape(r.name)).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  h.$app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (await h.confirmDlg('Borrar departamento', '<p>Los activos ya registrados conservan su departamento.</p>', 'Borrar', 'danger')) { await db.del('departments', b.dataset.del); await viewDepartments(h); }
  }));
}

// ---------- asset form ----------
async function loadOrCreate(h, id) {
  const pid = h.state.project.id;
  if (id) { const a = await db.get('assets', id); if (a) return a; }
  const drafts = (await db.getByProject('assets', pid)).filter((a) => a.status === 'draft').sort((x, y) => (y.updated_at || '').localeCompare(x.updated_at || ''));
  if (drafts.length && !id) return drafts[0];
  // Read the project fresh: saveAsset updates last_context in the DB, not in h.state.
  const [inspector, project] = await Promise.all([db.getSetting('inspector', ''), db.get('projects', pid)]);
  const a = newDraft({ projectId: pid, inspector, deviceId: h.state.deviceId, context: project?.last_context || null });
  await db.put('assets', a); // durable immediately (Android may kill the page while the camera is open)
  return a;
}

// Copy dialog: what to copy. Resolves {notes, audios, photos} or null.
function copyOptions(h, src) {
  return h.ask(`Copiar ${assetLabel(src)}`, `
    <p>Se crea un activo nuevo con la misma ubicación; cámbiala en el formulario si el equipo está en otro edificio, piso o departamento. Tendrá su propio ID.</p>
    <label class="switch"><input type="checkbox" id="cp-notes" checked> Notas de texto</label>
    <label class="switch"><input type="checkbox" id="cp-audios"> Notas de voz</label>
    <label class="switch"><input type="checkbox" id="cp-photos"> Fotos</label>
    <p class="muted small">Recomendado: no copiar fotos. Toma la placa del equipo nuevo; las fotos copiadas se marcan como copia para la IA.</p>`,
  [{ label: 'Copiar', value: 'go', cls: 'primary' }, { label: 'Cancelar', value: null }]).then((v) => {
    if (v !== 'go') return null;
    // h.ask closes the dialog before resolving, but the inputs are still in the DOM.
    const q = (id) => !!h.$dlg.querySelector(id)?.checked;
    return { notes: q('#cp-notes'), audios: q('#cp-audios'), photos: q('#cp-photos') };
  });
}

async function doCopy(h, srcId) {
  const src = await db.get('assets', srcId);
  if (!src) return;
  const opts = await copyOptions(h, src);
  if (!opts) return;
  const inspector = await db.getSetting('inspector', '');
  const draft = await copyAsset(srcId, opts, { inspector, deviceId: h.state.deviceId });
  leave();
  h.navigate('#/activo?id=' + encodeURIComponent(draft.id));
}

export async function viewAssetForm(h, id) {
  leave();
  const a = await loadOrCreate(h, id);
  const wasSaved = a.status === 'saved';
  const openCounts = await mediaCounts(a.id);
  const [quality, cameraMode] = await Promise.all([db.getSetting('photo_quality', 'alta'), db.getSetting('camera_mode', 'sistema')]);
  let buildings = await db.getByProject('buildings', a.project_id);
  let chain = Promise.resolve();
  let gone = false;     // set before deleting: no late write may recreate the asset
  let changed = false;  // user edits in this session
  let dirtyNotes = false;
  let timer = null;
  const mounts = [];
  const prev = !wasSaved && h.state.lastSaved && h.state.lastSaved.project_id === a.project_id && h.state.lastSaved.id !== a.id ? h.state.lastSaved : null;

  const persist = () => {
    if (gone) return chain;
    changed = true;
    chain = chain.then(() => (gone ? null : db.put('assets', { ...a, updated_at: nowIso() }))).catch((e) => h.reportError(e));
    return chain;
  };
  const flushNotes = () => { clearTimeout(timer); if (dirtyNotes) { dirtyNotes = false; return persist(); } return chain; };

  h.$app.innerHTML = `
    ${prev ? `<div class="prev-strip" role="status">
        <span class="ps-ok">✓</span>
        <span class="ps-txt"><small>Anterior guardado</small><strong>${h.esc(prev.label)}</strong><span>${prev.photos} 📷 · ${prev.audios} 🎙${prev.photos ? '' : ' · <b class="warn-t">sin foto</b>'}</span></span>
        <a class="btn ps-btn" href="#/activo?id=${h.esc(prev.id)}">Abrir</a>
        <button class="btn ps-btn" id="ps-copy">⧉ Copiar</button>
      </div>` : ''}
    <h1 class="asset-h1">${h.esc(wasSaved ? assetLabel(a) : 'Nuevo activo')}${wasSaved ? '' : ' <span class="muted tag">borrador</span>'}</h1>
    ${a.copied_from ? `<p class="copied-note">⧉ Copia de <strong>${h.esc(a.copied_from.display_id || 'otro activo')}</strong>. Revisa edificio, piso y departamento, y toma la placa de este equipo.</p>` : ''}
    <div class="card ctx">
      <button type="button" class="ctx-btn" id="c-b"></button>
      <button type="button" class="ctx-btn" id="c-f"></button>
      <button type="button" class="ctx-btn" id="c-d"></button>
    </div>
    <div class="card" id="slot-photos"></div>
    <div class="card" id="slot-audio"></div>
    <div class="card"><label for="notes">Notas</label><textarea id="notes" rows="4" placeholder="Lo que veas: tipo de equipo, estado, capacidad, observaciones…">${h.esc(a.notes)}</textarea></div>
    <p id="f-msg" class="bad" role="alert"></p>
    <div class="savebar">
      ${wasSaved
        ? '<button class="btn primary" id="s-save">✓ Listo</button><button class="btn" id="s-copy">⧉ Copiar</button><button class="btn danger" id="s-del">Borrar</button>'
        : '<button class="btn primary" id="s-next">✓ Guardar y nuevo</button><button class="btn" id="s-save">Guardar y salir</button><button class="btn danger subtle" id="s-discard">Descartar</button>'}
    </div>`;
  const $ = (s) => h.$app.querySelector(s);
  const msg = (t) => { $('#f-msg').textContent = t || ''; };

  const paintCtx = () => {
    const b = $('#c-b'), f = $('#c-f'), d = $('#c-d');
    b.innerHTML = `<small>🏢 Edificio</small><strong>${a.building_code ? h.esc(a.building_code) : 'Elegir edificio'}</strong><span>${h.esc(a.building_name)}</span>`;
    f.innerHTML = `<small>🪜 Piso</small><strong>${a.floor ? h.esc(floorLabel(a.floor)) : 'Elegir piso'}</strong>`;
    d.innerHTML = `<small>🧰 Departamento</small><strong>${a.department ? h.esc(a.department) : 'Elegir'}</strong>`;
    b.classList.toggle('empty', !a.building_code); f.classList.toggle('empty', !a.floor); d.classList.toggle('empty', !a.department);
  };
  paintCtx();

  const psCopy = $('#ps-copy'); if (psCopy) psCopy.onclick = async () => { await flushNotes(); await chain; await doCopy(h, prev.id); };

  $('#c-b').onclick = async () => {
    const items = buildings.slice().sort((x, y) => x.code.localeCompare(y.code, 'es', { numeric: true })).map((x) => ({ value: x.id, label: x.code, sub: x.name }));
    const r = await pick(h, { title: 'Edificio', items, newLabel: 'Nuevo edificio', newAlways: true, current: a.building_id || buildings.find((x) => x.code_key === db.normKey(a.building_code))?.id });
    let b = null;
    if (r?.created !== undefined) {
      b = await quickBuilding(h, h.state.project, buildings, r.created);
      if (b) buildings = await db.getByProject('buildings', a.project_id);
    } else if (r?.value) b = buildings.find((x) => x.id === r.value);
    if (b) { a.building_id = b.id; a.building_code = b.code; a.building_name = b.name; paintCtx(); msg(''); await persist(); }
  };
  $('#c-f').onclick = async () => {
    const r = await pick(h, { title: 'Piso', items: FLOORS.map((f) => ({ value: f, label: floorLabel(f) })), current: a.floor });
    if (r?.value) { a.floor = r.value; paintCtx(); msg(''); await persist(); }
  };
  $('#c-d').onclick = async () => {
    const deps = await listDepartments(a.project_id);
    const r = await pick(h, { title: 'Departamento', items: deps.map((x) => ({ value: x.name, label: x.name })), newLabel: 'Nuevo departamento', current: a.department });
    let name = null;
    if (r?.created) name = await addDepartment(a.project_id, r.created); else if (r?.value) name = r.value;
    if (name) { a.department = name; paintCtx(); await persist(); }
  };

  const $notes = $('#notes');
  $notes.addEventListener('input', () => { a.notes = $notes.value; dirtyNotes = true; clearTimeout(timer); timer = setTimeout(flushNotes, 400); });
  const onHide = () => { if (document.visibilityState === 'hidden') flushNotes(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushNotes);

  // Media slots (never write the asset record themselves).
  try { mounts.push(await mountPhotos($('#slot-photos'), a, { quality, cameraMode })); } catch (e) { $('#slot-photos').innerHTML = `<p class="bad">No se pudo cargar el módulo de fotos: ${h.esc(e.message)}</p>`; }
  try { mounts.push(await mountAudio($('#slot-audio'), a)); } catch (e) { $('#slot-audio').innerHTML = `<p class="bad">No se pudo cargar el módulo de audio: ${h.esc(e.message)}</p>`; }

  // GPS (optional, never blocks).
  if (!a.gps?.lat && !wasSaved && await db.getSetting('gps_enabled', false) && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((p) => { if (gone) return; a.gps = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy }; persist(); }, () => {}, { timeout: 5000, maximumAge: 60000 });
  }

  cleanup = () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flushNotes);
    flushNotes();
    mounts.forEach((m) => { try { m?.destroy?.(); } catch (_) { /* ignore */ } });
    if (wasSaved && !gone && !changed) { // media-only edits must still mark the asset as pending export
      mediaCounts(a.id).then((c) => { if (!gone && (c.photo !== openCounts.photo || c.audio !== openCounts.audio)) return chain.then(() => (gone ? null : db.put('assets', { ...a, updated_at: nowIso() }))); }).catch(() => {});
    }
  };

  // Valuer code is needed for the display id: ask once, right here, if the project has none.
  const ensureValuer = async () => {
    if (h.state.project.valuer_code) return true;
    await h.ask('Falta tu código de valuador', '<p>Cada activo recibe un ID como <strong>B1-GA-A001</strong>, donde <strong>GA</strong> es tu código. Escríbelo una sola vez para este proyecto.</p>', [{ label: 'Escribir código', value: true, cls: 'primary' }]);
    const p = await projectDialog(h, h.state.project);
    if (p) await h.refreshProject();
    return !!h.state.project?.valuer_code;
  };

  const save = async (next) => {
    msg('');
    await flushNotes();
    if (!a.building_code) { msg('Elige un edificio.'); $('#c-b').focus(); return; }
    if (!a.floor) { msg('Elige un piso.'); $('#c-f').focus(); return; }
    const c = await mediaCounts(a.id);
    if (!a.notes.trim() && !c.photo && !c.audio && !c.chunk) { msg('Agrega al menos una foto, nota de voz o nota de texto.'); return; }
    if (!(await ensureValuer())) { msg('Sin código de valuador no se puede asignar el ID.'); return; }
    try {
      await chain;
      if (wasSaved && !changed && c.photo === openCounts.photo && c.audio === openCounts.audio && a.display_id) { leave(); h.navigate(next ? '#/nuevo' : '#/'); return; } // nothing edited: don't touch updated_at
      a.inspector = await db.getSetting('inspector', '') || a.inspector;
      const saved = await saveAsset(a);
      Object.assign(a, saved);
      leave();
      const label = assetLabel(saved);
      h.state.lastSaved = { id: saved.id, project_id: saved.project_id, label, photos: c.photo, audios: c.audio };
      h.state.highlight = saved.id;
      flashSaved(label);
      if (!next) {
        h.showBanner('saved', 'info', `${h.esc(label)} guardado ✓${c.photo ? '' : ' · sin foto'}`, [{ label: 'OK', onClick: () => h.hideBanner('saved') }]);
        setTimeout(() => h.hideBanner('saved'), 4000);
      }
      h.navigate(next ? '#/nuevo' : '#/');
    } catch (e) { h.reportError(e); }
  };
  $('#s-save').onclick = () => save(false);
  const sn = $('#s-next'); if (sn) sn.onclick = () => save(true);
  const sc = $('#s-copy'); if (sc) sc.onclick = async () => { await flushNotes(); await chain; await doCopy(h, a.id); };
  const sd = $('#s-discard'); if (sd) sd.onclick = async () => {
    if (await h.confirmDlg('Descartar borrador', '<p>Se borrarán el borrador y sus fotos y audios. No se puede deshacer.</p>', 'Descartar', 'danger')) { gone = true; leave(); await chain; await deleteAsset(a.id); h.navigate('#/'); }
  };
  const del = $('#s-del'); if (del) del.onclick = async () => {
    if (await h.confirmDlg('Borrar activo', `<p>¿Borrar <strong>${h.esc(assetLabel(a))}</strong> con todas sus fotos y audios? No se puede deshacer.</p>`, 'Borrar', 'danger')) {
      gone = true; leave(); await chain; await deleteAsset(a.id);
      if (h.state.lastSaved?.id === a.id) h.state.lastSaved = null;
      h.navigate('#/');
    }
  };
}

// ---------- home list ----------
const filters = { pid: null, quick: 'all', b: '', f: '', d: '', q: '', limit: 50 };
const QUICK = { all: 'Todos', today: 'Hoy', nophoto: 'Sin foto', nonote: 'Sin nota', pending: 'Por exportar', copied: 'Copias' };

export async function viewHome(h) {
  leave();
  const pid = h.state.project.id;
  if (filters.pid !== pid) Object.assign(filters, { pid, quick: 'all', b: '', f: '', d: '', q: '', limit: 50 }); // filters belong to one project
  const [nB, inspector, info, all, media] = await Promise.all([db.countByProject('buildings', pid), db.getSetting('inspector', ''), h.storageInfo(), db.getByProject('assets', pid), mediaIndex()]);

  // Drafts: drop empty ones, offer to continue the rest.
  let draft = null;
  for (const dr of all.filter((x) => x.status === 'draft').sort((x, y) => (y.updated_at || '').localeCompare(x.updated_at || ''))) {
    const c = countsOf(media, dr.id);
    if (!dr.notes.trim() && !c.photo && !c.audio && !c.chunk && !dr.copied_from) { await deleteAsset(dr.id); continue; }
    if (!draft) draft = dr;
  }
  const saved = all.filter((x) => x.status === 'saved').sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''));
  const today = saved.filter((x) => (x.created_at || '').slice(0, 10) === todayKey()).length;
  const pending = saved.filter(isPending).length;
  const noPhoto = saved.filter((x) => !countsOf(media, x.id).photo).length;

  if (info.quota && info.usage != null) {
    const free = info.quota - info.usage;
    if (free < 1073741824 || free / info.quota < 0.1) h.showBanner('space', 'warn', `Queda poco espacio (${h.fmtBytes(free)} libres). Exporta y borra lo ya exportado.`, [{ label: 'Exportar', onClick: () => h.navigate('#/exportar') }]);
  }

  const todo = [];
  if (!inspector) todo.push('<li>Escribe tu nombre de inspector en <a href="#/ajustes">Ajustes</a>.</li>');
  if (!h.state.project.valuer_code) todo.push('<li>Define tu código de valuador en <a href="#/proyectos">Proyectos → Editar</a>.</li>');
  if (!nB) todo.push('<li>Importa la lista de edificios en <a href="#/edificios">Edificios</a> (o créalos al registrar un activo).</li>');
  const buildingsSeen = [...new Set(saved.map((x) => x.building_code))].sort((x, y) => x.localeCompare(y, 'es', { numeric: true }));
  const floorsSeen = FLOORS.filter((f) => saved.some((x) => x.floor === f));
  const deptsSeen = [...new Set(saved.map((x) => x.department).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es'));
  const opt = (arr, cur, lab = (v) => v) => arr.map((v) => `<option value="${h.esc(v)}"${v === cur ? ' selected' : ''}>${h.esc(lab(v))}</option>`).join('');
  const quickCount = { all: saved.length, today, nophoto: noPhoto, pending };

  h.$app.innerHTML = `
    <h1>Inicio <span class="muted h1-sub">${h.esc(h.state.project.name)}</span></h1>
    ${todo.length ? `<div class="card"><strong>Configuración pendiente</strong><ul>${todo.join('')}</ul></div>` : ''}
    ${draft ? `<div class="card draft"><strong>${draft.copied_from ? 'Tienes una copia sin guardar' : 'Tienes un borrador sin guardar'}</strong><p class="muted">${h.esc([draft.building_code, draft.floor && floorLabel(draft.floor), draft.department].filter(Boolean).join(' · ') || 'Sin contexto')}</p>
      <div class="row"><a class="btn primary" href="#/activo?id=${h.esc(draft.id)}">Continuar</a></div></div>` : ''}
    <a class="btn big primary" href="#/nuevo" id="new-asset">+ Nuevo activo</a>
    <div class="card stats">
      <div><strong>${today}</strong><span>hoy</span></div>
      <div><strong>${saved.length}</strong><span>total</span></div>
      <div><strong>${pending}</strong><span>por exportar</span></div>
    </div>
    <div class="section-title">Activos registrados</div>
    <div class="qchips" role="group" aria-label="Filtro rápido">${Object.entries(QUICK).map(([k, l]) => `<button type="button" class="qchip${filters.quick === k ? ' on' : ''}${k === 'nophoto' && noPhoto ? ' warn' : ''}" data-q="${k}">${l}${quickCount[k] != null ? ` <b>${quickCount[k]}</b>` : ''}</button>`).join('')}</div>
    <div class="card">
      <input id="f-q" type="search" placeholder="Buscar ID, notas, edificio, departamento…" aria-label="Buscar" value="${h.esc(filters.q)}">
      <div class="row filters">
        <select id="f-b" aria-label="Filtrar por edificio"><option value="">Edificio</option>${opt(buildingsSeen, filters.b)}</select>
        <select id="f-f" aria-label="Filtrar por piso"><option value="">Piso</option>${opt(floorsSeen, filters.f, floorLabel)}</select>
        <select id="f-d" aria-label="Filtrar por departamento"><option value="">Departamento</option>${opt(deptsSeen, filters.d)}</select>
      </div>
    </div>
    <div id="list"></div>
    <div class="card">${h.storageHtml(info)}</div>
    <a class="fab" href="#/nuevo" aria-label="Nuevo activo">+</a>`;

  const $list = h.$app.querySelector('#list');
  let urls = [];
  const quickPass = (x) => {
    const c = countsOf(media, x.id);
    switch (filters.quick) {
      case 'today': return (x.created_at || '').slice(0, 10) === todayKey();
      case 'nophoto': return !c.photo;
      case 'nonote': return !String(x.notes || '').trim() && !c.audio;
      case 'pending': return isPending(x);
      case 'copied': return !!x.copied_from;
      default: return true;
    }
  };
  const drawList = () => {
    urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
    const q = normSearch(filters.q).trim();
    const rows = saved.filter((x) => quickPass(x) && (!filters.b || x.building_code === filters.b) && (!filters.f || x.floor === filters.f) && (!filters.d || x.department === filters.d)
      && (!q || normSearch([x.display_id, x.notes, x.building_code, x.building_name, x.department, x.floor, '#' + x.seq].join(' ')).includes(q)));
    if (!rows.length) { $list.innerHTML = `<div class="card empty-state"><span class="big-emoji">${saved.length ? '🔍' : '📋'}</span><strong>${saved.length ? 'Ningún activo coincide' : 'Aún no hay activos'}</strong><p class="muted">${saved.length ? 'Prueba con otros filtros o borra la búsqueda.' : 'Toca “+ Nuevo activo” para registrar el primero.'}</p></div>`; return; }
    const page = rows.slice(0, filters.limit);
    $list.innerHTML = `<p class="muted small list-count">${rows.length} activo${rows.length === 1 ? '' : 's'}</p><ul class="assets">${page.map((x) => {
      const c = countsOf(media, x.id);
      return `<li><a class="asset-item${h.state.highlight === x.id ? ' hl' : ''}" href="#/activo?id=${h.esc(x.id)}" data-id="${h.esc(x.id)}" data-thumb="${h.esc(c.thumbKey || '')}">
      <span class="thumb" aria-hidden="true"></span>
      <span class="info"><strong class="aid">${h.esc(assetLabel(x))}</strong>
      <span>${h.esc(x.building_code)} · ${h.esc(floorLabel(x.floor))} · ${h.esc(x.department || '—')}</span>
      <span class="chips"><span class="chip${c.photo ? '' : ' warn'}">📷 ${c.photo}</span><span class="chip">🎙 ${c.audio}</span>${x.copied_from ? '<span class="chip">⧉ copia</span>' : ''}${isPending(x) ? '<span class="chip pending">por exportar</span>' : '<span class="chip done">exportado ✓</span>'}</span>
      ${x.notes ? `<span class="muted note">${h.esc(x.notes.slice(0, 90))}</span>` : ''}</span></a></li>`;
    }).join('')}</ul>
      ${rows.length > page.length ? `<button class="btn big" id="more">Mostrar más (${rows.length - page.length})</button>` : ''}`;
    const more = $list.querySelector('#more'); if (more) more.onclick = () => { filters.limit += 50; drawList(); };
    $list.querySelectorAll('.asset-item[data-thumb]:not([data-thumb=""])').forEach(async (el) => {
      try {
        const t = await db.get('blobs', el.dataset.thumb);
        if (t && el.isConnected) { const u = URL.createObjectURL(t.blob); urls.push(u); el.querySelector('.thumb').style.backgroundImage = `url(${u})`; }
      } catch (_) { /* list stays usable without thumbnails */ }
    });
    const hl = $list.querySelector('.asset-item.hl');
    if (hl) { hl.scrollIntoView({ block: 'center' }); h.state.highlight = null; }
  };
  h.$app.querySelectorAll('.qchip').forEach((b) => (b.onclick = () => {
    filters.quick = b.dataset.q; filters.limit = 50;
    h.$app.querySelectorAll('.qchip').forEach((x) => x.classList.toggle('on', x === b));
    drawList();
  }));
  const bind = (sel, key, ev = 'change') => h.$app.querySelector(sel).addEventListener(ev, (e) => { filters[key] = e.target.value; filters.limit = 50; drawList(); });
  bind('#f-b', 'b'); bind('#f-f', 'f'); bind('#f-d', 'd'); bind('#f-q', 'q', 'input');
  drawList();
  cleanup = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
}
