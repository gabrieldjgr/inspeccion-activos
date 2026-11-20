// Export screen (v0.3 F4): AI-oriented ZIP export (js/ai-export.js), full backup / restore, delete exported.
// IndexedDB rule: inside db.tx() callbacks we only await IndexedDB requests.
import { unzipSync, strFromU8 } from '../vendor/fflate.esm.js';
import * as db from './db.js';
import { APP_VERSION } from './version.js';
import { getSavedAssets, getMedia, isPending, deleteAsset, blobId, nowIso } from './data.js';
import { createProject } from './projects.js';
import { createZipWriter, fileStamp, extOf, readBlobBytes, isMemoryError } from './ziputil.js';
import { exportForAI, reviewExport, filterAssets } from './ai-export.js';

// ---------------------------------------------------------------- full backup
// schema_version 1: DB v1 (app <= 0.2; also produced by the pre-migration backup, so v0.2 can restore it).
// schema_version 2: DB v2 (projects). Both carry every asset of every project with photos, thumbs and audio.

const SETTINGS_V1 = ['inspector', 'photo_quality', 'gps_enabled', 'seq_counter', 'last_context'];
const SETTINGS_V2 = ['inspector', 'photo_quality', 'gps_enabled', 'seq_counter', 'active_project'];

// Strips the Blob and adds file names; keeps uid, order and all metadata.
const metaOf = (rec, file) => { const { blob, ...rest } = rec; return { ...rest, file }; };

export async function exportBackup(h, onProgress) {
  const nowD = new Date();
  const version = await db.currentVersion();
  const deviceId = h.state.deviceId || (await db.getSetting('device_id', null));
  const device8 = String(deviceId || 'sin-id').slice(0, 8);
  const keys = version < 2 ? SETTINGS_V1 : SETTINGS_V2;
  const settings = {};
  for (const k of keys) { const v = await db.getSetting(k, undefined); if (v !== undefined) settings[k] = v; }
  const [buildings, departments, assets] = await Promise.all([db.getAll('buildings'), db.getAll('departments'), db.getAll('assets')]);
  const head = version < 2
    ? { schema_version: 1, app_version: APP_VERSION, exported_at: nowIso(nowD), n_assets: assets.length, edificios: buildings, departamentos: departments, settings }
    : { schema_version: 2, app_version: APP_VERSION, exported_at: nowIso(nowD), n_assets: assets.length, proyectos: await db.getAll('projects'), edificios: buildings, departamentos: departments, listas: await db.getAll('lists'), settings };
  const w = createZipWriter();
  w.addText('backup.json', JSON.stringify(head, null, 2));
  assets.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    onProgress?.(i, assets.length, 'Respaldo');
    const dir = `activos/${a.id}/`;
    const [photos, thumbs, audios] = await Promise.all([getMedia(a.id, 'photo'), getMedia(a.id, 'thumb'), getMedia(a.id, 'audio')]);
    const pMeta = []; const tMeta = []; const aMeta = [];
    const files = [];
    for (const p of photos) { const f = `photo_${p.uid}.${extOf(p, 'jpg')}`; pMeta.push(metaOf(p, f)); files.push([dir + f, p]); }
    for (const t of thumbs) { const f = `thumb_${t.uid}.jpg`; tMeta.push(metaOf(t, f)); files.push([dir + f, t]); }
    for (const x of audios) { const f = `audio_${x.uid}.${extOf(x, 'webm')}`; aMeta.push(metaOf(x, f)); files.push([dir + f, x]); }
    w.addText(dir + 'activo.json', JSON.stringify({ asset: a, photos: pMeta, thumbs: tMeta, audios: aMeta }, null, 2));
    for (const [name, rec] of files) w.addStored(name, await readBlobBytes(rec));
    onProgress?.(i + 1, assets.length, 'Respaldo');
  }
  // Building media (v0.3 F2): owner = building id. Building data itself is in backup.json.
  if (version >= 2) {
    for (const b of buildings) {
      const [photos, thumbs, audios] = await Promise.all([getMedia(b.id, 'photo'), getMedia(b.id, 'thumb'), getMedia(b.id, 'audio')]);
      if (!photos.length && !audios.length) continue;
      const dir = `edificios/${b.id}/`;
      const files = [];
      const meta = { owner_id: b.id, photos: [], thumbs: [], audios: [] };
      for (const p of photos) { const f = `photo_${p.uid}.${extOf(p, 'jpg')}`; meta.photos.push(metaOf(p, f)); files.push([dir + f, p]); }
      for (const t of thumbs) { const f = `thumb_${t.uid}.jpg`; meta.thumbs.push(metaOf(t, f)); files.push([dir + f, t]); }
      for (const x of audios) { const f = `audio_${x.uid}.${extOf(x, 'webm')}`; meta.audios.push(metaOf(x, f)); files.push([dir + f, x]); }
      w.addText(dir + 'media.json', JSON.stringify(meta, null, 2));
      for (const [name, rec] of files) w.addStored(name, await readBlobBytes(rec));
    }
  }
  const chunks = await w.finish();
  const blob = new Blob(chunks, { type: 'application/zip' });
  chunks.length = 0;
  return { blob, name: `respaldo_${device8}_${fileStamp(nowD)}.zip`, nAssets: assets.length };
}

// Merge the master data of a backup into the DB. Returns { buildingIdFor(asset), projectIdFor(asset) }.
async function restoreMasterData(backup, h, res) {
  const now = nowIso();
  if (backup.schema_version === 1) {
    // v1 backup: everything goes into the active project (or a new one if there is none).
    let project = h.state.project;
    if (!project) { project = await createProject({ name: 'Restaurado ' + now.slice(0, 10), units: 'imperial' }); await db.setSetting('active_project', project.id); res.projects++; }
    const pid = project.id;
    const have = new Map((await db.getByProject('buildings', pid)).map((b) => [b.code_key, b.id]));
    const newB = [];
    for (const b of backup.edificios || []) {
      const key = db.normKey(b?.code);
      if (!key || have.has(key)) continue;
      const id = crypto.randomUUID();
      have.set(key, id);
      newB.push({ id, project_id: pid, code: db.cleanText(b.code), code_key: key, name: db.cleanText(b.name), source: 'import', created_at: now, updated_at: now });
    }
    if (newB.length) await db.putMany('buildings', newB);
    res.buildings = newB.length;
    const haveD = new Set((await db.getByProject('departments', pid)).map((d) => d.key));
    const newD = (backup.departamentos || []).filter((d) => d && d.key && !haveD.has(d.key)).map((d) => ({ id: db.departmentId(pid, d.key), project_id: pid, key: d.key, name: d.name }));
    if (newD.length) await db.putMany('departments', newD);
    res.departments = newD.length;
    return { projectIdFor: () => pid, buildingIdFor: (a) => have.get(db.normKey(a.building_code)) || null };
  }
  // v2 backup: add what is missing, never overwrite local master data.
  const haveP = new Set((await db.getAll('projects')).map((p) => p.id));
  const newP = (backup.proyectos || []).filter((p) => p && p.id && !haveP.has(p.id));
  if (newP.length) await db.putMany('projects', newP);
  res.projects = newP.length;
  const localB = await db.getAll('buildings');
  const byKey = new Map(localB.map((b) => [`${b.project_id}|${b.code_key}`, b.id]));
  const ids = new Set(localB.map((b) => b.id));
  const remap = new Map(); // backup building id -> local building id (same code already present locally)
  const newB = [];
  for (const b of backup.edificios || []) {
    if (!b || !b.id || !b.project_id || ids.has(b.id)) continue;
    const k = `${b.project_id}|${b.code_key}`;
    if (byKey.has(k)) { remap.set(b.id, byKey.get(k)); continue; }
    byKey.set(k, b.id); ids.add(b.id); newB.push(b);
  }
  if (newB.length) await db.putMany('buildings', newB);
  res.buildings = newB.length;
  const haveD = new Set((await db.getAll('departments')).map((d) => d.id));
  const newD = (backup.departamentos || []).filter((d) => d && d.id && d.project_id && !haveD.has(d.id));
  if (newD.length) await db.putMany('departments', newD);
  res.departments = newD.length;
  const haveL = new Set((await db.getAll('lists')).map((l) => l.id));
  const newL = (backup.listas || []).filter((l) => l && l.id && !haveL.has(l.id));
  if (newL.length) await db.putMany('lists', newL);
  return { projectIdFor: (a) => a.project_id, buildingIdFor: (a) => (a.building_id && remap.has(a.building_id) ? remap.get(a.building_id) : a.building_id ?? null) };
}

// Restores a backup ZIP (whole file read in memory). Returns { assets, skipped, projects, buildings, departments, settings, errors[] }.
export async function importBackup(file, h, onProgress) {
  const res = { assets: 0, skipped: 0, projects: 0, buildings: 0, departments: 0, settings: 0, errors: [] };
  let files;
  try { files = unzipSync(new Uint8Array(await file.arrayBuffer())); } catch (e) {
    if (isMemoryError(e)) throw new Error('No hay memoria suficiente para abrir este respaldo. Genera respaldos más pequeños o usa un dispositivo con más memoria.');
    throw new Error('El archivo no es un ZIP válido o está dañado.');
  }
  if (!files['backup.json']) throw new Error('El ZIP no contiene backup.json: no es un respaldo de esta app.');
  let backup;
  try { backup = JSON.parse(strFromU8(files['backup.json'])); } catch (_) { throw new Error('backup.json está dañado.'); }
  if (!backup || (backup.schema_version !== 1 && backup.schema_version !== 2)) throw new Error('Versión de respaldo no compatible (schema_version ' + backup?.schema_version + '). Actualiza la app.');

  const map = await restoreMasterData(backup, h, res);

  // Assets (merge by id; most recent updated_at wins).
  const dirs = Object.keys(files).filter((k) => /^activos\/[^/]+\/activo\.json$/.test(k));
  let maxSeq = 0;
  for (let i = 0; i < dirs.length; i++) {
    onProgress?.(i, dirs.length, 'Restaurando');
    const key = dirs[i];
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    try {
      const doc = JSON.parse(strFromU8(files[key]));
      const src = doc.asset;
      if (!src || !src.id || (src.status !== 'saved' && src.status !== 'draft')) throw new Error('registro inválido');
      const a = { ...src, project_id: map.projectIdFor(src), building_id: map.buildingIdFor(src) };
      if (a.seq > maxSeq) maxSeq = a.seq;
      const cur = await db.get('assets', a.id);
      if (cur && String(cur.updated_at) >= String(a.updated_at)) { res.skipped++; continue; }
      const blobs = [];
      for (const [kind, list] of [['photo', doc.photos], ['thumb', doc.thumbs], ['audio', doc.audios]]) {
        for (const m of list || []) {
          const bytes = files[dir + m.file];
          if (!bytes) { res.errors.push(`${a.id.slice(0, 8)}: falta el archivo ${m.file}.`); continue; }
          const { file: _f, ...rec } = m;
          blobs.push({ ...rec, id: blobId(kind, a.id, m.uid), asset_id: a.id, kind, blob: new Blob([bytes], { type: m.mime_type || '' }) });
        }
      }
      await db.tx(['assets', 'blobs'], 'readwrite', async (st) => { st.assets.put(a); for (const b of blobs) st.blobs.put(b); });
      res.assets++;
    } catch (e) {
      res.errors.push(`${key}: ${e.message}`);
      if (isMemoryError(e)) { res.errors.push('Memoria insuficiente: se detuvo la restauración.'); break; }
    }
  }
  // Building media: added if missing (blob ids are unique), owner remapped like the assets' building_id.
  for (const key of Object.keys(files).filter((k) => /^edificios\/[^/]+\/media\.json$/.test(k))) {
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    try {
      const doc = JSON.parse(strFromU8(files[key]));
      const owner = map.buildingIdFor({ building_id: doc.owner_id });
      if (!owner || !(await db.get('buildings', owner))) continue;
      const blobs = [];
      for (const [kind, list] of [['photo', doc.photos], ['thumb', doc.thumbs], ['audio', doc.audios]]) {
        for (const m of list || []) {
          const bytes = files[dir + m.file];
          if (!bytes) { res.errors.push(`Edificio ${owner.slice(0, 8)}: falta el archivo ${m.file}.`); continue; }
          const id = blobId(kind, owner, m.uid);
          if (await db.get('blobs', id)) continue;
          const { file: _f, ...rec } = m;
          blobs.push({ ...rec, id, asset_id: owner, kind, blob: new Blob([bytes], { type: m.mime_type || '' }) });
        }
      }
      if (blobs.length) await db.tx('blobs', 'readwrite', (st) => { for (const b of blobs) st.put(b); });
    } catch (e) { res.errors.push(`${key}: ${e.message}`); }
  }
  // Settings: fill in the missing ones; seq_counter = max of everything. NEVER touch device_id.
  const sett = backup.settings || {};
  for (const k of ['inspector', 'photo_quality', 'gps_enabled', 'active_project']) {
    if (sett[k] !== undefined && sett[k] !== null && (await db.getSetting(k, undefined)) == null) { await db.setSetting(k, sett[k]); res.settings++; }
  }
  const seq = Math.max(Number(await db.getSetting('seq_counter', 0)) || 0, Number(sett.seq_counter) || 0, maxSeq);
  if (seq > 0 && seq !== (await db.getSetting('seq_counter', 0))) { await db.setSetting('seq_counter', seq); res.settings++; }
  return res;
}

// ---------------------------------------------------------------- view

export async function viewExport($app, h) {
  const { esc, ask, confirmDlg, download, fmtBytes, reportError, showBanner, hideBanner } = h;
  const canShare = (blob, name) => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'application/zip' })] })); } catch (_) { return false; } };
  let busy = false;

  const pid = h.state.project.id;
  const stats = async () => {
    const saved = await getSavedAssets(pid);
    const pending = saved.filter(isPending).length;
    return { saved, total: saved.length, pending, exported: saved.filter((a) => a.exported_at && !isPending(a)).length };
  };
  const s0 = await stats();
  const buildings = new Map();
  for (const a of s0.saved) if (a.building_code && !buildings.has(a.building_code)) buildings.set(a.building_code, a.building_name);
  const today = nowIso().slice(0, 10);
  const nDrafts = (await db.countByProject('assets', pid)) - s0.total;

  $app.innerHTML = `
    <h1>Exportar <span class="muted h1-sub">${esc(h.state.project.name)}</span></h1>
    <div class="card">
      <dl class="kv">
        <dt>Activos guardados</dt><dd id="x-total">${s0.total}</dd>
        <dt>Pendientes de exportar</dt><dd id="x-pending"><strong>${s0.pending}</strong></dd>
        <dt>Ya exportados</dt><dd id="x-done">${s0.exported}</dd>
      </dl>
      ${nDrafts ? `<p class="muted">${nDrafts} borrador${nDrafts === 1 ? '' : 'es'} sin guardar no se exportan en el ZIP (sí van en el respaldo completo).</p>` : ''}
    </div>
    <div class="card">
      <h2 class="x-h">Exportar para procesar con IA</h2>
      <p class="muted small">ZIP ordenado por edificio → activo, con índice (JSON y CSV) e instrucciones para la IA (README_IA.md) dentro.</p>
      <label for="x-scope">Alcance</label>
      <select id="x-scope">
        <option value="pending">Solo lo nuevo o editado (incremental)</option>
        <option value="all">Todo el proyecto (completo)</option>
        <option value="building">Un edificio</option>
        <option value="dates">Rango de fechas</option>
      </select>
      <div id="x-bld" hidden>
        <label for="x-bsel">Edificio</label>
        <select id="x-bsel">${[...buildings].sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true })).map(([c, n]) => `<option value="${esc(c)}">${esc(c)} — ${esc(n)}</option>`).join('') || '<option value="">(sin edificios en los activos)</option>'}</select>
      </div>
      <div id="x-dates" class="row" hidden>
        <div class="x-field"><label for="x-from">Desde</label><input id="x-from" type="date" max="${today}"></div>
        <div class="x-field"><label for="x-to">Hasta</label><input id="x-to" type="date" max="${today}" value="${today}"></div>
      </div>
      <label for="x-max">Tamaño máximo por parte</label>
      <select id="x-max">
        <option value="20">20 MB — correo (Outlook, Gmail)</option>
        <option value="200">200 MB</option>
        <option value="500" selected>500 MB</option>
        <option value="1024">1 GB — WhatsApp, Teams, Drive</option>
      </select>
      <p id="x-count" class="muted" role="status"></p>
      <div id="x-review" class="x-review" hidden></div>
      <div class="row"><button class="btn primary big" id="x-go">Exportar ZIP</button></div>
      <div id="x-prog" class="x-prog" hidden>
        <progress id="x-bar" value="0" max="1"></progress>
        <div id="x-ptext" class="muted" role="status"></div>
      </div>
      <p id="x-msg" role="status"></p>
      <ul id="x-parts" class="x-parts"></ul>
    </div>
    <div class="card">
      <h2 class="x-h">Reporte de avance (PDF)</h2>
      <p class="muted small">Edificios inspeccionados contra pendientes, activos por edificio, piso y departamento, y registros sin foto, sin nota o sin placa. Se comparte directo a WhatsApp, Teams, correo o Drive.</p>
      <div class="row"><button class="btn primary" id="x-pdf">📄 Compartir reporte</button><button class="btn" id="x-pdfdl">Descargar PDF</button></div>
      <p id="x-pmsg" role="status"></p>
    </div>
    <div class="card">
      <h2 class="x-h">Respaldo completo</h2>
      <p class="muted">Incluye <strong>todos los proyectos</strong> de este teléfono: activos (también borradores y exportados), edificios, departamentos y ajustes. Sirve para pasar los datos a otro teléfono o recuperarlos tras reinstalar. Se arma en un solo archivo: con muchas fotos puede requerir bastante memoria.</p>
      <div class="row">
        <button class="btn" id="x-backup">Crear respaldo completo</button>
        <button class="btn" id="x-restore">Restaurar respaldo…</button>
      </div>
      <input id="x-file" class="sr" type="file" accept=".zip,application/zip" tabindex="-1">
      <div id="x-bprog" class="x-prog" hidden><progress id="x-bbar" value="0" max="1"></progress><div id="x-bptext" class="muted"></div></div>
      <p id="x-bmsg" role="status"></p>
      <ul id="x-bparts" class="x-parts"></ul>
    </div>
    <div class="card">
      <h2 class="x-h">Borrar activos ya exportados de este proyecto</h2>
      <p class="muted">Libera espacio. Solo borra activos exportados que no se hayan editado después. Esta acción no se puede deshacer.</p>
      <div class="row"><button class="btn danger" id="x-del">Borrar activos ya exportados</button></div>
      <p id="x-dmsg" role="status"></p>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const buttons = ['x-go', 'x-backup', 'x-restore', 'x-del', 'x-pdf', 'x-pdfdl'];
  const setBusy = (b) => { busy = b; buttons.forEach((i) => { $(i).disabled = b; }); };
  const say = (id, cls, text) => { const el = $(id); el.className = cls || ''; el.textContent = text; };

  const refreshStats = async () => {
    const s = await stats();
    $('x-total').textContent = s.total; $('x-pending').innerHTML = `<strong>${s.pending}</strong>`; $('x-done').textContent = s.exported;
    updateCount();
  };

  const currentScope = () => {
    const type = $('x-scope').value;
    const sc = { type };
    if (type === 'building') sc.building_code = $('x-bsel').value;
    if (type === 'dates') { sc.from = $('x-from').value || null; sc.to = $('x-to').value || null; }
    return sc;
  };
  let reviewToken = 0;
  async function updateCount() {
    const token = ++reviewToken;
    try {
      const r = await reviewExport(h.state.project, currentScope());
      if (token !== reviewToken) return;
      $('x-count').textContent = `Se exportarán ${r.assets} activo${r.assets === 1 ? '' : 's'} y ${r.buildings} edificio${r.buildings === 1 ? '' : 's'} con datos de campo.`;
      const items = [];
      if (r.noPhoto) items.push(`<li><a href="#/?f=nophoto">${r.noPhoto} activo${r.noPhoto === 1 ? '' : 's'} sin foto</a></li>`);
      if (r.noNote) items.push(`<li><a href="#/?f=nonote">${r.noNote} sin nota (ni texto ni voz)</a></li>`);
      if (r.noPlate) items.push(`<li>${r.noPlate} con fotos pero ninguna marcada como <strong>placa</strong></li>`);
      if (r.bNoPhoto) items.push(`<li><a href="#/edificios">${r.bNoPhoto} edificio${r.bNoPhoto === 1 ? '' : 's'} sin foto</a></li>`);
      if (r.bNotInspected) items.push(`<li><a href="#/edificios">${r.bNotInspected} edificio${r.bNotInspected === 1 ? '' : 's'} sin marcar como inspeccionado${r.bNotInspected === 1 ? '' : 's'}</a></li>`);
      const box = $('x-review');
      box.hidden = !items.length;
      box.innerHTML = items.length ? `<strong>Antes de exportar, revisa:</strong><ul>${items.join('')}</ul><p class="muted small">No impide exportar; la IA recibirá estos avisos en cada registro.</p>` : '';
    } catch (e) { console.error(e); }
  }
  const onScope = () => {
    const t = $('x-scope').value;
    $('x-bld').hidden = t !== 'building'; $('x-dates').hidden = t !== 'dates';
    updateCount();
  };
  ['x-scope', 'x-bsel', 'x-from', 'x-to'].forEach((i) => $(i).addEventListener('change', onScope));
  updateCount();

  const addPartRow = (ul, name, blob, extra = '') => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="x-pname">${esc(name)}</span><span class="muted">${fmtBytes(blob.size)}${extra ? ' · ' + esc(extra) : ''}</span>`;
    const dl = document.createElement('button'); dl.className = 'btn'; dl.textContent = 'Descargar';
    dl.onclick = () => download(name, blob);
    li.append(dl);
    if (canShare(blob, name)) {
      const sh = document.createElement('button'); sh.className = 'btn'; sh.textContent = 'Compartir';
      sh.onclick = async () => {
        try { await navigator.share({ files: [new File([blob], name, { type: 'application/zip' })], title: name }); } catch (e) { if (e && e.name !== 'AbortError') reportError(e); }
      };
      li.append(sh);
    } else if (!ul.parentElement.querySelector('.x-sharehelp')) {
      // Android Chrome cannot share .zip files from a web app: explain the two-step path once.
      const p = document.createElement('p');
      p.className = 'muted small x-sharehelp';
      p.innerHTML = 'Este teléfono no permite compartir ZIP directo desde la app. Toca <strong>Descargar</strong> y luego, en WhatsApp, Teams u Outlook: <strong>Adjuntar → Documento → Descargas</strong>. En Drive: <strong>+ → Subir</strong>.';
      ul.after(p);
    }
    ul.append(li);
  };

  const failText = (e) => (isMemoryError(e)
    ? 'No hay memoria o espacio suficiente para generar el archivo. Elige un tamaño máximo por parte más chico (200 MB), exporta un edificio o un rango de fechas menor, y cierra otras pestañas.'
    : 'Error al exportar: ' + (e && e.message ? e.message : e));

  // ---- export ZIP
  $('x-go').onclick = async () => {
    if (busy) return;
    $('x-parts').innerHTML = ''; say('x-msg', '', '');
    const scope = currentScope();
    if (scope.type === 'building' && !scope.building_code) { say('x-msg', 'bad', 'Elige un edificio.'); return; }
    if (scope.type === 'dates' && scope.from && scope.to && scope.from > scope.to) { say('x-msg', 'bad', 'La fecha "Desde" es posterior a "Hasta".'); return; }
    setBusy(true);
    $('x-prog').hidden = false;
    const bar = $('x-bar');
    let nParts = 0;
    try {
      const r = await exportForAI(h, {
        scope, maxPartBytes: Number($('x-max').value) * 1048576,
        onProgress: (d, t, label) => { bar.max = t; bar.value = d; $('x-ptext').textContent = d >= t ? `Registro ${t} de ${t}` : `Registro ${Math.min(d + 1, t)} de ${t} · ${label}`; },
        onPart: (p) => { nParts++; addPartRow($('x-parts'), p.name, p.blob, `${p.nAssets} activo${p.nAssets === 1 ? '' : 's'}${p.nBuildings ? ` + ${p.nBuildings} edificio${p.nBuildings === 1 ? '' : 's'}` : ''} · parte ${p.n} de ${p.total}`); }
      });
      if (!r.parts) say('x-msg', 'muted', 'No hay activos ni edificios que coincidan con el alcance elegido.');
      else {
        bar.value = bar.max;
        say('x-msg', 'ok', `Listo: ${r.assets} activo${r.assets === 1 ? '' : 's'}${r.buildings ? ` y ${r.buildings} edificio${r.buildings === 1 ? '' : 's'}` : ''} en ${r.parts} parte${r.parts === 1 ? '' : 's'}. Descarga o comparte cada parte (se marcaron como exportados).`);
      }
    } catch (e) {
      console.error(e);
      say('x-msg', 'bad', failText(e) + (nParts ? ` Las ${nParts} parte(s) anteriores quedaron listas abajo.` : ''));
    } finally {
      setBusy(false);
      await refreshStats().catch(() => {});
    }
  };

  // ---- progress report
  const pdfBtn = async (download) => {
    if (busy) return;
    setBusy(true); say('x-pmsg', 'muted', 'Generando reporte…');
    try {
      const { shareReport } = await import('./report.js');
      const how = await shareReport(h, { download });
      say('x-pmsg', 'ok', how === 'shared' ? 'Reporte compartido ✓' : how === 'cancelled' ? '' : 'Reporte descargado ✓ (revisa Descargas)');
    } catch (e) { console.error(e); say('x-pmsg', 'bad', 'No se pudo generar el reporte: ' + (e && e.message ? e.message : e)); } finally { setBusy(false); }
  };
  $('x-pdf').onclick = () => pdfBtn(false);
  $('x-pdfdl').onclick = () => pdfBtn(true);

  // ---- backup
  const bprog = (d, t, label) => { $('x-bprog').hidden = false; $('x-bbar').max = Math.max(t, 1); $('x-bbar').value = d; $('x-bptext').textContent = `${label}: activo ${Math.min(d + 1, t)} de ${t}`; };
  $('x-backup').onclick = async () => {
    if (busy) return;
    setBusy(true); $('x-bparts').innerHTML = ''; say('x-bmsg', '', '');
    try {
      const r = await exportBackup(h, bprog);
      say('x-bmsg', 'ok', `Respaldo listo (${r.nAssets} activos).`);
      addPartRow($('x-bparts'), r.name, r.blob);
    } catch (e) { console.error(e); say('x-bmsg', 'bad', failText(e)); } finally { setBusy(false); }
  };
  $('x-restore').onclick = () => { if (!busy) { $('x-file').value = ''; $('x-file').click(); } };
  $('x-file').onchange = async () => {
    const f = $('x-file').files[0];
    if (!f || busy) return;
    if (!(await confirmDlg('Restaurar respaldo', `<p>Se fusionará <strong>${esc(f.name)}</strong> (${fmtBytes(f.size)}) con los datos de este dispositivo. Un respaldo de la versión anterior (sin proyectos) se carga en el proyecto activo. Si un activo ya existe se conserva la versión más reciente. No se cambia el ID de este dispositivo.</p>`, 'Restaurar'))) return;
    setBusy(true); say('x-bmsg', '', '');
    try {
      const r = await importBackup(f, h, bprog);
      $('x-bprog').hidden = true;
      await h.refreshProject();
      const lines = [`Activos restaurados: ${r.assets}`, `Activos omitidos (ya tenías una versión igual o más reciente): ${r.skipped}`, `Proyectos agregados: ${r.projects}`, `Edificios agregados: ${r.buildings}`, `Departamentos agregados: ${r.departments}`, `Ajustes restaurados: ${r.settings}`];
      say('x-bmsg', r.errors.length ? 'bad' : 'ok', lines.join(' · '));
      if (r.errors.length) await ask('Restauración con avisos', `<p>${lines.map(esc).join('<br>')}</p><p class="bad">Problemas:</p><ul>${r.errors.slice(0, 30).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, [{ label: 'Cerrar', value: null, cls: 'primary' }]);
    } catch (e) { console.error(e); say('x-bmsg', 'bad', e && e.message ? e.message : String(e)); } finally {
      setBusy(false);
      await refreshStats().catch(() => {});
    }
  };

  // ---- delete exported
  $('x-del').onclick = async () => {
    if (busy) return;
    setBusy(true); say('x-dmsg', '', '');
    try {
      const targets = (await getSavedAssets(pid)).filter((a) => a.exported_at && !isPending(a));
      if (!targets.length) { say('x-dmsg', 'muted', 'No hay activos exportados para borrar.'); return; }
      const ok1 = await confirmDlg('Borrar activos exportados', `<p>Se borrarán <strong>${targets.length}</strong> activo${targets.length === 1 ? '' : 's'} ya exportado${targets.length === 1 ? '' : 's'} de este dispositivo, con sus fotos y audios.</p><p class="muted">Los activos editados después de exportar o sin exportar no se tocan.</p>`, 'Continuar', 'danger');
      if (!ok1) return;
      const ok2 = await confirmDlg('Última confirmación', `<p class="bad"><strong>Esto es irreversible.</strong> Se eliminarán de forma permanente ${targets.length} activo${targets.length === 1 ? '' : 's'} con todas sus fotos y audios. Asegúrate de haber descargado o compartido los ZIP exportados.</p>`, 'Sí, borrar definitivamente', 'danger');
      if (!ok2) return;
      let n = 0;
      for (const a of targets) {
        // Re-check right before deleting: skip if edited meanwhile.
        const cur = await db.get('assets', a.id);
        if (!cur || !cur.exported_at || isPending(cur)) continue;
        await deleteAsset(a.id); n++;
      }
      say('x-dmsg', 'ok', `Se borraron ${n} activo${n === 1 ? '' : 's'}.`);
    } catch (e) { console.error(e); say('x-dmsg', 'bad', 'No se pudo borrar: ' + (e && e.message ? e.message : e)); } finally {
      setBusy(false);
      await refreshStats().catch(() => {});
    }
  };
}
