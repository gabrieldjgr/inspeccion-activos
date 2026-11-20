import { APP_VERSION } from './version.js';
import * as db from './db.js';
import { parseBuildingsCsv, buildingsToCsv } from './csv.js';
import * as assetsUi from './assets.js';
import { recoverOrphanAudio } from './audio.js';
import * as projects from './projects.js';
import { runMigrationGate } from './migrate.js';

const $app = document.getElementById('app');
const $banners = document.getElementById('banners');
const $dlg = document.getElementById('dlg');
const state = { deviceId: null, persisted: null, project: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

function showBanner(id, kind, html, actions = []) {
  document.getElementById('banner-' + id)?.remove();
  const el = document.createElement('div');
  el.id = 'banner-' + id; el.className = 'banner ' + kind; el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${html}</span>`;
  for (const a of actions) {
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = a.label; b.onclick = a.onClick; el.append(b);
  }
  $banners.append(el);
}
const hideBanner = (id) => document.getElementById('banner-' + id)?.remove();

// Custom dialog: buttons = [{label, value, cls}], resolves with the chosen value (null if dismissed).
function ask(title, bodyHtml, buttons) {
  return new Promise((resolve) => {
    $dlg.innerHTML = `<h2 style="margin-top:0">${esc(title)}</h2><div class="scroll">${bodyHtml}</div><div class="actions"></div>`;
    const actions = $dlg.querySelector('.actions');
    let result = null;
    for (const b of buttons) {
      const el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = () => { result = b.value; $dlg.close(); };
      actions.append(el);
    }
    $dlg.onclose = () => resolve(result);
    $dlg.showModal();
  });
}
const confirmDlg = (title, body, yes = 'Aceptar', cls = 'primary') => ask(title, body, [{ label: yes, value: true, cls }, { label: 'Cancelar', value: false }]);

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- router (hash based: works on GitHub Pages with refresh) ----------
const routes = {
  '': () => assetsUi.viewHome(h),
  nuevo: () => assetsUi.viewAssetForm(h, null),
  activo: (p) => assetsUi.viewAssetForm(h, p.get('id')),
  departamentos: () => assetsUi.viewDepartments(h),
  exportar: async () => (await import('./export.js')).viewExport($app, h),
  proyectos: () => projects.viewProjects(h),
  edificios: viewBuildings, ajustes: viewSettings, ayuda: viewHelp
};
const NO_PROJECT_OK = new Set(['proyectos', 'ajustes', 'ayuda']);
// Renders are serialized: if the hash changes while a (slow) view is still loading, render again afterwards
// so a late view never overwrites the one the user navigated to.
let rendering = null; let renderAgain = false;
async function render() {
  if (rendering) { renderAgain = true; return rendering; }
  rendering = (async () => { do { renderAgain = false; await renderOnce(); } while (renderAgain); })();
  try { await rendering; } finally { rendering = null; }
}
async function renderOnce() {
  assetsUi.leave();
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  let route = path || '';
  if (!state.project && !NO_PROJECT_OK.has(route)) route = 'proyectos'; // everything else needs an active project
  document.body.dataset.route = route;
  document.querySelectorAll('.topnav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  try { await (routes[route] || routes[''])(new URLSearchParams(query)); } catch (e) { reportError(e); }
  $app.focus({ preventScroll: true });
}
window.addEventListener('hashchange', render);
const navigate = (hash) => { if (location.hash === hash || (hash === '#/' && !location.hash)) render(); else location.hash = hash; };

function reportError(e) {
  console.error(e);
  showBanner('err', 'error', 'Error: ' + esc(e && e.message ? e.message : e), [{ label: 'Cerrar', onClick: () => hideBanner('err') }]);
}

// ---------- storage ----------
async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try { if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted(); } catch (_) { /* ignore */ }
  try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); info.usage = e.usage; info.quota = e.quota; } } catch (_) { /* ignore */ }
  return info;
}
async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch (_) { /* ignore */ }
  return false;
}
function storageHtml(i) {
  const p = i.persisted === null ? 'No disponible en este navegador' : i.persisted ? '<span class="ok">Sí ✓ (los datos no se borrarán solos)</span>' : '<span class="bad">No concedido (el navegador podría borrar datos si falta espacio)</span>';
  let usage = 'No disponible';
  if (i.usage != null && i.quota) {
    const pct = Math.min(100, (i.usage / i.quota) * 100);
    usage = `${fmtBytes(i.usage)} de ${fmtBytes(i.quota)} (${pct.toFixed(1)} %)<div class="bar"><i style="width:${pct}%"></i></div>`;
  }
  return `<dl class="kv"><dt>Almacenamiento persistente</dt><dd>${p}</dd><dt>Espacio usado</dt><dd>${usage}</dd></dl>`;
}

// Re-read the active project (after creating, switching, editing or archiving) and repaint the header chip.
async function refreshProject() {
  state.project = await projects.getActiveProject();
  paintProjectChip();
  return state.project;
}
function paintProjectChip() {
  const el = document.getElementById('proj-chip');
  if (!el) return;
  const p = state.project;
  el.innerHTML = p ? `<small>Proyecto</small><strong>${esc(p.name)}</strong>` : '<small>Proyecto</small><strong>Elegir proyecto</strong>';
  el.classList.toggle('none', !p);
}

const h = { $app, $dlg, state, esc, ask, confirmDlg, showBanner, hideBanner, reportError, download, fmtBytes, storageInfo, storageHtml, navigate, refreshProject, requestPersistence };

// ---------- views ----------
async function viewSettings() {
  const [inspector, quality, gps, info] = await Promise.all([db.getSetting('inspector', ''), db.getSetting('photo_quality', 'alta'), db.getSetting('gps_enabled', false), storageInfo()]);
  $app.innerHTML = `
    <h1>Ajustes</h1>
    <div class="card">
      <label for="inspector">Nombre del inspector</label>
      <input id="inspector" type="text" autocomplete="name" value="${esc(inspector)}" placeholder="Ej.: Gabriel García">
      <p class="muted">Se agregará automáticamente a cada registro.</p>
      <label for="quality">Calidad de fotos</label>
      <select id="quality">
        <option value="alta"${quality === 'alta' ? ' selected' : ''}>Alta (2560 px, JPEG 0,90) — recomendado</option>
        <option value="original"${quality === 'original' ? ' selected' : ''}>Original (sin recomprimir)</option>
      </select>
      <label class="switch"><input id="gps" type="checkbox"${gps ? ' checked' : ''}> Guardar ubicación GPS en cada activo</label>
      <p id="saved" class="ok" role="status"></p>
    </div>
    <div class="card" id="storage">
      <h2 style="margin-top:0">Almacenamiento</h2>
      ${storageHtml(info)}
      <button class="btn" id="persist"${info.persisted ? ' hidden' : ''}>Solicitar almacenamiento persistente</button>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Acerca de</h2>
      <dl class="kv"><dt>Versión</dt><dd>${esc(APP_VERSION)}</dd><dt>ID de dispositivo</dt><dd>${esc(state.deviceId)}</dd></dl>
      <p><button class="btn" id="check-update">Buscar actualización</button></p>
      <p><a href="#/proyectos">Administrar proyectos →</a></p>
      <p><a href="#/edificios">Administrar edificios →</a></p>
      <p><a href="#/departamentos">Administrar departamentos →</a></p>
    </div>`;
  const flash = () => { const s = document.getElementById('saved'); s.textContent = 'Guardado ✓'; clearTimeout(flash.t); flash.t = setTimeout(() => (s.textContent = ''), 1500); };
  const save = async (k, v) => { try { await db.setSetting(k, v); flash(); } catch (e) { reportError(e); } };
  const $in = document.getElementById('inspector');
  $in.addEventListener('input', () => save('inspector', $in.value.trim()));
  document.getElementById('quality').addEventListener('change', (e) => save('photo_quality', e.target.value));
  document.getElementById('gps').addEventListener('change', (e) => save('gps_enabled', e.target.checked));
  document.getElementById('persist').addEventListener('click', async () => { await requestPersistence(); viewSettings(); });
  document.getElementById('check-update').addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return showBanner('upd-none', 'warn', 'El service worker no está activo (¿primera carga o sin HTTPS?).', [{ label: 'Cerrar', onClick: () => hideBanner('upd-none') }]);
    await reg.update().catch(() => {});
    if (!reg.waiting && !reg.installing) showBanner('upd-none', 'info', 'Ya tienes la última versión.', [{ label: 'OK', onClick: () => hideBanner('upd-none') }]);
  });
}

const byCode = (a, b) => a.code.localeCompare(b.code, 'es', { numeric: true });
const projectBuildings = async () => (await db.getByProject('buildings', state.project.id)).sort(byCode);

async function viewBuildings() {
  const rows = await projectBuildings();
  $app.innerHTML = `
    <h1>Edificios <span class="muted h1-sub">${esc(state.project.name)}</span></h1>
    <div class="card">
      <p class="muted">CSV con exactamente 2 columnas: <code>BLDG #</code> y <code>BLDG NAME</code> (separador , o ;).</p>
      <div class="row">
        <button class="btn primary" id="import">Importar CSV</button>
        <button class="btn" id="add">+ Agregar</button>
        <button class="btn" id="export"${rows.length ? '' : ' disabled'}>Exportar CSV</button>
      </div>
      <input id="file" class="sr" type="file" accept=".csv,text/csv,text/plain" tabindex="-1">
    </div>
    <div class="card">
      <strong>${rows.length} edificio${rows.length === 1 ? '' : 's'}</strong>
      ${rows.length ? `<ul class="list">${rows.map((r) => `<li><span class="code">${esc(r.code)}</span><span class="name">${esc(r.name)}</span><button class="btn" data-edit="${esc(r.id)}">Editar</button></li>`).join('')}</ul>` : '<p class="muted">Aún no hay edificios. Importa un CSV o agrega uno.</p>'}
    </div>`;
  const $file = document.getElementById('file');
  document.getElementById('import').onclick = () => { $file.value = ''; $file.click(); };
  $file.onchange = () => importCsv($file.files[0]);
  document.getElementById('add').onclick = () => editBuilding(null);
  document.getElementById('export').onclick = () => download('edificios.csv', new Blob([buildingsToCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  $app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editBuilding(rows.find((r) => r.id === b.dataset.edit))));
}

async function importCsv(file) {
  if (!file) return;
  try {
    const res = parseBuildingsCsv(await file.arrayBuffer());
    if (res.errors.length && !res.rows.length) {
      await ask('No se pudo importar', `<ul>${res.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`, [{ label: 'Cerrar', value: null, cls: 'primary' }]);
      return;
    }
    const existing = await projectBuildings();
    let body = `<p>Se leyeron <strong>${res.rows.length}</strong> edificios${res.encoding === 'windows-1252' ? ' (archivo en codificación ANSI/Windows-1252)' : ''}.</p>`;
    if (res.duplicates.length) body += `<p class="bad">Códigos BLDG # duplicados (se conservó la primera aparición): ${res.duplicates.map((d) => `${esc(d.code)} (fila ${d.line})`).join(', ')}.</p>`;
    if (res.errors.length) body += `<p class="bad">Filas omitidas:</p><ul>${res.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    if (existing.length) body += `<p>Ya tienes ${existing.length} edificios guardados. <strong>Reemplazar</strong> borra la lista actual; <strong>Fusionar</strong> agrega los nuevos y actualiza los nombres de los códigos que coincidan.</p>`;
    const buttons = existing.length
      ? [{ label: 'Reemplazar lista', value: 'replace', cls: 'danger' }, { label: 'Fusionar', value: 'merge', cls: 'primary' }, { label: 'Cancelar', value: null }]
      : [{ label: 'Importar', value: 'replace', cls: 'primary' }, { label: 'Cancelar', value: null }];
    const choice = await ask('Importar edificios', body, buttons);
    if (!choice) return;
    const pid = state.project.id;
    const now = db.nowIso();
    const fresh = (r) => ({ id: crypto.randomUUID(), project_id: pid, code: r.code, code_key: db.normKey(r.code), name: r.name, source: 'import', created_at: now, updated_at: now });
    if (choice === 'merge') {
      // Match existing codes case-insensitively so "b-01" updates "B-01" instead of creating a twin.
      const byKey = new Map(existing.map((e) => [e.code_key, e]));
      await db.putMany('buildings', res.rows.map((r) => { const e = byKey.get(db.normKey(r.code)); return e ? { ...e, name: r.name, updated_at: now } : fresh(r); }));
    } else {
      await db.deleteByProject('buildings', pid);
      await db.putMany('buildings', res.rows.map(fresh));
    }
    showBanner('imp', 'info', 'Edificios importados ✓', [{ label: 'OK', onClick: () => hideBanner('imp') }]);
    await viewBuildings();
  } catch (e) { reportError(e); }
}

async function editBuilding(b) {
  const isNew = !b;
  $dlg.innerHTML = `<h2 style="margin-top:0">${isNew ? 'Agregar edificio' : 'Editar edificio'}</h2>
    <label for="b-code">BLDG #</label><input id="b-code" type="text" value="${esc(b?.code ?? '')}"${isNew ? '' : ' readonly'} autocapitalize="characters">
    <label for="b-name">BLDG NAME</label><input id="b-name" type="text" value="${esc(b?.name ?? '')}">
    <p id="b-err" class="bad" role="alert"></p>
    <div class="actions"><button class="btn primary" id="b-save">Guardar</button>${isNew ? '' : '<button class="btn danger" id="b-del">Borrar edificio</button>'}<button class="btn" id="b-cancel">Cancelar</button></div>`;
  $dlg.onclose = null;
  $dlg.showModal();
  document.getElementById('b-cancel').onclick = () => $dlg.close();
  document.getElementById('b-save').onclick = async () => {
    const code = db.cleanText(document.getElementById('b-code').value);
    const name = db.cleanText(document.getElementById('b-name').value);
    const err = document.getElementById('b-err');
    if (!code || !name) { err.textContent = 'Completa ambos campos.'; return; }
    try {
      const now = db.nowIso();
      if (isNew) {
        const all = await projectBuildings();
        if (all.some((x) => x.code_key === db.normKey(code))) { err.textContent = 'Ya existe un edificio con ese BLDG # en este proyecto.'; return; }
        await db.put('buildings', { id: crypto.randomUUID(), project_id: state.project.id, code, code_key: db.normKey(code), name, source: 'manual', created_at: now, updated_at: now });
      } else {
        await db.put('buildings', { ...b, name, updated_at: now });
      }
      $dlg.close(); await viewBuildings();
    } catch (e) { err.textContent = 'Error: ' + e.message; }
  };
  const del = document.getElementById('b-del');
  if (del) del.onclick = async () => {
    $dlg.close();
    if (await confirmDlg('Borrar edificio', `<p>¿Borrar <strong>${esc(b.code)}</strong> (${esc(b.name)})? Los activos ya registrados conservan su copia del nombre.</p>`, 'Borrar', 'danger')) {
      try { await db.del('buildings', b.id); await viewBuildings(); } catch (e) { reportError(e); }
    }
  };
}

function viewHelp() {
  $app.innerHTML = `
    <h1>Ayuda</h1>
    <div class="card"><h2 style="margin-top:0">Instalar en Android (Chrome)</h2>
      <ol><li>Abre la dirección de la app en Chrome <strong>con internet</strong> (una sola vez).</li><li>Menú ⋮ → <strong>Instalar app</strong> / Añadir a pantalla de inicio.</li><li>Ábrela desde el ícono. Prueba en modo avión.</li></ol></div>
    <div class="card"><h2 style="margin-top:0">Instalar en iPhone (Safari)</h2>
      <ol><li>Abre la dirección en Safari.</li><li>Compartir → <strong>Añadir a pantalla de inicio</strong>.</li><li>Abre siempre desde el ícono (iOS 16.4 o superior). El almacenamiento en iOS es más restrictivo: exporta con frecuencia.</li></ol></div>
    <div class="card"><h2 style="margin-top:0">Proyectos</h2><p class="muted">Cada proyecto (cliente o planta) tiene sus propios edificios, departamentos, activos y exportaciones. El proyecto activo se ve siempre arriba; tócalo para cambiarlo. Para que varios valuadores trabajen en el mismo proyecto, uno lo crea y comparte el <strong>paquete de proyecto</strong>; cada uno usa su propio código de valuador.</p></div>
    <div class="card"><h2 style="margin-top:0">Exportar</h2><p class="muted">Menú <a href="#/exportar">Exportar</a>: genera ZIP por lotes para procesar en escritorio, y un respaldo completo.</p></div>`;
}

// ---------- service worker ----------
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) { showBanner('sw', 'warn', 'Este navegador no soporta modo offline (service worker).'); return; }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  const offerUpdate = (reg) => showBanner('update', 'info', 'Hay una nueva versión.', [{ label: 'Actualizar', onClick: () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' }) }]);
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(reg); });
    });
  }).catch((e) => showBanner('sw', 'error', 'No se pudo activar el modo offline: ' + esc(e.message)));
}

// ---------- boot ----------
async function boot() {
  db.onDbEvent('error', (e) => showBanner('db', 'error', 'Base de datos: ' + esc(e.message), [{ label: 'Recargar', onClick: () => location.reload() }]));
  db.onDbEvent('versionchange', () => showBanner('db', 'warn', 'La app se actualizó en otra pestaña. Recarga para continuar.', [{ label: 'Recargar', onClick: () => location.reload() }]));
  setupServiceWorker();
  try {
    const migrated = await runMigrationGate(h); // v1 data: offers a backup, then upgrades the DB
    state.deviceId = await db.ensureDeviceId();
    await refreshProject();
    if (migrated) showBanner('migr', 'info', `Tus datos se movieron al proyecto “${esc(state.project?.name || 'Proyecto 1')}”. Cámbiale el nombre y define tu código de valuador.`, [{ label: 'Editar proyecto', onClick: () => { hideBanner('migr'); navigate('#/proyectos'); } }, { label: 'OK', onClick: () => hideBanner('migr') }]);
    state.persisted = await requestPersistence();
    try { const n = await recoverOrphanAudio(); if (n) showBanner('audio-rec', 'info', `Se recuperaron ${n} nota(s) de voz de una grabación interrumpida.`, [{ label: 'OK', onClick: () => hideBanner('audio-rec') }]); } catch (e) { console.error(e); }
    let dismissed = false; try { dismissed = localStorage.getItem('persist_dismissed') === '1'; } catch (_) { /* ignore */ }
    if (!state.persisted && !dismissed) showBanner('persist', 'warn', 'Sin almacenamiento persistente: exporta con frecuencia.', [{ label: 'OK', onClick: () => { hideBanner('persist'); try { localStorage.setItem('persist_dismissed', '1'); } catch (_) { /* ignore */ } } }]);
  } catch (e) {
    showBanner('db', 'error', 'No se puede usar el almacenamiento local: ' + esc(e.message) + ' La app no puede guardar datos en este modo (¿navegación privada?).');
  }
  await render();
}
boot();
