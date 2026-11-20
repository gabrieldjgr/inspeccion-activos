// Projects (v0.3): data helpers, active project, project package (share setup between valuers) and views.
import * as db from './db.js';
import { APP_VERSION } from './version.js';
import { nowIso } from './data.js';

export const PACKAGE_FORMAT = 'inspeccion-activos/proyecto';
export const UNITS = { imperial: 'Imperial (ft, ft²)', metric: 'Métrico (m, m²)' };
export const VALUER_RE = /^[A-Z]{2,3}$/;

// ---------------------------------------------------------------- data

export const listProjects = async () => (await db.getAll('projects')).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
export const getProject = (id) => db.get('projects', id);

export async function getActiveProject() {
  const id = await db.getSetting('active_project', null);
  if (!id) return null;
  const p = await getProject(id);
  return p && p.status === 'active' ? p : null;
}
export const setActiveProject = (id) => db.setSetting('active_project', id || null);

export function cleanValuerCode(s) { return String(s ?? '').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3); }

// Suggest initials from the inspector name ("Gabriel García" -> "GG").
export function suggestValuerCode(name) {
  const parts = String(name || '').normalize('NFD').replace(/[^A-Za-z\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0] + (parts[2] ? parts[2][0] : '')).toUpperCase().slice(0, 3);
}

export function validateProject(f) {
  const errors = [];
  if (!db.cleanText(f.name)) errors.push('Escribe el nombre del proyecto.');
  if (!UNITS[f.units]) errors.push('Elige el sistema de unidades.');
  if (f.valuer_code && !VALUER_RE.test(f.valuer_code)) errors.push('El código de valuador debe tener 2 o 3 letras (A–Z).');
  return errors;
}

export async function createProject(f, { id } = {}) {
  const now = nowIso();
  const p = {
    schema_version: 1, id: id || crypto.randomUUID(), name: db.cleanText(f.name), client: db.cleanText(f.client), site: db.cleanText(f.site),
    units: f.units || 'imperial', valuer_code: f.valuer_code || '', status: 'active', created_at: now, updated_at: now, last_context: null
  };
  await db.put('projects', p);
  return p;
}

export async function updateProject(id, patch) {
  return db.tx('projects', 'readwrite', async (s) => {
    const cur = await db.wrap(s.get(id));
    if (!cur) throw new Error('El proyecto ya no existe.');
    const next = { ...cur, ...patch, updated_at: nowIso() };
    s.put(next);
    return next;
  });
}

export async function projectStats(id) {
  const [nBuildings, assets] = await Promise.all([db.countByProject('buildings', id), db.getByProject('assets', id)]);
  const saved = assets.filter((a) => a.status === 'saved');
  return { nBuildings, nAssets: saved.length, nDrafts: assets.length - saved.length };
}

const slug = (s) => String(s || 'proyecto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'proyecto';
export const projectSlug = (p) => slug(p?.name);

// ---- project package: setup shared between valuers (no photos, no assets, no valuer code) ----
export async function buildPackage(id) {
  const p = await getProject(id);
  if (!p) throw new Error('El proyecto no existe.');
  const [buildings, departments, lists] = await Promise.all([db.getByProject('buildings', id), db.getByProject('departments', id), db.getByProject('lists', id)]);
  const { valuer_code: _v, last_context: _c, status: _s, ...project } = p;
  const doc = {
    format: PACKAGE_FORMAT, schema_version: 1, app_version: APP_VERSION, exported_at: nowIso(), project,
    buildings: buildings.map(({ project_id: _p, ...b }) => b),
    departments: departments.map(({ project_id: _p, id: _i, ...d }) => d),
    lists: lists.map(({ project_id: _p, ...l }) => l)
  };
  return { blob: new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), name: `proyecto_${slug(p.name)}.json` };
}

export function parsePackage(text) {
  let doc;
  try { doc = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { throw new Error('El archivo no es un paquete de proyecto válido (JSON dañado).'); }
  if (!doc || doc.format !== PACKAGE_FORMAT) throw new Error('El archivo no es un paquete de proyecto de esta app.');
  if (doc.schema_version !== 1) throw new Error('Versión de paquete no compatible (' + doc.schema_version + '). Actualiza la app.');
  if (!doc.project || !doc.project.id || !db.cleanText(doc.project.name)) throw new Error('El paquete no trae los datos del proyecto.');
  return doc;
}

// Merge a package: creates the project (same id) or adds what is missing. Never overwrites local data.
export async function importPackage(doc) {
  const res = { created: false, project: null, buildings: 0, departments: 0, lists: 0, skipped: [] };
  const pid = doc.project.id;
  let p = await getProject(pid);
  if (!p) {
    p = await createProject({ name: doc.project.name, client: doc.project.client, site: doc.project.site, units: UNITS[doc.project.units] ? doc.project.units : 'imperial', valuer_code: '' }, { id: pid });
    res.created = true;
  }
  const now = nowIso();
  const [haveB, haveD, haveL] = await Promise.all([db.getByProject('buildings', pid), db.getByProject('departments', pid), db.getByProject('lists', pid)]);
  const byKey = new Set(haveB.map((b) => b.code_key)); const byId = new Set(haveB.map((b) => b.id));
  const newB = [];
  for (const b of doc.buildings || []) {
    const code = db.cleanText(b?.code); const key = db.normKey(code);
    if (!key) continue;
    if (byId.has(b.id) || byKey.has(key)) { if (!byId.has(b.id)) res.skipped.push(code); continue; }
    byKey.add(key);
    newB.push({ ...b, id: b.id || crypto.randomUUID(), project_id: pid, code, code_key: key, name: db.cleanText(b.name), source: 'package', created_at: b.created_at || now, updated_at: now });
  }
  const dKeys = new Set(haveD.map((d) => d.key));
  const newD = (doc.departments || []).map((d) => ({ key: d?.key || db.normKey(d?.name), name: db.cleanText(d?.name) })).filter((d) => d.key && d.name && !dKeys.has(d.key))
    .map((d) => { dKeys.add(d.key); return { id: db.departmentId(pid, d.key), project_id: pid, key: d.key, name: d.name }; });
  const lIds = new Set(haveL.map((l) => l.id));
  const newL = (doc.lists || []).filter((l) => l && l.id && !lIds.has(l.id)).map((l) => ({ ...l, project_id: pid }));
  await db.tx(['buildings', 'departments', 'lists'], 'readwrite', async (st) => {
    for (const b of newB) st.buildings.put(b);
    for (const d of newD) st.departments.put(d);
    for (const l of newL) st.lists.put(l);
  });
  Object.assign(res, { project: await getProject(pid), buildings: newB.length, departments: newD.length, lists: newL.length });
  return res;
}

// ---------------------------------------------------------------- views

function formHtml(h, p, { inspector }) {
  const v = p || { name: '', client: '', site: '', units: 'imperial', valuer_code: suggestValuerCode(inspector) };
  return `
    <label for="p-name">Nombre del proyecto *</label>
    <input id="p-name" type="text" value="${h.esc(v.name)}" placeholder="Ej.: Allison Brugge" autocomplete="off">
    <label for="p-client">Cliente</label>
    <input id="p-client" type="text" value="${h.esc(v.client)}" autocomplete="off">
    <label for="p-site">Planta / ubicación</label>
    <input id="p-site" type="text" value="${h.esc(v.site)}" autocomplete="off">
    <label for="p-units">Sistema de unidades</label>
    <select id="p-units">${Object.entries(UNITS).map(([k, l]) => `<option value="${k}"${v.units === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <label for="p-valuer">Tu código de valuador (2–3 letras)</label>
    <input id="p-valuer" type="text" value="${h.esc(v.valuer_code)}" maxlength="3" autocapitalize="characters" autocomplete="off" placeholder="Ej.: GA" style="text-transform:uppercase">
    <p class="muted small">Va en el ID de cada activo (B1-<strong>GA</strong>-A001). Cada valuador del mismo proyecto debe usar un código distinto.</p>
    <p id="p-err" class="bad" role="alert"></p>`;
}
const readForm = (d) => ({
  name: d.querySelector('#p-name').value, client: d.querySelector('#p-client').value, site: d.querySelector('#p-site').value,
  units: d.querySelector('#p-units').value, valuer_code: cleanValuerCode(d.querySelector('#p-valuer').value)
});

// Create or edit a project in the dialog. Resolves with the saved project or null.
export function projectDialog(h, p) {
  return new Promise((resolve) => {
    (async () => {
      const inspector = await db.getSetting('inspector', '');
      const d = h.$dlg;
      d.innerHTML = `<h2 style="margin-top:0">${p ? 'Editar proyecto' : 'Nuevo proyecto'}</h2><div class="scroll tall">${formHtml(h, p, { inspector })}</div>
        <div class="actions"><button class="btn primary" id="p-save">${p ? 'Guardar' : 'Crear proyecto'}</button><button class="btn" id="p-cancel">Cancelar</button></div>`;
      let result = null;
      d.querySelector('#p-valuer').addEventListener('input', (e) => { const c = cleanValuerCode(e.target.value); if (c !== e.target.value) e.target.value = c; });
      d.querySelector('#p-cancel').onclick = () => d.close();
      d.querySelector('#p-save').onclick = async () => {
        const f = readForm(d);
        const errs = validateProject(f);
        if (!p && !f.valuer_code) errs.push('Escribe tu código de valuador.');
        if (errs.length) { d.querySelector('#p-err').textContent = errs.join(' '); return; }
        try {
          result = p ? await updateProject(p.id, { name: db.cleanText(f.name), client: db.cleanText(f.client), site: db.cleanText(f.site), units: f.units, valuer_code: f.valuer_code }) : await createProject(f);
          d.close();
        } catch (e) { d.querySelector('#p-err').textContent = 'Error: ' + e.message; }
      };
      d.onclose = () => resolve(result);
      d.showModal();
      d.querySelector('#p-name').focus();
    })().catch((e) => { h.reportError(e); resolve(null); });
  });
}

async function shareOrDownload(h, blob, name) {
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return 'shared'; }
  } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  h.download(name, blob);
  return 'downloaded';
}

let showArchived = false;

export async function viewProjects(h) {
  const [all, active] = await Promise.all([listProjects(), getActiveProject()]);
  const live = all.filter((p) => p.status !== 'archived');
  const archived = all.filter((p) => p.status === 'archived');
  const stats = new Map(await Promise.all(all.map(async (p) => [p.id, await projectStats(p.id)])));
  const card = (p) => {
    const s = stats.get(p.id);
    const isActive = active && active.id === p.id;
    return `<li class="proj${isActive ? ' current' : ''}${p.status === 'archived' ? ' archived' : ''}">
      <div class="proj-head"><strong>${h.esc(p.name)}</strong>${isActive ? '<span class="chip done">activo</span>' : ''}${p.status === 'archived' ? '<span class="chip">archivado</span>' : ''}</div>
      <div class="muted">${h.esc([p.client, p.site].filter(Boolean).join(' · ') || 'Sin cliente ni ubicación')}</div>
      <div class="chips"><span class="chip">🏢 ${s.nBuildings} edificios</span><span class="chip">📦 ${s.nAssets} activos</span>${s.nDrafts ? `<span class="chip pending">${s.nDrafts} borrador${s.nDrafts === 1 ? '' : 'es'}</span>` : ''}<span class="chip">${p.units === 'metric' ? 'm²' : 'ft²'}</span><span class="chip">${p.valuer_code ? 'Valuador ' + h.esc(p.valuer_code) : '⚠ sin código de valuador'}</span></div>
      <div class="row proj-actions">
        ${p.status === 'archived'
          ? `<button class="btn" data-act="unarchive" data-id="${h.esc(p.id)}">Reactivar</button>`
          : `${isActive ? '' : `<button class="btn primary" data-act="use" data-id="${h.esc(p.id)}">Usar este proyecto</button>`}
             <button class="btn" data-act="edit" data-id="${h.esc(p.id)}">Editar</button>
             <button class="btn" data-act="share" data-id="${h.esc(p.id)}">Compartir paquete</button>
             <button class="btn danger" data-act="archive" data-id="${h.esc(p.id)}">Archivar</button>`}
      </div></li>`;
  };
  h.$app.innerHTML = `
    <h1>Proyectos</h1>
    ${!all.length ? `<div class="card welcome"><span class="big-emoji">🏭</span><strong>Crea tu primer proyecto</strong>
      <p class="muted">Un proyecto agrupa edificios, activos, fotos y reportes de un cliente o planta. Los datos de cada proyecto están separados.</p></div>` : ''}
    <div class="row">
      <button class="btn primary big" id="pj-new">+ Nuevo proyecto</button>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn" id="pj-import">Importar paquete de proyecto…</button></div>
    <input id="pj-file" class="sr" type="file" accept=".json,application/json,text/plain" tabindex="-1">
    ${live.length ? `<ul class="projects">${live.map(card).join('')}</ul>` : ''}
    ${archived.length ? `<button class="btn" id="pj-arch" style="width:100%">${showArchived ? '▾' : '▸'} Archivados (${archived.length})</button>
      ${showArchived ? `<ul class="projects">${archived.map(card).join('')}</ul>` : ''}` : ''}
    <div class="card"><p class="muted small"><strong>Paquete de proyecto:</strong> archivo con el proyecto, sus edificios, departamentos y listas (sin fotos ni activos). Compártelo con los demás valuadores para que todos trabajen sobre el mismo proyecto y los mismos códigos de edificio.</p></div>`;

  const $ = (s) => h.$app.querySelector(s);
  $('#pj-new').onclick = async () => {
    const p = await projectDialog(h, null);
    if (!p) return;
    await setActiveProject(p.id);
    await h.requestPersistence();
    await h.refreshProject();
    h.showBanner('proj', 'info', `Proyecto “${h.esc(p.name)}” creado y activo ✓`, [{ label: 'OK', onClick: () => h.hideBanner('proj') }]);
    h.navigate('#/');
  };
  const arch = $('#pj-arch'); if (arch) arch.onclick = () => { showArchived = !showArchived; viewProjects(h); };
  const $file = $('#pj-file');
  $('#pj-import').onclick = () => { $file.value = ''; $file.click(); };
  $file.onchange = async () => {
    const f = $file.files[0]; if (!f) return;
    try {
      const doc = parsePackage(await f.text());
      const exists = await getProject(doc.project.id);
      const ok = await h.confirmDlg('Importar paquete', `<p><strong>${h.esc(doc.project.name)}</strong>: ${(doc.buildings || []).length} edificios, ${(doc.departments || []).length} departamentos.</p>
        <p class="muted">${exists ? 'Ya tienes este proyecto: solo se agregará lo que falte (no se cambia nada de lo tuyo).' : 'Se creará el proyecto en este teléfono.'}</p>`, 'Importar');
      if (!ok) return;
      const r = await importPackage(doc);
      if (!r.project.valuer_code) {
        h.showBanner('proj', 'warn', 'Paquete importado ✓. Escribe tu código de valuador para este proyecto.', [{ label: 'OK', onClick: () => h.hideBanner('proj') }]);
        const edited = await projectDialog(h, r.project);
        if (edited) r.project = edited;
      }
      await setActiveProject(r.project.id);
      await h.refreshProject();
      const skip = r.skipped.length ? ` · ${r.skipped.length} edificio(s) omitido(s) porque ya tenías ese código: ${r.skipped.map(h.esc).join(', ')}` : '';
      h.showBanner('proj', 'info', `${r.created ? 'Proyecto creado' : 'Proyecto actualizado'}: ${r.buildings} edificios y ${r.departments} departamentos agregados${skip}.`, [{ label: 'OK', onClick: () => h.hideBanner('proj') }]);
      await viewProjects(h);
    } catch (e) { h.reportError(e); }
  };
  h.$app.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.id;
    const p = all.find((x) => x.id === id);
    try {
      if (b.dataset.act === 'use') {
        await setActiveProject(id); await h.refreshProject();
        h.showBanner('proj', 'info', `Ahora trabajas en “${h.esc(p.name)}”.`, [{ label: 'OK', onClick: () => h.hideBanner('proj') }]);
        setTimeout(() => h.hideBanner('proj'), 3000);
        h.navigate('#/');
      } else if (b.dataset.act === 'edit') {
        if (await projectDialog(h, p)) { await h.refreshProject(); await viewProjects(h); }
      } else if (b.dataset.act === 'share') {
        const pkg = await buildPackage(id);
        const how = await shareOrDownload(h, pkg.blob, pkg.name);
        if (how === 'downloaded') h.showBanner('proj', 'info', `Se descargó ${h.esc(pkg.name)}. Envíalo a los demás valuadores (WhatsApp, Teams, correo…).`, [{ label: 'OK', onClick: () => h.hideBanner('proj') }]);
      } else if (b.dataset.act === 'archive') {
        const s = stats.get(id);
        if (!(await h.confirmDlg('Archivar proyecto', `<p>¿Archivar <strong>${h.esc(p.name)}</strong>? Se oculta de la lista pero <strong>no se borra nada</strong> (${s.nAssets} activos, ${s.nBuildings} edificios). Puedes reactivarlo cuando quieras.</p>`, 'Archivar'))) return;
        await updateProject(id, { status: 'archived' });
        if (active && active.id === id) await setActiveProject(null);
        await h.refreshProject();
        await viewProjects(h);
      } else if (b.dataset.act === 'unarchive') {
        await updateProject(id, { status: 'active' });
        await viewProjects(h);
      }
    } catch (e) { h.reportError(e); }
  }));
}
