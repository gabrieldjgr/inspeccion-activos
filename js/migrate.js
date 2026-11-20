// Migration gate (v0.3): runs at boot BEFORE the DB is opened at the current version.
// If the device still has a v1 database with data, it shows a full-screen step that offers a backup made with
// the OLD schema (restorable by v0.2 too) and only then upgrades. The upgrade itself is atomic (see db.js).
import * as db from './db.js';

const NAV_HIDE = 'migrating';

async function countAll() {
  const [assets, buildings, departments, blobs] = await Promise.all(['assets', 'buildings', 'departments', 'blobs'].map((s) => db.count(s)));
  return { assets, buildings, departments, blobs };
}

// Resolves true if a migration happened (so the app can tell the user), false otherwise.
export async function runMigrationGate(h) {
  const v = await db.probeVersion();
  if (v === 0 || v >= db.DB_VERSION) { await db.openDb(); return false; }

  await db.setLegacyMode(true);
  const before = await countAll();
  if (!before.assets && !before.buildings && !before.departments) {
    await db.setLegacyMode(false); await db.openDb(); return false; // empty old DB: upgrade silently
  }
  const nPhotos = await db.tx('blobs', 'readonly', (s) => db.wrap(s.index('kind').count(IDBKeyRange.only('photo'))));
  const nAudios = await db.tx('blobs', 'readonly', (s) => db.wrap(s.index('kind').count(IDBKeyRange.only('audio'))));

  document.body.classList.add(NAV_HIDE);
  return new Promise((resolve) => {
    let backedUp = false;
    let busy = false;
    h.$app.innerHTML = `
      <h1>Actualización de datos</h1>
      <div class="card">
        <p>Esta versión organiza todo por <strong>proyectos</strong>. Tus datos actuales se moverán a un proyecto llamado <strong>“Proyecto 1”</strong> (luego le cambias el nombre). No se borra nada y las fotos y audios no se tocan.</p>
        <dl class="kv"><dt>Activos</dt><dd>${before.assets}</dd><dt>Fotos</dt><dd>${nPhotos}</dd><dt>Notas de voz</dt><dd>${nAudios}</dd><dt>Edificios</dt><dd>${before.buildings}</dd><dt>Departamentos</dt><dd>${before.departments}</dd></dl>
      </div>
      <div class="card">
        <h2 style="margin-top:0">1. Respaldo (recomendado)</h2>
        <p class="muted">Un ZIP con todo, por si algo sale mal. Guárdalo fuera del teléfono (Drive, correo, PC). Con muchas fotos puede tardar.</p>
        <button class="btn big" id="m-backup">Descargar respaldo</button>
        <div id="m-prog" class="x-prog" hidden><progress id="m-bar" value="0" max="1"></progress><div id="m-ptext" class="muted"></div></div>
        <p id="m-bmsg" role="status"></p>
      </div>
      <div class="card">
        <h2 style="margin-top:0">2. Actualizar</h2>
        <button class="btn big primary" id="m-go">Actualizar mis datos</button>
        <p id="m-msg" role="status"></p>
      </div>`;
    const $ = (id) => document.getElementById(id);
    const say = (id, cls, t) => { const el = $(id); el.className = cls; el.textContent = t; };

    $('m-backup').onclick = async () => {
      if (busy) return;
      busy = true; $('m-backup').disabled = true; $('m-go').disabled = true; say('m-bmsg', '', '');
      try {
        const { exportBackup } = await import('./export.js');
        const r = await exportBackup(h, (d, t) => { $('m-prog').hidden = false; $('m-bar').max = Math.max(t, 1); $('m-bar').value = d; $('m-ptext').textContent = `Activo ${Math.min(d + 1, t)} de ${t}`; });
        const file = new File([r.blob], r.name, { type: 'application/zip' });
        let shared = false;
        try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: r.name }); shared = true; } } catch (e) { if (e && e.name === 'AbortError') shared = false; }
        if (!shared) h.download(r.name, r.blob);
        backedUp = true;
        say('m-bmsg', 'ok', `Respaldo listo: ${r.name} (${h.fmtBytes(r.blob.size)}). ${shared ? '' : 'Revisa la carpeta Descargas.'}`);
      } catch (e) {
        console.error(e);
        say('m-bmsg', 'bad', 'No se pudo crear el respaldo: ' + (e && e.message ? e.message : e) + ' Puedes intentarlo de nuevo o continuar sin respaldo.');
      } finally { busy = false; $('m-backup').disabled = false; $('m-go').disabled = false; }
    };

    $('m-go').onclick = async () => {
      if (busy) return;
      if (!backedUp && !(await h.confirmDlg('¿Continuar sin respaldo?', '<p>La actualización es segura (si falla, tus datos quedan como estaban), pero un respaldo fuera del teléfono es la única protección si el teléfono se pierde o se daña.</p>', 'Actualizar sin respaldo', 'danger'))) return;
      busy = true; $('m-backup').disabled = true; $('m-go').disabled = true;
      say('m-msg', 'muted', 'Actualizando…');
      try {
        await db.setLegacyMode(false);
        await db.openDb(); // runs the v1 -> v2 upgrade in one transaction
        const after = await countAll();
        const orphan = await db.tx('assets', 'readonly', (s) => db.wrap(s.getAll())).then((all) => all.filter((a) => !a.project_id).length);
        if (after.assets !== before.assets || after.blobs !== before.blobs || orphan) {
          throw new Error(`Verificación: activos ${before.assets}→${after.assets}, archivos ${before.blobs}→${after.blobs}, sin proyecto ${orphan}. Los datos originales están en la copia interna; no borres la app y contacta a soporte con el respaldo.`);
        }
        document.body.classList.remove(NAV_HIDE);
        resolve(true);
      } catch (e) {
        console.error(e);
        say('m-msg', 'bad', 'No se pudo actualizar: ' + (e && e.message ? e.message : e) + ' Tus datos siguen como estaban. Cierra otras ventanas de la app y vuelve a intentar.');
        try { await db.setLegacyMode(true); } catch (_) { /* ignore */ }
        busy = false; $('m-backup').disabled = false; $('m-go').disabled = false;
      }
    };
  });
}
